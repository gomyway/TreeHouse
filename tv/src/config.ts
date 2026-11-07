// Where the relay Worker lives. One Worker serves the relay (/host, /join), game storage
// (/games) and authoring (/author). Override with VITE_RELAY_URL, e.g. ws://127.0.0.1:8787
// for `cd relay && pnpm dev`.
const DEFAULT_RELAY = "https://little-redwood-relay.nasloon.workers.dev";

const raw = ((import.meta.env.VITE_RELAY_URL as string | undefined) || DEFAULT_RELAY).replace(/\/+$/, "");

/** ws(s):// base for the relay sockets */
export const RELAY_WS = raw.replace(/^http/, "ws");
/** http(s):// base for /games and /author */
export const RELAY_HTTP = RELAY_WS.replace(/^ws/, "http");
