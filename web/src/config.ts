// Where the app's data lives (set in vite.config.ts). The publishable key is
// meant to be public: every table is closed to it, and the app's database
// functions check who is signed in.
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
export const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY;

/** Accounts sign in with a username; Supabase Auth stores it as this made-up address. */
export const usernameEmail = (username: string) => `${username.trim().toLowerCase()}@momexpress.invalid`;

/** The path the app is served from, e.g. "/" or "/Mom-express/". */
export const BASE = import.meta.env.BASE_URL;

/** Turns an app path like "/requests/4" into a full path under BASE. */
export const withBase = (path: string) => BASE.replace(/\/$/, '') + path;
