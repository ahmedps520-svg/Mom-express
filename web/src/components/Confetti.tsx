import { useEffect, useState, type CSSProperties } from 'react';

const COLORS = ['#ff4f8b', '#ff7862', '#ffa845', '#ffd166', '#7c6cff', '#22c55e'];

/** A short burst of confetti for a completed delivery. */
export function Confetti({ fire }: { fire: number }) {
  const [pieces, setPieces] = useState<{ x: number; y: number; r: number; c: string; d: number }[]>([]);

  useEffect(() => {
    if (!fire || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setPieces(
      Array.from({ length: 42 }, () => {
        const angle = Math.random() * Math.PI * 2;
        const dist = 120 + Math.random() * 260;
        return {
          x: Math.cos(angle) * dist,
          y: Math.sin(angle) * dist * 0.8 + 160,
          r: Math.random() * 720 - 360,
          c: COLORS[Math.floor(Math.random() * COLORS.length)],
          d: Math.random() * 0.15,
        };
      }),
    );
    const t = setTimeout(() => setPieces([]), 1800);
    return () => clearTimeout(t);
  }, [fire]);

  if (pieces.length === 0) return null;
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <i
          key={i}
          style={
            {
              background: p.c,
              animationDelay: `${p.d}s`,
              '--x': `${p.x}px`,
              '--y': `${p.y}px`,
              '--r': `${p.r}deg`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
