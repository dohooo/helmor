// Register the build-time plugins as runtime plugins so `bun run src/index.ts`
// (dev mode + tests) sees the same module rewrites as `bun build --compile`.
// Wired into bunfig.toml's `preload` so plugins are active before any user
// import resolves.

import { inlineCursorSdkChunk } from "./inline-cursor-sdk-chunk.ts";
import { redirectSqlite3 } from "./redirect-sqlite3.ts";

Bun.plugin(redirectSqlite3);
Bun.plugin(inlineCursorSdkChunk);
