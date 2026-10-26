import { useId } from 'react';

const HEART = 'M256 416C256 416 96 320 96 208C96 152 140 112 192 112C224 112 248 130 256 152C264 130 288 112 320 112C372 112 416 152 416 208C416 320 256 416 256 416Z';

/** The MomExpress mark: a heart in a hurry. */
export function BrandMark({ size = 36, className = '' }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg className={`brand-mark ${className}`} width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FF4F8B" />
          <stop offset="0.55" stopColor="#FF7862" />
          <stop offset="1" stopColor="#FFA845" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="128" fill={`url(#${id}-bg)`} />
      <g transform="translate(24 -12)">
        <g fill="none" stroke="#fff" strokeLinecap="round" strokeWidth="30">
          <path d="M84 222H150" />
          <path d="M52 268H150" />
          <path d="M108 314H178" />
        </g>
        <g transform="translate(298 270) scale(0.66) translate(-256 -264)">
          <path fill="#fff" d={HEART} />
        </g>
      </g>
    </svg>
  );
}

export function BrandLockup() {
  return (
    <span className="brand-lockup">
      <BrandMark size={34} />
      <span>
        Mom<span className="gradient-text">Express</span>
      </span>
    </span>
  );
}
