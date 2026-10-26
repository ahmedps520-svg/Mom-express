// Short chimes made with the Web Audio API, so no sound files are needed.
// Browsers only allow audio after the person has interacted with the page,
// so the audio context is unlocked on the first tap or key press.

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

export function installAudioUnlock(): void {
  const unlock = () => {
    const c = context();
    if (c && c.state === 'suspended') void c.resume();
  };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
}

export type Chime = 'new' | 'urgent' | 'update' | 'delivered';

const PATTERNS: Record<Chime, { freq: number; at: number; dur: number }[]> = {
  new: [
    { freq: 880, at: 0, dur: 0.16 },
    { freq: 1318.5, at: 0.14, dur: 0.32 },
  ],
  urgent: [
    { freq: 1046.5, at: 0, dur: 0.12 },
    { freq: 1318.5, at: 0.13, dur: 0.12 },
    { freq: 1046.5, at: 0.26, dur: 0.12 },
    { freq: 1318.5, at: 0.39, dur: 0.3 },
  ],
  update: [{ freq: 987.8, at: 0, dur: 0.28 }],
  delivered: [
    { freq: 784, at: 0, dur: 0.14 },
    { freq: 987.8, at: 0.12, dur: 0.14 },
    { freq: 1318.5, at: 0.24, dur: 0.38 },
  ],
};

/** Plays a chime. Returns false if the browser won't play audio yet. */
export function playChime(kind: Chime): boolean {
  const c = context();
  if (!c || c.state !== 'running') {
    if (c && c.state === 'suspended') void c.resume();
    return false;
  }
  const start = c.currentTime + 0.02;
  for (const note of PATTERNS[kind]) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = note.freq;
    gain.gain.setValueAtTime(0, start + note.at);
    gain.gain.linearRampToValueAtTime(0.22, start + note.at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.dur);
    osc.connect(gain).connect(c.destination);
    osc.start(start + note.at);
    osc.stop(start + note.at + note.dur + 0.05);
  }
  return true;
}

export function vibrate(pattern: number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported */
  }
}
