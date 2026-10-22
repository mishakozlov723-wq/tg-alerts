// Compatibility export from the earlier draft. The Cloudflare runtime now uses
// local SQLite only; no external Redis/Upstash connection or credentials exist.
export { createLocalStore, emptyMain, validateMain } from './storage.mjs'
