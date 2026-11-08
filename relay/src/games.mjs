// Game storage on R2 (binding GAMES). A bundle is `<id>/meta.json`, `<id>/tv.html` and, when the game
// ships a lobby card (PLAN.md "Lobby card"), `<id>/lobby.html`; meta.lobby is true exactly when it does.
// GET /games lists the bucket itself (every `<id>/meta.json`), so authored bundles (/author) and
// pre-built ones from ../games (scripts/publish-games.mjs, or PUT /games/:id) show up alike. The
// hand-written sample bundle (../games/sample) is also compiled into the Worker, so GET
// /games/sample/* and the listing work against an empty bucket. Contract: ../../PLAN.md "Game bundle".
// Scope (PLAN.md "Game scope"): meta.scope "global" (or absent) is listed and served to every TV;
// "tv" bundles (authored with Room memory) only with ?tv=<meta.tvId>, else they are absent / 404.
import { GUID_RE } from "./memories.mjs";
import sampleMeta from "../games/sample/meta.json";
import sampleTv from "../games/sample/tv.html"; // wrangler imports .html as text
import sampleLobby from "../games/sample/lobby.html";

export const SAMPLE = { meta: sampleMeta, tv: sampleTv, lobby: sampleLobby };
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const TVID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const SCOPES = ["global", "tv"];
const MAX_CREW = 24;
export const MAX_PLAYERS = 16; // per game; the runner and /author clamp an agent-written maxPlayers above it
export const MAX_LOBBY_CHARS = 256 * 1024;
const FILES = new Set(["meta.json", "tv.html", "lobby.html"]);

// Whether a bundle may be listed / served to the TV `tv` (a valid tvId or null).
export function visibleTo(meta, tv) {
  const scope = meta?.scope ?? "global";
  if (scope === "global") return true;
  return scope === "tv" && !!tv && meta.tvId === tv;
}
// The ?tv= parameter, or null when absent or not a valid tvId.
const tvParam = (url) => { const t = url.searchParams.get("tv"); return t && TVID_RE.test(t) ? t : null; };
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};
export const cjson = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });

// Bundles run in a sandboxed iframe; this CSP backs up "no network" when the TV loads by URL.
const TV_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:";

export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

const META_KEY_RE = /^([a-z0-9][a-z0-9-]{0,39})\/meta\.json$/;

// Every `<id>/meta.json` in the bucket visible to `tv` (global ones, plus that TV's own when tv is
// given), newest createdAt first (missing createdAt sorts last). Other keys (jobs/*, a stale
// index.json, tv.html) are skipped. Tens of games: one GET each is fine.
export async function listGames(env, tv = null) {
  const keys = [];
  let cursor;
  do {
    const page = await env.GAMES.list({ cursor, limit: 1000 });
    for (const o of page.objects) if (META_KEY_RE.test(o.key)) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const metas = (await Promise.all(keys.map(async (key) => {
    try {
      const m = await (await env.GAMES.get(key))?.json();
      return m && typeof m === "object" && m.id === key.match(META_KEY_RE)[1] ? m : null;
    } catch { return null; }
  }))).filter((m) => m && visibleTo(m, tv));
  const t = (m) => { const v = Date.parse(m.createdAt); return Number.isNaN(v) ? -Infinity : v; };
  metas.sort((a, b) => t(b) - t(a));
  if (!metas.some((m) => m.id === "sample")) metas.push(SAMPLE.meta); // compiled-in sample, always last
  return metas.map((m) => ({ ...m, lobby: m.lobby === true })); // meta.lobby is written with the file, so no HEAD per game
}

// Stores a bundle: tv.html, then lobby.html (or removes a stale one), then meta.json last, so a listed
// meta always has its files. meta.lobby is set from whether a lobby card came with it. Returns the meta stored.
export async function putGame(env, meta, tv, lobby = null) {
  const html = { httpMetadata: { contentType: "text/html; charset=utf-8" } };
  const stored = { ...meta, lobby: typeof lobby === "string" };
  await env.GAMES.put(`${meta.id}/tv.html`, tv, html);
  if (stored.lobby) await env.GAMES.put(`${meta.id}/lobby.html`, lobby, html);
  else await env.GAMES.delete(`${meta.id}/lobby.html`);
  await env.GAMES.put(`${meta.id}/meta.json`, JSON.stringify(stored), { httpMetadata: { contentType: "application/json" } });
  return stored;
}

// Checks a lobby card (PLAN.md "Lobby card"): a self-contained html document, no network. Returns an error list.
export function checkLobby(lobby) {
  if (typeof lobby !== "string" || !lobby.trim()) return ["lobby must be a non-empty html string"];
  const e = [];
  if (lobby.length > MAX_LOBBY_CHARS) e.push(`lobby is ${Math.round(lobby.length / 1024)} KB; the cap is ${MAX_LOBBY_CHARS / 1024} KB`);
  if (!/<!doctype html|<html[\s>]/i.test(lobby)) e.push("lobby is not an html document (no <!doctype html> or <html>)");
  if (/<script\b[^>]*\bsrc\s*=/i.test(lobby)) e.push("lobby has a <script src>; inline all code");
  if (/<[a-z][^>]*?\s(?:xlink:)?(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i.test(lobby)) e.push("lobby loads an external resource; everything must be inline (data: URLs only)");
  if (/@import\b|url\(\s*["']?(?:https?:)?\/\//i.test(lobby)) e.push("lobby CSS loads an external resource (@import or url(http...))");
  if (/\b(fetch\s*\(|XMLHttpRequest|new\s+WebSocket|EventSource)/.test(lobby)) e.push("lobby uses the network (fetch/XHR/WebSocket/EventSource); it must not");
  return e;
}

// Checks a pre-built bundle's meta (same rules as scripts/publish-games.mjs). Returns an error list.
export function checkMeta(meta, id) {
  const e = [];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return ["meta must be an object"];
  if (meta.id !== id) e.push(`meta.id ${JSON.stringify(meta.id)} must equal ${JSON.stringify(id)}`);
  for (const k of ["title", "description"]) if (typeof meta[k] !== "string" || !meta[k].trim()) e.push(`${k} missing`);
  if (!Array.isArray(meta.phases) || !meta.phases.length) e.push("phases missing");
  if (!Number.isInteger(meta.minPlayers) || meta.minPlayers < 1) e.push("minPlayers missing");
  if (!Number.isInteger(meta.maxPlayers) || meta.maxPlayers > MAX_PLAYERS || (Number.isInteger(meta.minPlayers) && meta.maxPlayers < meta.minPlayers))
    e.push(`maxPlayers must be an integer with minPlayers <= maxPlayers <= ${MAX_PLAYERS}`);
  if (meta.scope !== undefined && !SCOPES.includes(meta.scope)) e.push(`scope must be "global" or "tv"`);
  if (meta.tvId !== undefined && (typeof meta.tvId !== "string" || !TVID_RE.test(meta.tvId))) e.push("tvId must be 1-64 chars of [A-Za-z0-9._-]");
  if (meta.scope === "tv" && meta.tvId === undefined) e.push(`scope "tv" needs tvId`);
  if (meta.crew !== undefined && (!Array.isArray(meta.crew) || meta.crew.length > MAX_CREW ||
    !meta.crew.every((g) => typeof g === "string" && GUID_RE.test(g)))) e.push(`crew must be an array of up to ${MAX_CREW} guids`);
  return e;
}

// PUT /games/:id {meta, html, lobby?}: publish a pre-built bundle over HTTP. Enabled only when the
// PUBLISH_TOKEN var/secret is set, and the request must carry it in `x-publish-token`.
async function publish(req, env, id) {
  const token = env.PUBLISH_TOKEN;
  if (!token) return cjson({ error: "not found" }, 404);
  if (req.headers.get("x-publish-token") !== token) return cjson({ error: "bad publish token" }, 403);
  let body;
  try { body = await req.json(); } catch { return cjson({ error: "body must be JSON {meta, html, lobby?}" }, 400); }
  const meta = body?.meta, html = body?.html, lobby = body?.lobby ?? null;
  const errors = checkMeta(meta, id);
  if (typeof html !== "string" || !html.trim()) errors.push("html missing");
  if (lobby !== null) errors.push(...checkLobby(lobby));
  if (errors.length) return cjson({ error: errors.join("; ") }, 400);
  const stored = await putGame(env, { ...meta, createdAt: meta.createdAt || new Date().toISOString() }, html, lobby);
  return cjson({ id, meta: stored });
}

// GET /games[?tv=<tvId>], /games/:id/meta.json[?tv=], /games/:id/tv.html[?tv=], /games/:id/lobby.html[?tv=];
// PUT /games/:id (see publish). lobby.html is 404 for a bundle without a lobby card. A tv-scoped bundle
// is listed and served only when ?tv= matches its tvId (all three files alike); otherwise 404, the same
// answer as an unknown id, so another TV cannot start it by guessing the id.
export async function handleGames(req, env, url) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const parts = url.pathname.split("/").filter(Boolean); // ["games", id?, file?]
  if (req.method === "PUT" && parts.length === 2 && ID_RE.test(parts[1])) return publish(req, env, parts[1]);
  if (req.method !== "GET" && req.method !== "HEAD") return cjson({ error: "method not allowed" }, 405);
  const tv = tvParam(url);
  if (parts.length === 1) return cjson(await listGames(env, tv));
  const [, id, file] = parts;
  if (parts.length !== 3 || !ID_RE.test(id) || !FILES.has(file)) return cjson({ error: "not found" }, 404);

  const [obj, metaObj] = await Promise.all([env.GAMES.get(`${id}/${file}`), file !== "meta.json" ? env.GAMES.get(`${id}/meta.json`) : null]);
  let body = obj ? await obj.text() : null;
  // Compiled-in sample when the bucket has none; a bucket sample published without a lobby card has none.
  if (body === null && id === "sample" && (file !== "lobby.html" || !metaObj)) body = file === "tv.html" ? SAMPLE.tv : file === "lobby.html" ? SAMPLE.lobby : JSON.stringify(SAMPLE.meta);
  if (body === null) return cjson({ error: "no such game" }, 404);
  let meta = null; // scope check; a bundle without a readable meta.json counts as global (as before)
  try { meta = JSON.parse(file === "meta.json" ? body : (metaObj ? await metaObj.text() : "null")); } catch {}
  if (!visibleTo(meta, tv)) return cjson({ error: "no such game" }, 404);
  // meta.lobby is the truth: a lobby.html left behind by a republish without a card is not served.
  if (file === "lobby.html" && metaObj && meta?.lobby !== true) return cjson({ error: "no lobby card for this game" }, 404);
  if (file === "meta.json") return new Response(body, { headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": TV_CSP, ...CORS },
  });
}
