import { audioProcessorCode } from './processor';
import toWav from 'audiobuffer-to-wav';
import lamejs from './lame.all.js';

export class AudioEngine {
  ctx: AudioContext;
  analyserDry: AnalyserNode;
  analyserWet: AnalyserNode;
  dryGain: GainNode;
  wetGain: GainNode;
  makeupGainNode: GainNode;
  compressor: DynamicsCompressorNode;
  masterGain: GainNode;
  lufsGainNode: GainNode;
  normalizationGain: number = 1.0;
  dryGainProxy: GainNode;
  wetGainProxy: GainNode;
  workletNode: AudioWorkletNode | null = null;
  onReduction: ((total: number, esser: number) => void) | null = null;
  deEsserFilter: BiquadFilterNode | null = null;
  lookaheadDelay: DelayNode | null = null;
  sourceNode: AudioBufferSourceNode | null = null;
  sibilanceGainNode: GainNode | null = null;
  audioBuffer: AudioBuffer | null = null;
  
  sibilancePoints: Array<{id: string, time: number, duration: number, gain: number, peak: number, width: number}> = [];

  private mixValue = 1; // 0: Dry, 1: Wet
  private isPlaying = false;
  private startOffset = 0;
  private startTime = 0;

  private isWorkletLoaded = false;
  private initPromise: Promise<void> | null = null;

  private currentParams = {
    gateThreshold: 0.02,
    gateRatio: 4,
    deEsserThreshold: 0.05,
    deEsserAmount: 0.5,
    deEsserFreq: 5000,
    compThreshold: -24,
    compRatio: 4
  };

  constructor() {
    this.ctx = new AudioContext();
    
    // Separate analysers for Dry(Red) and Wet(Blue)
    this.analyserDry = this.ctx.createAnalyser();
    this.analyserDry.fftSize = 2048;
    this.analyserDry.smoothingTimeConstant = 0.85;

    this.analyserWet = this.ctx.createAnalyser();
    this.analyserWet.fftSize = 2048;
    this.analyserWet.smoothingTimeConstant = 0.85;
    
    this.dryGain = this.ctx.createGain();
    this.wetGain = this.ctx.createGain();
    this.makeupGainNode = this.ctx.createGain();
    this.compressor = this.ctx.createDynamicsCompressor();
    this.masterGain = this.ctx.createGain();
    this.lufsGainNode = this.ctx.createGain();
    
    // Default compressor settings for mastering
    this.compressor.threshold.value = -24;
    this.compressor.knee.value = 30;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.25;

    // Connect to analysers regardless of mix (to always show both)
    // We create isolated proxy gains so the analysers always get full volume
    // even if the master speaker output is crossfaded.
    this.dryGainProxy = this.ctx.createGain();
    this.wetGainProxy = this.ctx.createGain();

    this.dryGain.connect(this.masterGain);
    this.wetGain.connect(this.makeupGainNode);
    this.makeupGainNode.connect(this.masterGain);
    
    this.masterGain.connect(this.compressor);
    this.compressor.connect(this.lufsGainNode);
    this.lufsGainNode.connect(this.ctx.destination);
    
    this.setMix(1); // default full wet
  }

  async init() {
    if (this.isWorkletLoaded) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      // Do not await ctx.resume() here as it can freeze indefinitely if called without user gesture (e.g. on mount).
      // AudioWorklet.addModule works perfectly fine even if AudioContext is suspended.
      const blob = new Blob([audioProcessorCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        await this.ctx.audioWorklet.addModule(url);
        this.isWorkletLoaded = true;
      } catch (e) {
        console.error("AudioWorklet initialization failed", e);
        throw e;
      }
    })();

    return this.initPromise;
  }

  async resumeContext() {
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  async loadAudio(file: File): Promise<AudioBuffer> {
    await this.resumeContext();
    await this.init(); // ensure init completes on user upload gesture
    const arrayBuffer = await file.arrayBuffer();
    this.audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.sibilancePoints = await this.analyzeSibilance(this.audioBuffer);
    this.normalizationGain = 1.0;
    this.lufsGainNode.gain.setValueAtTime(1.0, this.ctx.currentTime);
    return this.audioBuffer;
  }

  // Calculate Integrated LUFS (Simplified BS.1770)
  async calculateLUFS(buffer: AudioBuffer): Promise<number> {
    const sampleRate = buffer.sampleRate;
    const channels = buffer.numberOfChannels;
    
    const offlineCtx = new OfflineAudioContext(channels, buffer.length, sampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;

    // Stage 1: Pre-filter (high shelf)
    const preFilter = offlineCtx.createBiquadFilter();
    preFilter.type = 'highshelf';
    preFilter.frequency.value = 1681.97;
    preFilter.gain.value = 3.9998;
    preFilter.Q.value = 0.7071;

    // Stage 2: RLB filter (high pass)
    const rlbFilter = offlineCtx.createBiquadFilter();
    rlbFilter.type = 'highpass';
    rlbFilter.frequency.value = 38.13;
    rlbFilter.Q.value = 0.7071;

    source.connect(preFilter);
    preFilter.connect(rlbFilter);
    rlbFilter.connect(offlineCtx.destination);
    
    source.start(0);
    const filteredBuffer = await offlineCtx.startRendering();
    
    // O(N) optimized calculation
    let totalPower = 0;
    let validSamples = 0;
    const absThreshold = Math.pow(10, -70 / 10); // Absolute gating threshold (-70 LKFS)

    for (let c = 0; c < channels; c++) {
      const data = filteredBuffer.getChannelData(c);
      let channelPower = 0;
      let channelValidCount = 0;
      
      // Process in chunks to avoid blocking too long, or just use a tight loop
      // BS.1770-4 uses 400ms windows, but for a global integrated estimate,
      // a simple power sum with a low threshold is often sufficient and much faster.
      for (let i = 0; i < data.length; i++) {
        const sq = data[i] * data[i];
        if (sq > absThreshold) {
          channelPower += sq;
          channelValidCount++;
        }
      }
      
      if (channelValidCount > 0) {
        totalPower += (channelPower / channelValidCount);
        validSamples++;
      }
    }

    if (validSamples === 0) return -Infinity;

    // Mean of channel powers
    const avgPower = totalPower / validSamples;
    const lufs = -0.691 + 10 * Math.log10(Math.max(avgPower, 1e-12));
    
    return lufs;
  }

  async applyNormalization(targetLUFS: number) {
    if (!this.audioBuffer) return 0;
    const currentLUFS = await this.calculateLUFS(this.audioBuffer);
    const gainDb = targetLUFS - currentLUFS;
    const gainFactor = Math.pow(10, gainDb / 20);
    this.normalizationGain = gainFactor;
    this.lufsGainNode.gain.setTargetAtTime(gainFactor, this.ctx.currentTime, 0.1);
    return currentLUFS;
  }

  async analyzeSibilance(buffer: AudioBuffer) {
    const offlineCtx = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    
    // Create multiple bandpass filters from 4000Hz to 6500Hz in 500Hz increments
    const freqs = [4000, 4500, 5000, 5500, 6000, 6500];
    const sumNode = offlineCtx.createGain();
    // Reduce gain per filter to avoid clipping the sum
    sumNode.gain.value = 1.0 / freqs.length;

    freqs.forEach(freq => {
      const filter = offlineCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = freq;
      filter.Q.value = 2.0; // Narrower band for specific detection
      source.connect(filter);
      filter.connect(sumNode);
    });
    
    sumNode.connect(offlineCtx.destination);
    source.start(0);
    
    const hpBuffer = await offlineCtx.startRendering();
    const channelData = hpBuffer.getChannelData(0); 
    const sampleRate = hpBuffer.sampleRate;
    const windowSize = Math.floor(sampleRate * 0.01); // 10ms window for more stable RMS
    
    const points = [];
    let inSibilance = false;
    let sibilanceStart = 0;
    let peak = 0;
    const threshold = 0.00001; // Increase slightly to ignore extremely faint noise floor

    for (let i = 0; i < channelData.length; i += (windowSize / 2)) { // 50% overlap for better transient catch
      let sum = 0;
      const len = Math.min(windowSize, channelData.length - i);
      for (let j = 0; j < len; j++) {
        sum += channelData[i + j] * channelData[i + j];
      }
      const rms = Math.sqrt(sum / len);
      
      if (rms > threshold) {
        if (!inSibilance) {
          inSibilance = true;
          sibilanceStart = i;
          peak = rms;
        } else {
          if (rms > peak) peak = rms;
        }
      } else {
        if (inSibilance) {
          inSibilance = false;
          if ((i - sibilanceStart) > sampleRate * 0.005) { // Any transient over 5ms
             const time = (sibilanceStart + (i - sibilanceStart) / 2) / sampleRate;
             points.push({
               id: Math.random().toString(36).substring(2, 11),
               time: time,
               duration: (i - sibilanceStart) / sampleRate,
               peak: peak,
               gain: 1.0 
             });
          }
        }
      }
    }

    if (inSibilance && (channelData.length - sibilanceStart) > sampleRate * 0.02) {
      const i = channelData.length;
      const time = (sibilanceStart + (i - sibilanceStart) / 2) / sampleRate;
      points.push({
        id: Math.random().toString(36).substring(2, 11),
        time: time,
        duration: (i - sibilanceStart) / sampleRate,
        peak: peak,
        gain: 1.0 
      });
    }

    return points;
  }

  buildGraph() {
    if (!this.audioBuffer) return;
    if (!this.isWorkletLoaded) {
      console.error("Graph build attempted before worklet was loaded.");
      return;
    }
    
    // Stop existing source if any
    if (this.sourceNode) {
      this.sourceNode.onended = null;
      try { this.sourceNode.stop(); } catch(e) {}
      this.sourceNode.disconnect();
    }
    if (this.workletNode) this.workletNode.disconnect();
    if (this.deEsserFilter) this.deEsserFilter.disconnect();
    if (this.lookaheadDelay) this.lookaheadDelay.disconnect();
    if (this.sibilanceGainNode) this.sibilanceGainNode.disconnect();

    this.sourceNode = this.ctx.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;

    this.lookaheadDelay = this.ctx.createDelay(1.0);
    this.lookaheadDelay.delayTime.value = 0.005; // 5ms lookahead

    // Source passes through lookahead delay for phase alignment with both Dry and Wet paths
    this.sourceNode.connect(this.lookaheadDelay);

    // Direct Dry Path (Now phase aligned)
    this.lookaheadDelay.connect(this.dryGain);

    // Wet Path Processing
    this.workletNode = new AudioWorkletNode(this.ctx, 'vocal-processor', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [this.audioBuffer.numberOfChannels]
    });

    this.workletNode.port.onmessage = (e) => {
      if (e.data.type === 'reduction' && this.onReduction) {
        this.onReduction(e.data.totalReduction, e.data.esserReduction);
      }
    };

    this.workletNode.parameters.get('gateThreshold')?.setValueAtTime(this.currentParams.gateThreshold, this.ctx.currentTime);
    this.workletNode.parameters.get('gateRatio')?.setValueAtTime(this.currentParams.gateRatio, this.ctx.currentTime);
    this.workletNode.parameters.get('deEsserThreshold')?.setValueAtTime(this.currentParams.deEsserThreshold, this.ctx.currentTime);
    this.workletNode.parameters.get('deEsserAmount')?.setValueAtTime(this.currentParams.deEsserAmount, this.ctx.currentTime);

    this.deEsserFilter = this.ctx.createBiquadFilter();
    this.deEsserFilter.type = 'highpass';
    this.deEsserFilter.frequency.value = this.currentParams.deEsserFreq;

    this.sibilanceGainNode = this.ctx.createGain();

    // Crossover for manual de-essing to preserve low frequencies (vocal body)
    const crossoverLow = this.ctx.createBiquadFilter();
    crossoverLow.type = 'lowpass';
    crossoverLow.frequency.value = 4000;
    crossoverLow.Q.value = 0.5; // Linkwitz-Riley approximation

    const crossoverHigh = this.ctx.createBiquadFilter();
    crossoverHigh.type = 'highpass';
    crossoverHigh.frequency.value = 4000;
    crossoverHigh.Q.value = 0.5;

    // Routing
    // Input 0: Delayed signal (Dry audio to be processed)
    this.lookaheadDelay.connect(this.workletNode, 0, 0);
    this.lookaheadDelay.connect(this.dryGainProxy); // Send full dry to analyser
    this.dryGainProxy.connect(this.analyserDry);

    // Input 1: Sibilance detection signal (High-passed, not delayed)
    this.sourceNode.connect(this.deEsserFilter);
    this.deEsserFilter.connect(this.workletNode, 0, 1);

    // Output routing (Split Band)
    this.workletNode.connect(crossoverLow);
    this.workletNode.connect(crossoverHigh);

    // Proxy node to collect full processed signal
    const wetSum = this.ctx.createGain();

    // Low band bypasses sibilance ducking
    crossoverLow.connect(wetSum);

    // High band goes through manual sibilance ducking
    crossoverHigh.connect(this.sibilanceGainNode);
    this.sibilanceGainNode.connect(wetSum);
    
    // Distribute wetSum to speakers (via crossfader) and visualizer
    wetSum.connect(this.wetGain);
    wetSum.connect(this.wetGainProxy);
    this.wetGainProxy.connect(this.analyserWet);

    // Handle end of playback
    const currentNode = this.sourceNode;
    this.sourceNode.onended = () => {
      if (this.sourceNode === currentNode) {
        this.isPlaying = false;
      }
    };
  }

  play() {
    if (!this.audioBuffer) return;
    if (this.isPlaying) return;

    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    this.buildGraph();

    this.sourceNode!.start(0, this.startOffset);
    this.startTime = this.ctx.currentTime - this.startOffset;
    this.isPlaying = true;
    
    this.scheduleSibilanceGains(this.startOffset);
  }

  scheduleSibilanceGains(offset: number) {
    if (!this.sibilanceGainNode) return;
    const now = this.ctx.currentTime;
    
    // Cancel future points and set baseline
    this.sibilanceGainNode.gain.cancelScheduledValues(now);
    this.sibilanceGainNode.gain.setValueAtTime(this.sibilanceGainNode.gain.value, now);

    const relevantPoints = this.sibilancePoints
      .filter(pt => pt.time + (pt.width / 2) > offset)
      .sort((a, b) => a.time - b.time);
    
    let lastScheduledTime = now;

    for (const pt of relevantPoints) {
      if (pt.gain >= 0.99) continue; // Skip nodes with no effective reduction

      const scheduleTime = now + (pt.time - offset);
      const halfWidth = pt.width / 2;
      const startTime = scheduleTime - halfWidth;
      const endTime = scheduleTime + halfWidth;

      // Ensure we don't schedule in the past
      if (endTime <= now + 0.005) continue;

      try {
        // Start Ramp
        const actualStart = Math.max(lastScheduledTime + 0.002, startTime);
        if (scheduleTime > actualStart) {
          this.sibilanceGainNode.gain.linearRampToValueAtTime(1.0, actualStart);
          this.sibilanceGainNode.gain.linearRampToValueAtTime(pt.gain, scheduleTime);
          this.sibilanceGainNode.gain.linearRampToValueAtTime(1.0, endTime);
          lastScheduledTime = endTime;
        }
      } catch (e) {
        // Logically skip overlapping points that violate monotonic time
      }
    }
  }

  updateSibilancePoints(points: any[]) {
    this.sibilancePoints = points;
    if (this.isPlaying) {
      this.scheduleSibilanceGains(this.ctx.currentTime - this.startTime);
    }
  }

  pause() {
    if (this.sourceNode) {
      this.sourceNode.onended = null;
      try { this.sourceNode.stop(); } catch(e) {}
    }
    if (this.isPlaying) {
      this.startOffset = this.ctx.currentTime - this.startTime;
    }
    this.isPlaying = false;
  }

  clear() {
    this.pause();
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    this.audioBuffer = null;
    this.sibilancePoints = [];
    this.normalizationGain = 1.0;
    this.startOffset = 0;
    this.startTime = 0;
    this.isPlaying = false;
  }

  seek(time: number) {
    const wasPlaying = this.isPlaying;
    if (this.isPlaying) {
      this.pause();
    }
    this.startOffset = Math.max(0, Math.min(time, this.audioBuffer?.duration || 0));
    if (wasPlaying) {
      this.play();
    }
  }

  // Crossfade between A (Dry) and B (Wet)
  setMix(value: number) {
    this.mixValue = Math.max(0, Math.min(1, value));
    // Equal power crossfade
    this.dryGain.gain.setTargetAtTime(Math.cos(this.mixValue * 0.5 * Math.PI), this.ctx.currentTime, 0.02);
    this.wetGain.gain.setTargetAtTime(Math.cos((1.0 - this.mixValue) * 0.5 * Math.PI), this.ctx.currentTime, 0.02);
  }

  // Parameter Setters
  setGateThreshold(val: number) {
    this.currentParams.gateThreshold = val;
    if (this.workletNode) {
      const p = this.workletNode.parameters.get('gateThreshold');
      if (p) p.setTargetAtTime(val, this.ctx.currentTime, 0.02);
    }
  }

  setGateRatio(val: number) {
    this.currentParams.gateRatio = val;
    if (this.workletNode) {
      const p = this.workletNode.parameters.get('gateRatio');
      if (p) p.setTargetAtTime(val, this.ctx.currentTime, 0.02);
    }
  }

  setDeEsserThreshold(val: number) {
    this.currentParams.deEsserThreshold = val;
    if (this.workletNode) {
      const p = this.workletNode.parameters.get('deEsserThreshold');
      if (p) p.setTargetAtTime(val, this.ctx.currentTime, 0.02);
    }
  }

  setDeEsserAmount(val: number) {
    this.currentParams.deEsserAmount = val;
    if (this.workletNode) {
      const p = this.workletNode.parameters.get('deEsserAmount');
      if (p) p.setTargetAtTime(val, this.ctx.currentTime, 0.02);
    }
  }

  setDeEsserFreq(freq: number) {
    this.currentParams.deEsserFreq = freq;
    if (this.deEsserFilter) {
      this.deEsserFilter.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.02);
    }
  }

  setMakeupGain(val: number) {
    this.makeupGainNode.gain.setTargetAtTime(val, this.ctx.currentTime, 0.02);
  }

  setCompThreshold(val: number) {
    this.currentParams.compThreshold = val;
    this.compressor.threshold.setTargetAtTime(val, this.ctx.currentTime, 0.02);
  }

  setCompRatio(val: number) {
    this.currentParams.compRatio = val;
    this.compressor.ratio.setTargetAtTime(val, this.ctx.currentTime, 0.02);
  }

  async exportOffline(
    gateThresh: number, 
    gateRatio: number, 
    essThresh: number, 
    essAmt: number, 
    essFreq: number, 
    makeupGain: number,
    compThresh: number,
    compRatio: number,
    mix: number,
    format: 'wav' | 'mp3' = 'wav',
    bitrate: number = 320,
    onProgress: (p: number) => void
  ): Promise<Blob> {
    if (!this.audioBuffer) throw new Error("No audio loaded");

    const sampleRate = 44100; // Standardize export to 44.1kHz to prevent lamejs crashes
    const length = Math.ceil(this.audioBuffer.duration * sampleRate);
    const offlineCtx = new OfflineAudioContext(2, length, sampleRate);

    // Register worklet
    const blob = new Blob([audioProcessorCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await offlineCtx.audioWorklet.addModule(url);

    const offlineSource = offlineCtx.createBufferSource();
    offlineSource.buffer = this.audioBuffer;

    const workletNode = new AudioWorkletNode(offlineCtx, 'vocal-processor', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [this.audioBuffer.numberOfChannels]
    });

    workletNode.parameters.get('gateThreshold')?.setValueAtTime(gateThresh, 0);
    workletNode.parameters.get('gateRatio')?.setValueAtTime(gateRatio, 0);
    workletNode.parameters.get('deEsserThreshold')?.setValueAtTime(essThresh, 0);
    workletNode.parameters.get('deEsserAmount')?.setValueAtTime(essAmt, 0);

    const filter = offlineCtx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(essFreq, 0);

    const delay = offlineCtx.createDelay(1.0);
    delay.delayTime.setValueAtTime(0.005, 0);

    const sibilanceGainNode = offlineCtx.createGain();
    const makeupGainNode = offlineCtx.createGain();
    const dryGainNode = offlineCtx.createGain();
    const wetGainNode = offlineCtx.createGain();

    makeupGainNode.gain.setValueAtTime(makeupGain, 0);

    const crossoverLow = offlineCtx.createBiquadFilter();
    crossoverLow.type = 'lowpass';
    crossoverLow.frequency.setValueAtTime(4000, 0);
    crossoverLow.Q.setValueAtTime(0.5, 0);

    const crossoverHigh = offlineCtx.createBiquadFilter();
    crossoverHigh.type = 'highpass';
    crossoverHigh.frequency.setValueAtTime(4000, 0);
    crossoverHigh.Q.setValueAtTime(0.5, 0);

    offlineSource.connect(delay);
    delay.connect(workletNode, 0, 0);
    
    offlineSource.connect(filter);
    filter.connect(workletNode, 0, 1);

    const offlineMasterGain = offlineCtx.createGain();
    offlineMasterGain.gain.setValueAtTime(this.normalizationGain, 0);

    const offlineCompressor = offlineCtx.createDynamicsCompressor();
    offlineCompressor.threshold.setValueAtTime(compThresh, 0);
    offlineCompressor.ratio.setValueAtTime(compRatio, 0);
    offlineCompressor.knee.setValueAtTime(30, 0);
    offlineCompressor.attack.setValueAtTime(0.003, 0);
    offlineCompressor.release.setValueAtTime(0.25, 0);

    // Dry Routing
    delay.connect(dryGainNode); // Phase aligned with wet signal
    dryGainNode.connect(offlineMasterGain);

    // Wet Routing (Split Band)
    workletNode.connect(crossoverLow);
    workletNode.connect(crossoverHigh);

    // Low band untouched by manual ducking
    crossoverLow.connect(wetGainNode);
    
    // High band ducked by manual points
    crossoverHigh.connect(sibilanceGainNode);
    sibilanceGainNode.connect(wetGainNode);
    
    wetGainNode.connect(makeupGainNode);
    makeupGainNode.connect(offlineMasterGain);

    offlineMasterGain.connect(offlineCompressor);
    offlineCompressor.connect(offlineCtx.destination);
    
    // Apply Equal-Power Crossfade Mix
    const mixVal = Math.max(0, Math.min(1, mix));
    dryGainNode.gain.setValueAtTime(Math.cos(mixVal * 0.5 * Math.PI), 0);
    wetGainNode.gain.setValueAtTime(Math.cos((1.0 - mixVal) * 0.5 * Math.PI), 0);

    sibilanceGainNode.gain.setValueAtTime(1.0, 0);
    
    const sortedPoints = [...this.sibilancePoints].sort((a, b) => a.time - b.time);

    for (const pt of sortedPoints) {
      const scheduleTime = pt.time;
      const halfWidth = pt.width / 2;
      const startTime = scheduleTime - halfWidth;
      const endTime = scheduleTime + halfWidth;

      if (startTime < 0) continue;
      
      try {
        sibilanceGainNode.gain.linearRampToValueAtTime(1.0, startTime);
        sibilanceGainNode.gain.linearRampToValueAtTime(pt.gain, scheduleTime);
        sibilanceGainNode.gain.linearRampToValueAtTime(1.0, endTime);
      } catch (e) {
        console.warn("Skipping overlapping sibilance automation point in export", e);
      }
    }

    offlineSource.start(0);

    onProgress(10); // Rendering graph initialized

    // Render AudioBuffer
    const renderedBuffer = await offlineCtx.startRendering();
    onProgress(50); // Graph rendered

    if (format === 'wav') {
      const wavBuffer = toWav(renderedBuffer);
      onProgress(100);
      return new Blob([wavBuffer], { type: 'audio/wav' });
    } else if (format === 'mp3') {
      const channels = renderedBuffer.numberOfChannels;
      const mp3encoder = new (lamejs as any).Mp3Encoder(channels, sampleRate, bitrate);
      const blocks: Int8Array[] = [];
      const sampleBlockSize = 1152 * 4; // Use larger chunks for faster encoding

      const left = renderedBuffer.getChannelData(0);
      const right = channels > 1 ? renderedBuffer.getChannelData(1) : left;

      const leftInt16 = new Int16Array(left.length);
      const rightInt16 = new Int16Array(right.length);
      for (let i = 0; i < left.length; i++) {
        leftInt16[i] = left[i] < 0 ? left[i] * 32768 : left[i] * 32767;
        rightInt16[i] = right[i] < 0 ? right[i] * 32768 : right[i] * 32767;
      }

      return new Promise((resolve) => {
        let i = 0;
        const encodeChunk = () => {
          const end = Math.min(i + sampleBlockSize * 10, left.length); // Process 10 chunks at a time
          for (; i < end; i += sampleBlockSize) {
            const leftChunk = leftInt16.subarray(i, i + sampleBlockSize);
            const rightChunk = rightInt16.subarray(i, i + sampleBlockSize);
            
            const mp3buf = channels === 2 ? mp3encoder.encodeBuffer(leftChunk, rightChunk) : mp3encoder.encodeBuffer(leftChunk);
            if (mp3buf.length > 0) blocks.push(mp3buf);
          }
          
          onProgress(mathRound(50 + (i / left.length) * 45)); // up to 95%
          
          if (i < left.length) {
            setTimeout(encodeChunk, 0); // Yield to event loop
          } else {
            const mp3bufFinal = mp3encoder.flush();
            if (mp3bufFinal.length > 0) blocks.push(mp3bufFinal);
            onProgress(100);
            resolve(new Blob(blocks, { type: 'audio/mp3' }));
          }
        };
        
        encodeChunk();
      });
    }
    
    return new Blob();
  }
}

function mathRound(n: number) {
  return Math.round(n);
}
