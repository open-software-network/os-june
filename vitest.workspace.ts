// Vitest projects: the app frontend (vite.config.ts, jsdom, src/test/**) and
// the browser extension package (extension/vite.config.ts, node env). One
// root `pnpm test` gates both.
export default ["./vite.config.ts", "./extension/vite.config.ts"];
