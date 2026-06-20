/// <reference types="vite/client" />

// Per-instance build-time env vars (see .env.example at repo root).
interface ImportMetaEnv {
  /** Override the IndexedDB name — lets an isolated dev instance (e.g. a
   *  worktree under review) avoid clashing with the real "videoaudiosync" DB.
   *  Unset in production → canonical name. */
  readonly VITE_DB_NAME?: string;
  readonly VITE_IMPRESSUM_NAME?: string;
  readonly VITE_IMPRESSUM_ADDRESS_LINE_1?: string;
  readonly VITE_IMPRESSUM_ADDRESS_LINE_2?: string;
  readonly VITE_IMPRESSUM_COUNTRY?: string;
  readonly VITE_IMPRESSUM_EMAIL?: string;
  readonly VITE_DSGVO_AUTHORITY_NAME?: string;
  readonly VITE_DSGVO_AUTHORITY_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Vite-specific URL helpers — these aren't real npm modules, the suffixes
// are interpreted by the Vite plugin chain at build time.
declare module "*?worker&url" {
  const url: string;
  export default url;
}
declare module "*?url" {
  const url: string;
  export default url;
}
declare module "@ffmpeg/ffmpeg/worker?worker&url" {
  const url: string;
  export default url;
}
declare module "jassub/dist/worker/worker.js?worker&url" {
  const url: string;
  export default url;
}
declare module "jassub/dist/wasm/jassub-worker.wasm?url" {
  const url: string;
  export default url;
}
declare module "jassub/dist/wasm/jassub-worker-modern.wasm?url" {
  const url: string;
  export default url;
}
declare module "jassub/dist/default.woff2?url" {
  const url: string;
  export default url;
}
