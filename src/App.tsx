/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo, memo } from 'react';
import WaveSurfer from 'wavesurfer.js';
import Spectrogram from 'wavesurfer.js/dist/plugins/spectrogram.esm.js';
import { Upload, Play, Pause, Download, Wand2, Activity, Settings2 } from 'lucide-react';
import { disableHmr } from './lib/utils';
import { AudioEngine } from './lib/audioEngine';

// Built-in Tooltip
const IconTooltip = ({ message }: { message: string }) => (
  <div className="group relative inline-flex items-center justify-center ml-1 cursor-help">
    <div className="w-[14px] h-[14px] rounded-full border border-[#4a4f59] text-[#8E9299] group-hover:text-[#00F0FF] group-hover:border-[#00F0FF] flex items-center justify-center text-[10px] font-bold transition-colors">
      ?
    </div>
    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block w-[180px] p-2 text-[10px] leading-relaxed text-[#E0E2E5] bg-[#1E2229] border border-[#2D333D] rounded shadow-xl z-[100] pointer-events-none">
      {message}
      <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-[#1E2229]"></div>
    </div>
  </div>
);

// Performance optimization: Memoize individual sibilance points
const SibilanceNode = memo(({ pt, audioDuration, wsWidth, onGainChange, onWidthChange }: { 
  pt: any, audioDuration: number, wsWidth: number, 
  onGainChange: (id: string, newGain: number) => void,
  onWidthChange: (id: string, newWidth: number) => void
}) => {
  const xPosPx = (pt.time / audioDuration) * wsWidth;
  // gain 1.0 is top (0%), gain 0.0 is bottom (100%) in our visual space
  const yPercent = (1.0 - (pt.gain / 1.5)) * 100; 
  const radiusPx = (pt.width / audioDuration) * wsWidth / 2;

  // Generate Bell Curve Path (Cosine interpolation for smoothness)
  const steps = 16;
  let pathPoints = [];
  for (let i = -steps; i <= steps; i++) {
    const t = i / steps; // -1 to 1
    const dx = t * radiusPx;
    const bellFactor = Math.pow(Math.cos(t * Math.PI / 2), 2); // Squared cos for a tighter bell
    const yVal = 0 + (yPercent - 0) * bellFactor;
    pathPoints.push(`${xPosPx + dx},${yVal}%`);
  }
  const bellPath = `M ${xPosPx - radiusPx},0% L ${pathPoints.join(' L ')} L ${xPosPx + radiusPx},0%`;

  const isInactive = pt.gain >= 0.995;

  return (
    <g className="pointer-events-auto">
      {/* Bell Curve Visualization */}
      {!isInactive && (
        <path 
          d={bellPath} 
          fill="url(#bellGradient)" 
          stroke="#00F0FF" 
          strokeWidth="1.5" 
          strokeOpacity="0.6" 
          fillOpacity="0.3" 
          className="pointer-events-none"
        />
      )}
      
      <line x1={xPosPx} y1="0" x2={xPosPx} y2="100%" stroke={isInactive ? "rgba(74,79,89,0.2)" : "rgba(0,240,255,0.15)"} strokeWidth="1" strokeDasharray="4,4" className="pointer-events-none" />
      
      {/* Width Handle (Left) */}
      <circle 
        cx={xPosPx - radiusPx} 
        cy="0" 
        r="4" 
        fill="#00F0FF" 
        className="cursor-ew-resize hover:r-6 transition-all"
        onMouseDown={(e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startWidth = pt.width;
          const onMouseMove = (m: MouseEvent) => {
            const deltaX = startX - m.clientX;
            const newWidth = Math.max(0.02, Math.min(2.0, startWidth + (deltaX / wsWidth) * audioDuration * 2));
            onWidthChange(pt.id, newWidth);
          };
          const onMouseUp = () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
          };
          window.addEventListener('mousemove', onMouseMove);
          window.addEventListener('mouseup', onMouseUp);
        }}
      />

      {/* Main Gain Node */}
      <g onMouseDown={(e) => {
        e.preventDefault();
        const startY = e.clientY;
        const startGain = pt.gain;
        const onMouseMove = (moveEvent: MouseEvent) => {
          const deltaY = moveEvent.clientY - startY;
          let newGain = startGain - (deltaY / 150);
          newGain = Math.max(0, Math.min(1.5, newGain));
          onGainChange(pt.id, newGain);
        };
        const onMouseUp = () => {
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
        };
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      }}>
        <circle 
          cx={xPosPx} 
          cy={`${yPercent}%`} 
          r="7" 
          fill="#0A0B0E" 
          stroke="#00F0FF" 
          strokeWidth="2.5" 
          className="cursor-ns-resize hover:fill-[#00F0FF] transition-all filter drop-shadow-[0_0_8px_rgba(0,240,255,0.8)]"
        />
        <rect x={xPosPx - 20} y={`${yPercent - 18}%`} width="40" height="11" rx="2" fill="rgba(0,0,0,0.8)" className="pointer-events-none" />
        <text x={xPosPx} y={`${yPercent - 10}%`} fill="#00F0FF" fontSize="9" fontWeight="900" textAnchor="middle" className="pointer-events-none select-none font-mono tracking-tighter">
          L3 | {pt.gain.toFixed(2)}
        </text>
      </g>
    </g>
  );
});

export default function App() {
  const waveformRef = useRef<HTMLDivElement>(null);
  const spectrogramRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  
  const [audioEngine] = useState(() => new AudioEngine());
  const [isLoaded, setIsLoaded] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [originalFileName, setOriginalFileName] = useState('');
  const [currentLUFS, setCurrentLUFS] = useState<number | null>(null);
  const [targetLUFS, setTargetLUFS] = useState<number | null>(null);
  const [isNormalizing, setIsNormalizing] = useState(false);
  
  const [sibilancePoints, setSibilancePoints] = useState<any[]>([]);
  const [rawSibilancePoints, setRawSibilancePoints] = useState<any[]>([]);
  const [pointSensitivity, setPointSensitivity] = useState(85); 
  const userGainsRef = useRef<Record<string, number>>({});
  
  const [audioDuration, setAudioDuration] = useState(0);
  
  // Real-time params
  const [gateThreshold, setGateThreshold] = useState(0.02);
  const [gateRatio, setGateRatio] = useState(4);
  const [essFreq, setEssFreq] = useState(5000);
  const [essLevel, setEssLevel] = useState(3);
  const [essThreshold, setEssThreshold] = useState(0.05);
  const [essAmount, setEssAmount] = useState(0.5);
  const [mix, setMix] = useState(1); // 0 = A(Dry), 1 = B(Wet)
  const [makeupGain, setMakeupGain] = useState(1.0);
  const [compThreshold, setCompThreshold] = useState(-24);
  const [compRatio, setCompRatio] = useState(4);

  // Export params
  const [exportFormat, setExportFormat] = useState<'wav'|'mp3'>('wav');
  const [exportBitrate, setExportBitrate] = useState(320);
  const [essReduction, setEssReduction] = useState(1.0);
  const [maxEssReduction, setMaxEssReduction] = useState(1.0);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const objectUrlRef = useRef<string | null>(null);
  const analyzerCanvasRef = useRef<HTMLCanvasElement>(null);
  const waveformContainerRef = useRef<HTMLDivElement>(null);
  const mixRef = useRef(mix);
  const [wsWidth, setWsWidth] = useState(0);

  useEffect(() => {
    if (!wsRef.current || !isLoaded) return;
    
    // Use a more robust observation to track WaveSurfer's internal expansion
    const updateWidth = () => {
      const wrapper = wsRef.current?.getWrapper();
      if (wrapper) {
        setWsWidth(wrapper.scrollWidth);
      }
    };

    const observer = new ResizeObserver(() => {
      requestAnimationFrame(updateWidth);
    });
    
    const wrapper = wsRef.current.getWrapper();
    observer.observe(wrapper);
    
    return () => observer.disconnect();
  }, [isLoaded]); 

  useEffect(() => {
    // Track de-esser specific peak reduction for the "Red Text" feedback
    if (isPlaying && essReduction < 0.99) {
      if (essReduction < maxEssReduction) setMaxEssReduction(essReduction);
    }
  }, [essReduction, isPlaying]);

  useEffect(() => { mixRef.current = mix; }, [mix]);

  useEffect(() => {
    const canvas = analyzerCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const dataArrayDry = new Uint8Array(audioEngine.analyserDry.frequencyBinCount);
    const dataArrayWet = new Uint8Array(audioEngine.analyserWet.frequencyBinCount);
    let animationId: number;

    const draw = () => {
      animationId = requestAnimationFrame(draw);
      
      // Optimization: Skip drawing if audio isn't active to save CPU
      if (audioEngine.ctx.state !== 'running' || !isPlaying) {
         if (canvas.width > 0 && canvas.height > 0) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
         }
         return;
      }

      // Sync canvas size to viewport container
      const parent = canvas.parentElement;
      if (parent) {
        if (canvas.width !== parent.clientWidth || canvas.height !== parent.clientHeight) {
          canvas.width = parent.clientWidth;
          canvas.height = parent.clientHeight;
        }
      }

      audioEngine.analyserDry.getByteFrequencyData(dataArrayDry);
      audioEngine.analyserWet.getByteFrequencyData(dataArrayWet);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const width = canvas.width;
      const height = canvas.height;
      const maxBins = Math.min(dataArrayDry.length, 600); 
      const sliceWidth = width / maxBins;

      // Draw Dry (Red)
      ctx.beginPath();
      ctx.moveTo(0, height);
      let x = 0;
      for(let i = 0; i < maxBins; i++) {
          const v = dataArrayDry[i] / 255.0;
          const y = height - (Math.pow(v, 1.2) * height);
          ctx.lineTo(x, y);
          x += sliceWidth;
      }
      ctx.lineTo(width, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 50, 50, 0.4)'; 
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 50, 50, 0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Draw Wet (Blue)
      ctx.beginPath();
      ctx.moveTo(0, height);
      x = 0;
      for(let i = 0; i < maxBins; i++) {
          const v = dataArrayWet[i] / 255.0;
          const y = height - (Math.pow(v, 1.2) * height);
          ctx.lineTo(x, y);
          x += sliceWidth;
      }
      ctx.lineTo(width, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = 'rgba(50, 150, 255, 0.5)'; 
      ctx.fill();
      ctx.strokeStyle = 'rgba(50, 150, 255, 0.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
      
      ctx.globalCompositeOperation = 'source-over';
    };

    draw();

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [audioEngine, isPlaying]);

  const handleGainChange = (id: string, newGain: number) => {
    userGainsRef.current[id] = newGain;
    setSibilancePoints(prev => prev.map(p => p.id === id ? { ...p, gain: newGain } : p));
  };
  
  const handleWidthChange = (id: string, newWidth: number) => {
    setSibilancePoints(prev => prev.map(p => p.id === id ? { ...p, width: newWidth } : p));
  };
  useEffect(() => {
    disableHmr();
    audioEngine.init();
    
    return () => {
      wsRef.current?.destroy();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
    };
  }, []);

  useEffect(() => { audioEngine.setGateThreshold(gateThreshold); }, [gateThreshold]);
  useEffect(() => { audioEngine.setGateRatio(gateRatio); }, [gateRatio]);
  useEffect(() => { audioEngine.setDeEsserFreq(essFreq); }, [essFreq]);
  useEffect(() => { audioEngine.setDeEsserThreshold(essThreshold); }, [essThreshold]);
  useEffect(() => { audioEngine.setDeEsserAmount(essAmount); }, [essAmount]);
  useEffect(() => { audioEngine.setMakeupGain(makeupGain); }, [makeupGain]);
  useEffect(() => { audioEngine.setCompThreshold(compThreshold); }, [compThreshold]);
  useEffect(() => { audioEngine.setCompRatio(compRatio); }, [compRatio]);
  
  // 5-level automation mapping
  useEffect(() => {
    const levels = {
      1: { t: 0.15, a: 0.2 },
      2: { t: 0.08, a: 0.4 },
      3: { t: 0.04, a: 0.6 },
      4: { t: 0.02, a: 0.8 },
      5: { t: 0.005, a: 0.95 }
    };
    const target = levels[essLevel as keyof typeof levels] || levels[3];
    setEssThreshold(target.t);
    setEssAmount(target.a);
  }, [essLevel]);

  // Filter raw points by sensitivity
  useEffect(() => {
    if (!rawSibilancePoints.length) {
      setSibilancePoints([]);
      return;
    }
    const cutoff = 0.02 * Math.pow(1 - pointSensitivity / 100, 4); 
    const filtered = rawSibilancePoints.filter(pt => pt.peak >= cutoff).map(pt => {
      const defaultGain = Math.max(0.1, 1.0 - Math.min(0.9, Math.pow(pt.peak, 0.5) * 3));
      return {
        ...pt,
        gain: userGainsRef.current[pt.id] ?? defaultGain,
        width: pt.width ?? 0.15 // Default width 150ms
      };
    });
    setSibilancePoints(filtered);
  }, [rawSibilancePoints, pointSensitivity]);

  useEffect(() => { 
    audioEngine.setMix(mix); 
    if (wsRef.current) {
      wsRef.current.setOptions({
        progressColor: mix === 0 ? '#00F0FF' : '#D4AF37',
        waveColor: mix === 0 ? '#2D333D' : 'rgba(212,175,55,0.4)',
        cursorColor: mix === 0 ? '#D4AF37' : '#00F0FF',
      });
    }
  }, [mix, audioEngine]);

  useEffect(() => {
    audioEngine.updateSibilancePoints(sibilancePoints);
  }, [sibilancePoints, audioEngine]);

  useEffect(() => {
    audioEngine.onReduction = (_val, essVal) => {
      setEssReduction(essVal);
    };
    return () => { audioEngine.onReduction = null; };
  }, [audioEngine]);

  const handleClear = () => {
    if (wsRef.current) {
      wsRef.current.destroy();
      wsRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    audioEngine.clear();
    
    setIsLoaded(false);
    setIsPlaying(false);
    setRawSibilancePoints([]);
    setSibilancePoints([]);
    userGainsRef.current = {};
    setPointSensitivity(85);
    setAudioDuration(0);
    setIsAnalyzing(false);
    setMaxEssReduction(1.0);
    setWsWidth(0);
    setCurrentLUFS(null);
    setTargetLUFS(null);
    setMakeupGain(1.0);
    setGateThreshold(0.02);
    setGateRatio(4);
    setEssLevel(3);
    setEssFreq(5000);
    setMix(1);
    setCompThreshold(-24);
    setCompRatio(4);
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    handleClear();
    setIsAnalyzing(true);
    setOriginalFileName(file.name.replace(/\.[^/.]+$/, ""));

    const objectUrl = URL.createObjectURL(file);
    objectUrlRef.current = objectUrl;

    wsRef.current = WaveSurfer.create({
      container: waveformRef.current!,
      waveColor: '#2D333D',
      progressColor: '#00F0FF',
      height: 200,
      barWidth: 2,
      cursorColor: '#D4AF37',
      normalize: true,
      fillParent: true,
      minPxPerSec: 0,
      interact: true, 
      plugins: [
        Spectrogram.create({
          container: spectrogramRef.current!,
          labels: true,
          height: 220,
          splitChannels: false,
        })
      ]
    });

    wsRef.current.setVolume(0);
    wsRef.current.load(objectUrl);
    
    try {
      await audioEngine.loadAudio(file);
      setIsLoaded(true);
      setRawSibilancePoints(audioEngine.sibilancePoints);
      userGainsRef.current = {};
      setPointSensitivity(85);
      setAudioDuration(audioEngine.audioBuffer?.duration || 0);
    } catch (e) {
      console.error(e);
      alert("오디오 로딩 또는 분석 중 오류가 발생했습니다.");
    } finally {
      setIsAnalyzing(false);
    }

    wsRef.current.on('play', () => {
       setIsPlaying(true);
       audioEngine.seek(wsRef.current!.getCurrentTime());
       audioEngine.play();
    });
    wsRef.current.on('pause', () => {
       setIsPlaying(false);
       audioEngine.pause();
    });
    wsRef.current.on('interaction', (newTime) => {
       audioEngine.seek(newTime);
    });
    wsRef.current.on('finish', () => {
       setIsPlaying(false);
       audioEngine.pause();
       audioEngine.seek(0);
    });
  };

  const togglePlayback = async () => {
    if (!wsRef.current) return;
    await audioEngine.resumeContext();
    wsRef.current.playPause();
  };

  // Trigger width update
  useEffect(() => {
    if (wsRef.current && isLoaded) {
      const update = () => {
        const wrapper = wsRef.current?.getWrapper();
        if (wrapper) setWsWidth(wrapper.scrollWidth);
      };
      
      wsRef.current.on('redraw', update);
      wsRef.current.on('zoom', update);
      
      return () => {
        wsRef.current?.un('redraw', update);
        wsRef.current?.un('zoom', update);
      };
    }
  }, [isLoaded]);

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in input (though we don't have text inputs right now)
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlayback();
      } else if (e.key.toLowerCase() === 'a' || e.key === '1') {
        setMix(0);
      } else if (e.key.toLowerCase() === 'b' || e.key === '2') {
        setMix(1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isLoaded]);

  const handleNormalize = async (target: number) => {
    if (!isLoaded || isNormalizing) return;
    setIsNormalizing(true);
    try {
      const lufs = await audioEngine.applyNormalization(target);
      setCurrentLUFS(lufs);
      setTargetLUFS(target);
    } catch (e) {
      console.error(e);
      alert("LUFS 정규화 작업 중 오류가 발생했습니다.");
    } finally {
      setIsNormalizing(false);
    }
  };

  const handleExport = async () => {
    if (!isLoaded || isExporting) return;
    setIsExporting(true);
    setExportProgress(0);
    try {
      // Must pass points into engine just in case
      audioEngine.updateSibilancePoints(sibilancePoints);
      const blob = await audioEngine.exportOffline(
        gateThreshold, gateRatio, essThreshold, essAmount, essFreq, makeupGain, 
        compThreshold, compRatio, mix,
        exportFormat, exportBitrate, (p) => setExportProgress(p)
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const fileName = originalFileName || 'SunoMaster';
      a.download = `${fileName}_deessed.${exportFormat}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.error(e);
      alert("내보내기 중 오류가 발생했습니다.");
    } finally {
      setIsExporting(false);
      setExportProgress(0);
    }
  };

  return (
    <div className="min-h-screen w-full bg-[#0A0B0E] text-[#E0E2E5] font-sans flex flex-col">
      {/* Header */}
      <header className="h-[64px] min-h-[64px] bg-[#0A0B0E] border-b border-[#2D333D] px-6 flex items-center justify-between z-50">
        <div className="flex items-center gap-4">
          <div className="w-9 h-9 bg-gradient-to-br from-[#00F0FF] to-[#0066FF] rounded-lg flex items-center justify-center shadow-[0_0_20px_rgba(0,240,255,0.3)]">
            <Wand2 className="w-5 h-5 text-black" />
          </div>
          <div className="flex flex-col">
            <h1 className="text-[17px] font-black tracking-tighter text-[#E0E2E5] leading-none uppercase">De-Reverb & Esser</h1>
            <div className="flex items-center mt-1.5">
              <span className="text-[#8E9299] font-black text-[9px] uppercase tracking-[2px]">Mastering Tool v1.2</span>
              <span className="w-1 h-1 bg-[#4a4f59] rounded-full mx-2"></span>
              <span className="text-[#4a4f59] text-[9px] font-bold tracking-tight uppercase">Studio Grade Process</span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="hidden lg:flex items-center gap-4 border-l border-[#2D333D] pl-6">
             <div className="flex flex-col items-end">
              <span className="text-[9px] text-[#4a4f59] font-black uppercase tracking-widest">Engine Mode</span>
              <span className="text-[10px] text-[#00F0FF] font-mono leading-none">OFFLINE READY</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {isLoaded && (
               <button onClick={handleClear} className="text-[#8E9299] hover:text-white bg-[#16181D] border border-[#2D333D] px-4 py-2 rounded text-[10px] font-black transition-all hover:bg-[#2D333D]">
                  RESET
               </button>
            )}
            <label className="cursor-pointer bg-[#00F0FF] hover:bg-white text-black px-6 py-2.5 rounded text-[11px] font-black tracking-tight transition-all flex items-center shadow-[0_4px_15px_rgba(0,240,255,0.2)]">
              <Upload className="w-4 h-4 mr-2" />
              {isLoaded ? "OPEN NEW" : "IMPORT AUDIO"}
              <input type="file" className="hidden" accept="audio/*" onChange={handleFileUpload} onClick={(e) => { e.currentTarget.value = ''; }} />
            </label>
          </div>
        </div>
      </header>

      {/* Main Content Grid */}
      <main className="flex-1 bg-[#2D333D] flex flex-col md:grid md:grid-cols-[280px_1fr] gap-[1px]">
        
        {/* Left Column (Aside) */}
        <aside className="bg-[#0A0B0E] flex flex-col md:overflow-y-auto border-r border-[#2D333D] w-full custom-scrollbar">
          <div className="h-[36px] min-h-[36px] px-4 flex items-center bg-[#16181D] border-b border-[#2D333D]">
            <div className="text-[10px] font-black uppercase tracking-[2px] text-[#4a4f59]">
              PROCESSOR CONSOLE
            </div>
          </div>
          
          <div className="p-4 space-y-4">
            {/* Auto Gate Card */}
            <div className="bg-[#16181D] rounded-lg border border-[#2D333D] p-3.5 shadow-inner">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-5 h-5 rounded bg-[rgba(0,240,255,0.1)] flex items-center justify-center border border-[rgba(0,240,255,0.2)]">
                  <Activity className="w-3 h-3 text-[#00F0FF]" />
                </div>
                <span className="text-[11px] font-black text-[#E0E2E5] uppercase tracking-tighter">자동 잔향 억제</span>
                <IconTooltip message="모든 소리가 끝나는 지점의 꼬리를 짤라내어 공간의 잔향을 지웁니다." />
              </div>
              <div className="space-y-5">
                <div>
                  <label className="flex justify-between text-[10px] text-[#8E9299] mb-3 font-mono uppercase tracking-[1px]">
                    <span>Gate Threshold</span>
                    <span className="text-[#00F0FF] font-bold">{gateThreshold.toFixed(3)}</span>
                  </label>
                  <div className="relative h-1 bg-[#0A0B0E] rounded-full flex items-center">
                    <input type="range" min="0" max="0.1" step="0.001" value={gateThreshold} onChange={e => setGateThreshold(parseFloat(e.target.value))} aria-label="Gate Threshold" className="w-full absolute inset-0 opacity-0 cursor-pointer z-10" />
                    <div className="h-full bg-gradient-to-r from-[#2D333D] to-[#00F0FF] rounded-full" style={{ width: `${(gateThreshold / 0.1) * 100}%` }}></div>
                  </div>
                </div>
                <div>
                  <label className="flex justify-between text-[10px] text-[#8E9299] mb-3 font-mono uppercase tracking-[1px]">
                    <span>Reduction Ratio</span>
                    <span className="text-[#00F0FF] font-bold">{gateRatio.toFixed(1)}:1</span>
                  </label>
                  <div className="relative h-1 bg-[#0A0B0E] rounded-full flex items-center">
                    <input type="range" min="1" max="20" step="0.1" value={gateRatio} onChange={e => setGateRatio(parseFloat(e.target.value))} aria-label="Gate Ratio" className="w-full absolute inset-0 opacity-0 cursor-pointer z-10" />
                    <div className="h-full bg-gradient-to-r from-[#2D333D] to-[#00F0FF] rounded-full" style={{ width: `${((gateRatio - 1) / 19) * 100}%` }}></div>
                  </div>
                </div>
              </div>
            </div>

            {/* Auto De-Esser Card */}
            <div className="bg-[#16181D] rounded-lg border border-[#2D333D] p-3.5 shadow-inner">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-5 h-5 rounded bg-[rgba(0,240,255,0.1)] flex items-center justify-center border border-[rgba(0,240,255,0.2)]">
                  <Activity className="w-3 h-3 text-[#00F0FF]" />
                </div>
                <span className="text-[11px] font-black text-[#E0E2E5] uppercase tracking-tighter">자동 치찰음 억제</span>
                <IconTooltip message="재생되는 내내 고음역대를 감지하여 자동으로 치찰음을 통제합니다." />
              </div>
              <div className="space-y-5">
                <div>
                  <label className="flex justify-between text-[10px] text-[#8E9299] mb-3 font-mono uppercase tracking-[1px]">
                    <span>Target Frequency</span>
                    <span className="text-[#00F0FF] font-bold">{essFreq} Hz</span>
                  </label>
                  <div className="relative h-1 bg-[#0A0B0E] rounded-full flex items-center">
                    <input type="range" min="2000" max="10000" step="100" value={essFreq} onChange={e => setEssFreq(parseFloat(e.target.value))} aria-label="De-esser Frequency" className="w-full absolute inset-0 opacity-0 cursor-pointer z-10" />
                    <div className="h-full bg-gradient-to-r from-[#2D333D] to-[#00F0FF] rounded-full" style={{ width: `${((essFreq - 2000) / 8000) * 100}%` }}></div>
                  </div>
                </div>
                <div>
                  <label className="flex justify-between text-[10px] text-[#8E9299] mb-3 font-mono uppercase tracking-[1px]">
                    <span>Strength Level</span>
                    <span className="text-[#00F0FF] font-bold">LV {essLevel}</span>
                  </label>
                  <div className="grid grid-cols-5 gap-1.5">
                    {[1,2,3,4,5].map(lvl => {
                      const messages = [
                        "약함 (Soft): 가벼운 치찰음 제거",
                        "가벼움 (Light): 표준적인 치찰음 제거",
                        "보통 (Normal): 균형 잡힌 제거 스타일 (추천)",
                        "강함 (Strong): 확실한 치찰음 억제",
                        "매우 강함 (Aggressive): 강력한 억제 (음질 저하 주의)"
                      ];
                      return (
                        <div key={lvl} className="group/btn relative">
                          <button onClick={() => setEssLevel(lvl)} 
                            className={`w-full py-2 rounded text-[10px] font-black border transition-all ${essLevel === lvl ? 'bg-[#00F0FF] border-[#00F0FF] text-black shadow-[0_0_10px_rgba(0,240,255,0.4)]' : 'bg-[#0A0B0E] border-[#2D333D] text-[#4a4f59] hover:border-[#8E9299]'}`}
                          >
                            {lvl}
                          </button>
                          <div className={`absolute bottom-full mb-2 hidden group-hover/btn:block w-[140px] p-2 text-[9px] leading-tight text-[#E0E2E5] bg-[#1E2229] border border-[#2D333D] rounded shadow-xl z-50 pointer-events-none text-center ${lvl === 1 ? 'left-0' : lvl === 5 ? 'right-0' : 'left-1/2 -translate-x-1/2'}`}>
                            {messages[lvl-1]}
                            <div className={`absolute top-full border-4 border-transparent border-t-[#1E2229] ${lvl === 1 ? 'left-4' : lvl === 5 ? 'right-4' : 'left-1/2 -translate-x-1/2'}`}></div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Dynamic Range Control Card */}
            <div className="bg-[#16181D] rounded-lg border border-[#D4AF37] border-opacity-30 p-3.5 shadow-inner">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-5 h-5 rounded bg-[rgba(212,175,55,0.1)] flex items-center justify-center border border-[rgba(212,175,55,0.2)]">
                  <Activity className="w-3 h-3 text-[#D4AF37]" />
                </div>
                <span className="text-[11px] font-black text-[#E0E2E5] uppercase tracking-tighter">다이내믹 레인지 조절</span>
                <IconTooltip message="컴프레서를 사용하여 소리의 크기 편차를 줄이고, 전체적으로 단단하고 묵직한 소리를 만듭니다." />
              </div>
              <div className="space-y-5">
                <div>
                  <label className="flex justify-between text-[10px] text-[#8E9299] mb-3 font-mono uppercase tracking-[1px]">
                    <span>Comp Threshold</span>
                    <span className="text-[#D4AF37] font-bold">{compThreshold} dB</span>
                  </label>
                  <div className="relative h-1 bg-[#0A0B0E] rounded-full flex items-center">
                    <input type="range" min="-60" max="0" step="1" value={compThreshold} onChange={e => setCompThreshold(parseFloat(e.target.value))} aria-label="Compressor Threshold" className="w-full absolute inset-0 opacity-0 cursor-pointer z-10" />
                    <div className="h-full bg-gradient-to-r from-[#2D333D] to-[#D4AF37] rounded-full" style={{ width: `${((compThreshold + 60) / 60) * 100}%` }}></div>
                  </div>
                </div>
                <div>
                  <label className="flex justify-between text-[10px] text-[#8E9299] mb-3 font-mono uppercase tracking-[1px]">
                    <span>Comp Ratio</span>
                    <span className="text-[#D4AF37] font-bold">{compRatio}:1</span>
                  </label>
                  <div className="relative h-1 bg-[#0A0B0E] rounded-full flex items-center">
                    <input type="range" min="1" max="20" step="0.5" value={compRatio} onChange={e => setCompRatio(parseFloat(e.target.value))} aria-label="Compressor Ratio" className="w-full absolute inset-0 opacity-0 cursor-pointer z-10" />
                    <div className="h-full bg-gradient-to-r from-[#2D333D] to-[#D4AF37] rounded-full" style={{ width: `${((compRatio - 1) / 19) * 100}%` }}></div>
                  </div>
                </div>
              </div>
            </div>

            {/* LUFS Normalization Card */}
            <div className="bg-[#16181D] rounded-lg border border-[#2D333D] p-3.5 shadow-inner">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-5 h-5 rounded bg-[rgba(212,175,55,0.1)] flex items-center justify-center border border-[rgba(212,175,55,0.2)]">
                  <Activity className="w-3 h-3 text-[#D4AF37]" />
                </div>
                <span className="text-[11px] font-black text-[#E0E2E5] uppercase tracking-tighter">Normalizer</span>
                <IconTooltip message="최종 출력 음량을 특정 LUFS 기준으로 맞춥니다." />
              </div>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-2">
                  {[-14, -16].map(target => (
                    <button
                      key={target}
                      disabled={!isLoaded || isNormalizing}
                      onClick={() => handleNormalize(target)}
                      className={`py-3 rounded text-[11px] font-black border transition-all ${targetLUFS === target ? 'bg-[#D4AF37] border-[#D4AF37] text-black shadow-[0_0_10px_rgba(212,175,55,0.3)]' : 'bg-[#0A0B0E] border-[#2D333D] text-[#8E9299] hover:border-[#D4AF37]'}`}
                    >
                      {isNormalizing && targetLUFS === target ? 'CALC...' : `${target} LUFS`}
                    </button>
                  ))}
                </div>
                {currentLUFS !== null && (
                  <div className="bg-[#0A0B0E] p-3 rounded border border-[#2D333D] font-mono space-y-1.5 shadow-inner">
                    <div className="flex justify-between items-center">
                      <span className="text-[8px] font-black text-[#4a4f59] uppercase tracking-widest">Original</span>
                      <span className="text-[10px] text-[#E0E2E5]">{currentLUFS.toFixed(1)} LUFS</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-[8px] font-black text-[#D4AF37] uppercase tracking-widest">Targeted</span>
                      <span className="text-[10px] text-[#D4AF37] font-bold">{targetLUFS} LUFS</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Makeup Gain Card */}
            <div className="bg-[#16181D] rounded-lg border border-[#2D333D] p-3.5 shadow-inner">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-5 h-5 rounded bg-[rgba(212,175,55,0.1)] flex items-center justify-center border border-[rgba(212,175,55,0.2)]">
                  <Activity className="w-3 h-3 text-[#D4AF37]" />
                </div>
                <span className="text-[11px] font-black text-[#E0E2E5] uppercase tracking-tighter">Makeup gain</span>
              </div>
              
              <div className="mb-4 bg-[#0A0B0E] p-2 rounded border border-[#2D333D] border-dashed">
                 <div className="text-[10px] font-mono text-red-500 font-black mb-1 flex items-center gap-2 uppercase tracking-tighter">
                   <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shadow-[0_0_8px_#ef4444]"></div>
                   Reduction Peak: -{(-20 * Math.log10(Math.max(maxEssReduction, 0.001))).toFixed(1)} dB
                 </div>
              </div>

              <div>
                <label className="flex justify-between text-[10px] text-[#D4AF37] mb-3 font-mono font-black uppercase tracking-[1px]">
                  <span>Compensation</span>
                  <span>{(makeupGain >= 1.0 ? '+' : '') + (20 * Math.log10(makeupGain)).toFixed(1)} dB</span>
                </label>
                <div className="relative h-1 bg-[#0A0B0E] rounded-full flex items-center">
                  <input type="range" min="0.5" max="4.0" step="0.01" value={makeupGain} onChange={e => setMakeupGain(parseFloat(e.target.value))} aria-label="Makeup Gain" className="w-full absolute inset-0 opacity-0 cursor-pointer z-10" />
                  <div className="h-full bg-gradient-to-r from-[#2D333D] to-[#D4AF37] rounded-full" style={{ width: `${((makeupGain - 0.5) / 3.5) * 100}%` }}></div>
                </div>
              </div>
            </div>

              {/* Export Action Card */}
              <div className="bg-[#16181D] rounded-lg border border-[#2D333D] p-4 shadow-inner">
                <div className="text-[9px] font-black uppercase tracking-[3px] text-[#4a4f59] mb-4 text-center">Export Configuration</div>
                
                <div className="grid grid-cols-2 gap-2 mb-4">
                  {['wav', 'mp3'].map(fmt => (
                    <button
                      key={fmt}
                      onClick={() => setExportFormat(fmt as 'wav'|'mp3')}
                      className={`py-2 rounded text-[11px] font-black border uppercase transition-all ${exportFormat === fmt ? 'border-[#D4AF37] text-[#D4AF37] bg-[rgba(212,175,55,0.1)] shadow-[0_0_10px_rgba(212,175,55,0.2)]' : 'bg-[#000] border-[#2D333D] text-[#4a4f59] hover:border-[#8E9299]'}`}
                    >
                      {fmt} {fmt === 'mp3' && '(320k)'}
                    </button>
                  ))}
                </div>
                
                <button 
                  className="w-full py-5 bg-[#D4AF37] hover:bg-[#e6bf4a] text-black rounded font-black text-[18px] uppercase tracking-tighter shadow-[0_8px_25px_rgba(212,175,55,0.3)] disabled:opacity-30 flex flex-col items-center justify-center transition-all group"
                  disabled={!isLoaded || isExporting}
                  onClick={handleExport}
                >
                  <div className="flex items-center gap-3">
                    <Download className={`w-5 h-5 group-enabled:group-hover:translate-y-0.5 transition-transform ${isExporting ? 'animate-bounce' : ''}`} />
                    MASTER EXPORT
                  </div>
                  <span className="text-[8px] font-black opacity-60 tracking-[4px] mt-1">{isExporting ? 'PROCESSING...' : 'PRODUCTION COMPLETE'}</span>
                </button>

                {isExporting && (
                  <div className="mt-4">
                    <div className="h-1 bg-[#0A0B0E] rounded-full overflow-hidden border border-[#2D333D]">
                      <div className="h-full bg-[#D4AF37] transition-all duration-300 shadow-[0_0_15px_#D4AF37]" style={{ width: `${exportProgress}%` }} />
                    </div>
                  </div>
                )}
              </div>
          </div>
        </aside>

        {/* Center Panel (Visualization) */}
        <section className="bg-[#0A0B0E] flex flex-col min-w-0 flex-1 md:overflow-hidden">
          <div className="h-[36px] min-h-[36px] px-3 flex items-center justify-between bg-[#16181D] border-b border-[#2D333D]">
            <div className="flex items-center">
              <div className="text-[9px] font-black uppercase tracking-[2px] text-[#4a4f59] flex flex-row items-center gap-2">
                Real-time Spectrum Analysis
              </div>
            </div>
            <div className="flex items-center space-x-3">
              <span className="text-[10px] font-mono font-bold text-[#00F0FF] uppercase tracking-widest">
                {isPlaying ? 'PLAYING AUDIO' : 'ENGINE READY'}
              </span>
            </div>
          </div>

          <div className="flex-1 p-5 flex flex-col gap-4 min-h-0 md:overflow-hidden relative">
            {/* Synced Visualization Area */}
            <div className="relative border border-[#2D333D] rounded overflow-hidden">
              <div 
                ref={waveformContainerRef} 
                className="bg-[#000] overflow-hidden select-none"
              >
                {!isLoaded && !isAnalyzing && <div className="absolute inset-0 z-10 flex items-center justify-center text-[#8E9299] font-mono text-xs">AUDIO NOT LOADED</div>}
                {isAnalyzing && (
                   <div className="absolute inset-0 z-10 flex flex-col items-center justify-center text-[#00F0FF] bg-[rgba(0,0,0,0.7)] font-mono text-xs">
                      <div className="w-5 h-5 mb-2 border-2 border-[#00F0FF] border-t-transparent rounded-full animate-spin"></div>
                      치찰음 분석 중... (Analyzing...)
                   </div>
                )}

                <div className="flex flex-col relative" style={{ width: wsWidth > 0 ? `${wsWidth}px` : '100%' }}>
                  <div className="scanline-overlay"></div>
                  <div 
                    className="relative h-[200px]"
                    style={{ minWidth: '100%' }}
                  >
                    <div ref={waveformRef} className="h-full" />
                    
                    {/* Sibilance Points Overlay */}
                    {isLoaded && audioDuration > 0 && wsRef.current && (
                      <svg 
                        className="absolute inset-0 h-full pointer-events-none z-20"
                        style={{ width: '100%' }}
                      >
                        <defs>
                          <linearGradient id="bellGradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#00F0FF" stopOpacity="0.4" />
                            <stop offset="100%" stopColor="#00F0FF" stopOpacity="0" />
                          </linearGradient>
                        </defs>
                        {sibilancePoints.map(pt => (
                          <SibilanceNode
                            key={pt.id}
                            pt={pt}
                            audioDuration={audioDuration}
                            wsWidth={wsWidth}
                            onGainChange={handleGainChange}
                            onWidthChange={handleWidthChange}
                          />
                        ))}
                      </svg>
                    )}
                  </div>

                  <div className="relative h-[220px] shrink-0 border-t border-[#2D333D] bg-[#0A0B0E]">
                    {/* Dynamic Spectrogram - ensure it fills and has distinct coloring in plugin create */}
                    <div ref={spectrogramRef} className="h-full w-full opacity-100 z-10" />
                  </div>
                </div>
              </div>
              
              {/* FIXED OVERLAY (Live Spectrum Analyzer) */}
              <div className="absolute bottom-0 left-0 w-full h-[220px] pointer-events-none z-30">
                <canvas ref={analyzerCanvasRef} className="w-full h-full" />
              </div>
            </div>
            
            <div className="flex flex-col gap-5">
              {isLoaded && audioDuration > 0 && (
                <div className="flex flex-col gap-4 p-5 bg-[#16181D] border border-[#2D333D] rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.4)] w-full">
                  <div className="flex items-center justify-between border-b border-[#2D333D] pb-4 mb-1">
                     <div className="flex items-center gap-3">
                       <div className="w-2 h-[14px] bg-[#00F0FF] rounded-full"></div>
                       <span className="text-[11px] font-black text-[#8E9299] uppercase tracking-[2px]">Detection Processor</span>
                       <IconTooltip message="우측으로 당길수록 미약한 소격까지 치찰음을 감지합니다. 파형 위의 노드를 직접 아래로 끌어 볼륨을 억제하세요." />
                     </div>
                     <div className="flex items-center gap-2 bg-[#0A0B0E] px-3 py-1 rounded-full border border-[#2D333D] shadow-inner">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#00F0FF] animate-pulse shadow-[0_0_8px_#00F0FF]"></span>
                        <span className="text-[10px] text-[#00F0FF] font-mono font-black tracking-widest leading-none">
                          {sibilancePoints.length} NODES IDENTIFIED
                        </span>
                     </div>
                  </div>
                  
                  <div className="flex items-center gap-5 px-4 bg-[#0A0B0E] py-4 rounded-lg border border-[#2D333D] shadow-inner">
                    <div className="text-[9px] text-[#4a4f59] font-black uppercase tracking-[2px] w-[50px]">Loose</div>
                    <div className="relative flex-1 h-[2px] bg-[#16181D] rounded-full">
                      <input type="range" min="1" max="100" value={pointSensitivity} onChange={(e) => setPointSensitivity(Number(e.target.value))} className="w-full absolute inset-0 opacity-0 cursor-pointer z-10" />
                      <div className="h-full bg-gradient-to-r from-[#2D333D] via-[#00F0FF] to-[#00F0FF] rounded-full" style={{ width: `${pointSensitivity}%` }}></div>
                      <div className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-[#0A0B0E] border-2 border-[#00F0FF] rounded-full shadow-[0_0_10px_rgba(0,240,255,0.5)] pointer-events-none transition-all duration-75" style={{ left: `calc(${pointSensitivity}% - 8px)` }}></div>
                    </div>
                    <div className="text-[9px] text-[#4a4f59] font-black uppercase tracking-[2px] w-[50px] text-right">Aggressive</div>
                  </div>
                  
                  <div className="flex justify-between items-center mt-2 border-t border-[#2D333D] pt-5">
                    <div className="flex gap-3">
                      <button 
                        onClick={togglePlayback}
                        disabled={!isLoaded}
                        className={`group relative flex items-center justify-center px-10 py-3 rounded-md text-[13px] font-black tracking-[4px] transition-all uppercase ${isPlaying ? 'bg-[#00F0FF] text-black shadow-[0_0_25px_rgba(0,240,255,0.5)] scale-[1.02]' : 'bg-[#0A0B0E] border-2 border-[#00F0FF] text-[#00F0FF] hover:bg-[rgba(0,240,255,0.1)]'}`}
                        title="Play / Pause"
                      >
                        {isPlaying ? <Pause className="w-5 h-5 mr-3 fill-current" /> : <Play className="w-5 h-5 mr-3 fill-current ml-1" />}
                        {isPlaying ? 'PAUSE' : 'PLAY'}
                      </button>
                      
                      <div className="flex p-1.5 bg-[#0A0B0E] rounded-lg border border-[#2D333D] shadow-inner self-stretch">
                        <button 
                          className={`px-6 rounded-md text-[10px] font-black tracking-widest transition-all uppercase ${mix === 0 ? 'bg-[#2D333D] text-[#00F0FF] shadow-sm' : 'text-[#4a4f59] hover:text-[#8E9299]'}`}
                          onClick={() => setMix(0)}
                        >
                          Dry Analysis
                        </button>
                        <button 
                          className={`px-6 rounded-md text-[10px] font-black tracking-widest transition-all uppercase ${mix === 1 ? 'bg-[#D4AF37] text-black shadow-[0_0_15px_rgba(212,175,55,0.4)]' : 'text-[#4a4f59] hover:text-[#8E9299]'}`}
                          onClick={() => setMix(1)}
                        >
                          Processed
                        </button>
                      </div>
                    </div>
                    
                    <div className="flex gap-3">
                      <button 
                        onClick={() => { setGateThreshold(0.045); setGateRatio(8.0); setMix(1); }} 
                        className="px-5 py-3 bg-[#16181D] border border-[#d4af37] border-opacity-30 text-[#d4af37] text-[10px] font-black uppercase tracking-[2px] rounded-md hover:bg-[rgba(212,175,55,0.15)] hover:border-opacity-100 transition-all flex items-center shadow-lg group"
                      >
                        <Wand2 className="w-4 h-4 mr-2.5 transition-transform group-hover:rotate-12" /> Smart Cleaning <IconTooltip message="잔향음 제거" />
                      </button>
                      <button 
                        onClick={() => { userGainsRef.current = {}; setPointSensitivity(p => p === 100 ? 99 : 100); setTimeout(()=>setPointSensitivity(85), 10); }} 
                        className="px-5 py-3 bg-[#16181D] border border-[#2D333D] text-[#4a4f59] text-[10px] font-black uppercase tracking-[2px] rounded-md hover:bg-[#2D333D] hover:text-[#E0E2E5] transition-all flex items-center"
                      >
                        Reset Geometry
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <div className="p-3 bg-[#111317] rounded border border-[#2D333D]">
                <div className="text-[11px] font-black text-[#8E9299] mb-1 uppercase tracking-wider flex items-center gap-2">
                  <Activity className="w-3 h-3 text-[#00F0FF]" /> 시각 가이드 (Visualization Guide)
                </div>
                <div className="text-[10px] text-[#4a4f59] leading-relaxed">
                  치찰음 감소가 실시간으로 자동으로 적용되어 있지만, 필요한 경우 상단 파형에서 치찰음 노드(L3)를 직접 제어하고, 하단 실시간 스펙트로그램(L1-L3)을 통해 보정 결과를 즉시 모니터링하세요. 
                  고음역대 주파수가 감쇄되는 양상을 시각적으로 확인할 수 있습니다.
                </div>
              </div>

              {/* Tips / Guide Card */}
              <div className="p-3 bg-[#111317] border-l-2 border-[#00F0FF] rounded-r shadow-md">
                <div className="flex items-center gap-2 mb-1.5">
                  <Settings2 className="w-3 h-3 text-[#00F0FF]" />
                  <span className="text-[9px] font-black text-[#E0E2E5] uppercase tracking-[1.5px]">프로세서 운용 팁 (Pro Tip)</span>
                </div>
                <p className="text-[10px] text-[#8E9299] leading-relaxed font-medium">
                  치찰음 억제는 저장하고 다시 불러와서 <span className="text-[#00F0FF] font-bold">반복적으로 적용</span>하셔도 됩니다. 노드 조절이 완료된 파일을 다운로드한 뒤 다시 열어 추가 보정이 가능합니다.
                </p>
              </div>

              {/* Security / Privacy Card */}
              <div className="p-3 bg-[#0D0F13] border border-[#2D333D] rounded border-dashed">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-[#00F0FF] animate-pulse"></div>
                    <span className="text-[10px] font-black text-[#E0E2E5] tracking-widest uppercase">Privacy Secured</span>
                  </div>
                  <div className="text-[7px] font-black text-[#4a4f59] uppercase border border-[#2D333D] px-1.5 py-0.5 rounded tracking-[1px]">
                    100% LOCAL PROCESSING
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-[10px] text-[#00F0FF] font-black tracking-tight underline underline-offset-2 decoration-[#2D333D]">
                    100% 로컬 구동, 음원 외부 유출 없음
                  </p>
                  <p className="text-[9px] text-[#4a4f59] leading-relaxed font-medium">
                    정적 자원(HTML/JS/CSS)만으로 구성되어 있고, 서버 사이드 로직이나 DB, 외부 API 키가 전혀 필요 없는 <span className="text-[#8E9299]">Pure Client-Side App</span>입니다.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Persistent Status Bar */}
      <footer className="h-[30px] shrink-0 bg-[#0A0B0E] border-t border-[#2D333D] flex items-center justify-between px-5 relative">
        <div className="flex items-center gap-4 text-[9px] font-mono text-[#4a4f59] uppercase tracking-widest">
          <span>Engine: Ready</span>
          <span>Buffer: Optimized</span>
          <span>Sample: 44.1kHz</span>
        </div>

        <div className="absolute left-1/2 -translate-x-1/2 text-[9px] font-mono font-bold text-[#8E9299] opacity-40 tracking-[3px] pointer-events-none uppercase">
          Created by 그런거죠
        </div>

        <div className="text-[9px] font-mono text-[#4a4f59]">
          SYSTEM_STABLE: OK
        </div>
      </footer>
    </div>
  );
}
