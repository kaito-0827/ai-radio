import React, { useEffect, useRef } from "react";

interface RadioVisualizerProps {
  analyser: AnalyserNode | null;
  speaker: string | null;
  isPlaying: boolean;
}

export const RadioVisualizer: React.FC<RadioVisualizerProps> = ({
  analyser,
  speaker,
  isPlaying,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const bufferLength = analyser ? analyser.frequencyBinCount : 128;
    const dataArray = new Uint8Array(bufferLength);

    const render = () => {
      animationRef.current = requestAnimationFrame(render);

      const width = canvas.width;
      const height = canvas.height;

      // Create neon gradient background
      ctx.fillStyle = "rgba(10, 10, 18, 0.15)"; // Soft trailing effect
      ctx.fillRect(0, 0, width, height);

      if (analyser && isPlaying) {
        analyser.getByteFrequencyData(dataArray);
      } else {
        // Flatline / dummy values when paused or no analyzer
        for (let i = 0; i < bufferLength; i++) {
          dataArray[i] = 10 + Math.sin(Date.now() * 0.005 + i * 0.1) * 5;
        }
      }

      // Determine colors based on active speaker
      let primaryColor = "#a855f7"; // purple for BGM only
      let secondaryColor = "#6366f1"; // indigo

      if (speaker) {
        primaryColor = "#a3e635"; // zunda green while ずんだもん is talking
        secondaryColor = "#22c55e";
      }

      // Draw equalizer bars
      const barWidth = (width / bufferLength) * 2.5;
      let barHeight;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        barHeight = (dataArray[i] / 255) * height * 0.8;

        const grad = ctx.createLinearGradient(0, height, 0, height - barHeight);
        grad.addColorStop(0, "transparent");
        grad.addColorStop(0.5, secondaryColor);
        grad.addColorStop(1, primaryColor);

        ctx.fillStyle = grad;
        
        // Add neon glow
        ctx.shadowBlur = isPlaying ? 10 : 2;
        ctx.shadowColor = primaryColor;

        // Draw rounded bars
        ctx.beginPath();
        ctx.roundRect(x, height - barHeight, barWidth - 2, barHeight, [4, 4, 0, 0]);
        ctx.fill();

        x += barWidth;
      }

      // Draw middle oscillosope ring for extra aesthetic
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, Math.min(width, height) * 0.25, 0, Math.PI * 2);
      ctx.stroke();

      if (isPlaying && speaker) {
        ctx.strokeStyle = "rgba(163, 230, 53, 0.2)";
        ctx.lineWidth = 2;
        ctx.shadowBlur = 15;
        ctx.shadowColor = "#a3e635";
        ctx.beginPath();
        
        // Pulsing circle
        const pulse = 1 + (dataArray[10] / 255) * 0.15;
        ctx.arc(width / 2, height / 2, Math.min(width, height) * 0.25 * pulse, 0, Math.PI * 2);
        ctx.stroke();
      }
    };

    render();

    // Resize handler
    const handleResize = () => {
      if (!canvas) return;
      const rect = canvas.parentElement?.getBoundingClientRect();
      canvas.width = rect?.width || 600;
      canvas.height = rect?.height || 250;
    };

    handleResize();
    window.addEventListener("resize", handleResize);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      window.removeEventListener("resize", handleResize);
    };
  }, [analyser, speaker, isPlaying]);

  return (
    <div className="relative w-full h-[250px] bg-slate-950/80 backdrop-blur-md rounded-2xl overflow-hidden border border-slate-800">
      {/* Decorative radio grid pattern */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(18,24,38,0.3)_1px,transparent_1px),linear-gradient(90deg,rgba(18,24,38,0.3)_1px,transparent_1px)] bg-[size:20px_20px] pointer-events-none" />
      <canvas ref={canvasRef} className="w-full h-full block" />
      
      {/* Live Badge */}
      <div className="absolute top-4 left-4 flex items-center space-x-2">
        <span className={`flex h-3 w-3 relative ${isPlaying ? "block" : "hidden"}`}>
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-3 w-3 bg-rose-500"></span>
        </span>
        <span className="text-xs font-semibold tracking-wider text-slate-400 uppercase bg-slate-900/95 border border-slate-700/80 px-2 py-0.5 rounded">
          {isPlaying ? "ON AIR" : "STANDBY"}
        </span>
      </div>
    </div>
  );
};
