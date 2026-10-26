import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useApp } from '../store/app';

/** The current server time, re-rendering every `intervalMs`. Ticks only on this component. */
export function useServerNow(intervalMs = 1000): number {
  const offset = useApp((s) => s.clockOffset);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now + offset;
}

/** The previous value of something, to spot changes (e.g. a status that just changed). */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  const prev = ref.current;
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return prev;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    onChange();
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Sets the browser tab title while a page is shown. */
export function useTitle(title: string): void {
  const unread = useApp((s) => s.unreadCount);
  useEffect(() => {
    document.title = `${unread > 0 ? `(${unread}) ` : ''}${title} · MomExpress`;
  }, [title, unread]);
}

/**
 * Goes back within the app, or to `fallback` when this page was opened
 * directly (e.g. from a notification) and there's nothing to go back to.
 */
export function useBack(fallback = '/'): () => void {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(() => {
    if (location.key !== 'default') navigate(-1);
    else navigate(fallback, { replace: true });
  }, [navigate, location.key, fallback]);
}
