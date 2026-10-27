// localStorage can be unavailable (private browsing, storage blocked), so every
// access is guarded and the app keeps working without it.

export function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: not fatal */
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export const keys = {
  lastUser: 'mx:last-user',
  snapshot: (userId: string) => `mx:snapshot:${userId}`,
  outbox: (userId: string) => `mx:outbox:${userId}`,
  theme: 'mx:theme',
  /** Language for the sign-in screen: Arabic once Mom has used this device. */
  lang: 'mx:lang',
  pushWanted: 'mx:push-wanted',
  dismissedPushCard: 'mx:dismissed-push-card',
};
