/// <reference types="vite/client" />

// Declared explicitly rather than relying on the index signature, so a typo in
// a variable name is a build error instead of a silent undefined at runtime.
interface ImportMetaEnv {
  /** API base URL. Falls back to the Vite proxy locally, then the deployed API. */
  readonly VITE_API_URL?: string;
  /** Sent as x-api-key on writes. Absent means the dashboard is read-only. */
  readonly VITE_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
