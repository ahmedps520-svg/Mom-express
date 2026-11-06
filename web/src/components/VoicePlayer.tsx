import { LoaderCircle, Play, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { voiceUrl } from '../lib/voice';

const TEXT = {
  en: { play: (s: number) => `Play voice message · ${s}s`, stop: 'Stop', failed: 'Couldn’t play it. Tap to try again.' },
  ar: {
    // Brackets, not a dot: a dot next to Arabic digits reads like a zero (٣٠).
    play: (s: number) => `استمعي (${new Intl.NumberFormat('ar-u-nu-arab').format(s)} ث)`,
    stop: 'إيقاف',
    failed: 'لم يعمل الصوت. اضغطي مرة أخرى.',
  },
};

/** A play/stop button for a voice message recorded by Mom. */
export function VoicePlayer({
  voice,
  lang = 'en',
  className = 'btn btn-soft btn-sm voice-btn',
  src,
}: {
  voice: { path?: string; seconds: number };
  lang?: 'en' | 'ar';
  className?: string;
  /** Play this address instead of fetching one (e.g. a recording not sent yet). */
  src?: string;
}) {
  const t = TEXT[lang];
  const [url, setUrl] = useState<string | null>(src ?? null);
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'failed'>('idle');
  const audio = useRef<HTMLAudioElement | null>(null);

  // Fetch the address ahead of time: phones only allow sound to start
  // straight from a tap, not after waiting for the network.
  useEffect(() => {
    if (src) {
      setUrl(src);
      return;
    }
    let cancelled = false;
    if (voice.path) void voiceUrl(voice.path).then((u) => !cancelled && setUrl(u)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [voice.path, src]);

  useEffect(() => () => audio.current?.pause(), []);

  const play = (address: string) => {
    const a = (audio.current ??= new Audio());
    a.src = address;
    a.onended = () => setState('idle');
    a.onerror = () => setState('failed');
    a.play().then(
      () => setState('playing'),
      () => setState('failed'),
    );
  };

  const toggle = () => {
    if (state === 'playing') {
      audio.current?.pause();
      setState('idle');
      return;
    }
    if (url) {
      play(url);
      return;
    }
    if (!voice.path) return;
    setState('loading');
    voiceUrl(voice.path).then(
      (u) => {
        setUrl(u);
        play(u);
      },
      () => setState('failed'),
    );
  };

  return (
    <button type="button" className={className} onClick={toggle} aria-pressed={state === 'playing'}>
      {state === 'loading' ? <LoaderCircle className="spin" aria-hidden="true" /> : state === 'playing' ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
      <span>{state === 'playing' ? t.stop : state === 'failed' ? t.failed : t.play(voice.seconds)}</span>
    </button>
  );
}
