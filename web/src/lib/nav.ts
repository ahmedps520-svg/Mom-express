// Lets code outside React components (live events, toasts, notification taps)
// navigate with the router.

type NavigateFn = (to: string) => void;
let navigateFn: NavigateFn = (to) => window.location.assign(to);

export function setNavigate(fn: NavigateFn): void {
  navigateFn = fn;
}

export function go(to: string): void {
  navigateFn(to);
}
