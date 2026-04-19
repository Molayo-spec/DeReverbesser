export const audioProcessorCode = `
class VocalProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gateThreshold', defaultValue: 0.02, minValue: 0, maxValue: 1 },
      { name: 'gateRatio', defaultValue: 4, minValue: 1, maxValue: 20 },
      { name: 'deEsserThreshold', defaultValue: 0.1, minValue: 0, maxValue: 1 },
      { name: 'deEsserAmount', defaultValue: 0.5, minValue: 0, maxValue: 1 },
    ];
  }

  constructor() {
    super();
    this.envGate = [];
    this.smoothGateGain = [];
    this.envEss = [];
    this.smoothEssGain = [];
    this.lpState = [];
    
    // Calculate smoothing coefficients based on global sampleRate
    const sr = sampleRate;
    this.gateAttack = 1.0 - Math.exp(-1.0 / (0.005 * sr)); // 5ms attack
    this.gateRelease = 1.0 - Math.exp(-1.0 / (0.200 * sr)); // 200ms release for natural reverb tail fading
    
    this.essAttack = 1.0 - Math.exp(-1.0 / (0.001 * sr)); // 1ms fast attack for transients
    this.essRelease = 1.0 - Math.exp(-1.0 / (0.050 * sr)); // 50ms fast release
    
    // 1-pole Lowpass Filter for crossover at ~4000Hz (calculate once)
    const w = 2.0 * Math.PI * 4000 / sr;
    this.lpAlpha = w / (w + 1.0);
    this.lastMsgTime = 0;
  }

  process(inputs, outputs, parameters) {
    const dryInput = inputs[0]; // Delayed original signal
    const essInput = inputs[1]; // High-passed signal for sibilance detection
    const output = outputs[0];

    if (!dryInput || dryInput.length === 0 || dryInput[0].length === 0) return true;

    const channels = dryInput.length;
    
    // Initialize channel states if missing
    while (this.envGate.length < channels) {
      this.envGate.push(0);
      this.smoothGateGain.push(1.0);
      this.envEss.push(0);
      this.smoothEssGain.push(1.0);
      this.lpState.push(0);
    }
    
    const gateThresh = parameters.gateThreshold;
    const gateRatio = parameters.gateRatio;
    const essThresh = parameters.deEsserThreshold;
    const essAmt = parameters.deEsserAmount;
    
    const gT_is_arr = gateThresh.length > 1;
    const gR_is_arr = gateRatio.length > 1;
    const eT_is_arr = essThresh.length > 1;
    const eA_is_arr = essAmt.length > 1;
    const gT_stat = gateThresh[0];
    const gR_stat = gateRatio[0];
    const eT_stat = essThresh[0];
    const eA_stat = essAmt[0];
    const alpha = this.lpAlpha;

    for (let c = 0; c < channels; c++) {
      const inChannel = dryInput[c];
      const essChannel = (essInput && essInput.length > c) ? essInput[c] : inChannel;
      const outChannel = output[c];
      if (!outChannel) continue;

      for (let i = 0; i < inChannel.length; i++) {
        const gT = gT_is_arr ? gateThresh[i] : gT_stat;
        const gR = gR_is_arr ? gateRatio[i] : gR_stat;
        const eT = eT_is_arr ? essThresh[i] : eT_stat;
        const eA = eA_is_arr ? essAmt[i] : eA_stat;

        const inSample = inChannel[i];

        // 1-pole Lowpass Filter
        this.lpState[c] += alpha * (inSample - this.lpState[c]);
        const lowBand = this.lpState[c];
        const highBand = inSample - lowBand; // Perfect phase reconstruction

        // 1. Envelope Follower for Gate (De-reverb) - Uses full band
        const absIn = Math.abs(inSample);
        const gateCoef = absIn > this.envGate[c] ? this.gateAttack : this.gateRelease;
        this.envGate[c] += (absIn - this.envGate[c]) * gateCoef;

        let targetGateGain = 1.0;
        if (this.envGate[c] < gT && gT > 0) {
          const ratio = Math.max(this.envGate[c], 1e-5) / gT;
          targetGateGain = Math.pow(ratio, gR - 1);
        }
        this.smoothGateGain[c] += (targetGateGain - this.smoothGateGain[c]) * (targetGateGain < this.smoothGateGain[c] ? this.gateAttack : this.gateRelease);

        // 2. Envelope Follower for De-esser - Driven by essChannel but acts ONLY on highBand
        const absEss = essChannel ? Math.abs(essChannel[i]) : 0;
        const essCoef = absEss > this.envEss[c] ? this.essAttack : this.essRelease;
        this.envEss[c] += (absEss - this.envEss[c]) * essCoef;

        let targetEssGain = 1.0;
        if (this.envEss[c] > eT && eT > 0) {
           targetEssGain = 1.0 - eA; // Hard cut limit
        }
        this.smoothEssGain[c] += (targetEssGain - this.smoothEssGain[c]) * (targetEssGain < this.smoothEssGain[c] ? this.essAttack : this.essRelease);

        // Mix: Low band is untouched by de-esser. High band is ducked. Both are gated.
        outChannel[i] = (lowBand + highBand * this.smoothEssGain[c]) * this.smoothGateGain[c];
        
        // Report reduction (channel 0 only for meter)
        if (c === 0 && i % 128 === 0) {
          const now = currentTime;
          if (now - this.lastMsgTime > 0.033) { // ~30Hz
            this.lastMsgTime = now;
            const gateRed = this.smoothGateGain[c];
            const essRed = this.smoothEssGain[c];
            this.port.postMessage({ 
              type: 'reduction', 
              totalReduction: gateRed * essRed,
              esserReduction: essRed 
            });
          }
        }
      }
    }

    return true;
  }
}

registerProcessor('vocal-processor', VocalProcessor);
`;
