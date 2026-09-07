import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { buildPattern } from '../stitching/engine';
import type { Point, RGB } from '../types';

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

function rgbCss(c: RGB): string {
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

export default function StitchPlayback({ onClose }: { onClose: () => void }) {
  const { doc } = useStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);

  const built = useMemo(() => buildPattern(doc.objects), [doc.objects]);
  const stitches = built.stitches;
  const total = stitches.length;

  // Base playback rate: real embroidery machines run roughly 400-800 stitches/min;
  // we play faster than real time so a whole design is watchable in seconds.
  const BASE_STITCHES_PER_SEC = 60;

  useEffect(() => {
    if (!playing || total === 0) return;
    let raf: number;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setIndex((i) => {
        const next = i + dt * BASE_STITCHES_PER_SEC * speed;
        if (next >= total) {
          setPlaying(false);
          return total;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, total]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // --- Rendering ---
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx || w === 0 || h === 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#2b2820';
    ctx.fillRect(0, 0, w, h);

    const hw = doc.hoop.width;
    const hh = doc.hoop.height;
    const pad = 40;
    const scale = Math.min((w - pad * 2) / hw, (h - pad * 2) / hh);
    const originX = w / 2;
    const originY = h / 2;
    const toScreen = (p: Point) => ({ x: originX + p.x * scale, y: originY + p.y * scale });

    const hoopTopLeft = toScreen({ x: -hw / 2, y: -hh / 2 });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(hoopTopLeft.x, hoopTopLeft.y, hw * scale, hh * scale);
    ctx.strokeStyle = '#6b6355';
    ctx.strokeRect(hoopTopLeft.x, hoopTopLeft.y, hw * scale, hh * scale);

    const upTo = Math.floor(index);
    let color: RGB = built.threads[0] ?? { r: 0, g: 0, b: 0 };
    let colorPtr = 0;
    let cursor: Point | null = null;
    ctx.lineCap = 'round';

    for (let i = 0; i <= upTo && i < stitches.length; i++) {
      const s = stitches[i];
      if (s.command === 'COLOR_CHANGE') {
        colorPtr++;
        color = built.threads[colorPtr] ?? color;
        cursor = { x: s.x, y: s.y };
        continue;
      }
      if (s.command === 'JUMP') {
        if (cursor) {
          const a = toScreen(cursor);
          const b = toScreen(s);
          ctx.strokeStyle = 'rgba(255,255,255,0.35)';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 3]);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        cursor = { x: s.x, y: s.y };
        continue;
      }
      if (s.command === 'TRIM' || s.command === 'END') {
        cursor = { x: s.x, y: s.y };
        continue;
      }
      // STITCH
      if (cursor) {
        const a = toScreen(cursor);
        const b = toScreen(s);
        ctx.strokeStyle = rgbCss(color);
        ctx.lineWidth = Math.max(1, scale * 0.28);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      cursor = { x: s.x, y: s.y };
    }

    if (cursor) {
      const needle = toScreen(cursor);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(needle.x, needle.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgbCss(color);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(needle.x, needle.y, 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [doc.hoop, stitches, built.threads, index]);

  const stitchNumber = Math.min(Math.floor(index), total);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="playback-modal" onClick={(e) => e.stopPropagation()}>
        <div className="playback-header">
          <h3>Stitch-out preview</h3>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
        <div className="playback-canvas-wrap" ref={containerRef}>
          <canvas ref={canvasRef} />
        </div>
        {total === 0 ? (
          <p className="muted" style={{ padding: '0 4px' }}>
            Nothing to preview yet — draw at least one stitch object first.
          </p>
        ) : (
          <>
            <input
              type="range"
              className="playback-scrubber"
              min={0}
              max={total}
              step={1}
              value={stitchNumber}
              onChange={(e) => {
                setPlaying(false);
                setIndex(parseFloat(e.target.value));
              }}
            />
            <div className="playback-controls">
              <button onClick={() => setIndex(0)} title="Restart">
                ⏮
              </button>
              <button onClick={() => setPlaying((p) => !p)} title="Play/Pause (Space)">
                {playing ? '⏸' : '▶'}
              </button>
              <button onClick={() => setIndex(total)} title="Skip to end">
                ⏭
              </button>
              <span className="playback-count">
                stitch {stitchNumber} / {total}
              </span>
              <div className="speed-controls">
                {SPEEDS.map((s) => (
                  <button key={s} className={s === speed ? 'active' : ''} onClick={() => setSpeed(s)}>
                    {s}×
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
