// Lets code outside React components (live events, toasts, notification taps)
// navigate with the router.

import { withBase } from '../config';

type NavigateFn = (to: string) => void;
let navigateFn: NavigateFn = (to) => window.location.assign(withBase(to));

export function setNavigate(fn: NavigateFn): void {
  navigateFn = fn;
}

export function go(to: string): void {
  navigateFn(to);
}
