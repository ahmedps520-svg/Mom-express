declare const __BUILD_ID__: string;
declare const __APP_VERSION__: string;
declare const __BUILT_AT__: string;

interface ImportMetaEnv {
  readonly BASE_URL: string;
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.css';
