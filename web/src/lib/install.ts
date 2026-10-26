import { create } from 'zustand';
import { isIos, isStandalone } from './push';

// Tracks whether the app can be installed, using the browser's install prompt
// where it offers one (Chrome, Edge, Android). Safari has no prompt; the
// settings page explains Add to Home Screen instead.

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface InstallState {
  installed: boolean;
  canPrompt: boolean;
}

let deferred: BeforeInstallPromptEvent | null = null;

export const useInstall = create<InstallState>()(() => ({ installed: false, canPrompt: false }));

export function initInstallTracking(): void {
  useInstall.setState({ installed: isStandalone() });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    useInstall.setState({ canPrompt: true });
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    useInstall.setState({ installed: true, canPrompt: false });
  });
  window.matchMedia('(display-mode: standalone)').addEventListener('change', (e) => {
    useInstall.setState({ installed: e.matches });
  });
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferred) return 'unavailable';
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  useInstall.setState({ canPrompt: false });
  return outcome;
}

export function installHelp(): string {
  if (isIos()) return 'In Safari, tap the Share button, then “Add to Home Screen”.';
  if (/Android/i.test(navigator.userAgent)) return 'Open your browser menu (⋮) and choose “Install app” or “Add to Home screen”.';
  return 'Use your browser’s menu or the install icon in the address bar to install MomExpress.';
}
