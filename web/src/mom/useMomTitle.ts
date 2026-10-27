import { useEffect } from 'react';

/** Sets the window title while a page is shown. */
export function useMomTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · ماما إكسبريس`;
  }, [title]);
}
