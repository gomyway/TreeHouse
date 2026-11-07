// Game storage on R2 (binding GAMES). A bundle is two objects, `<id>/meta.json` and `<id>/tv.html`.
// GET /games lists the bucket itself (every `<id>/meta.json`), so authored bundles (/author) and
// pre-built ones from ../games (scripts/publish-games.mjs, or PUT /games/:id) show up alike. The
// hand-written sample bundle (../games/sample) is also compiled into the Worker, so GET
// /games/sample/* and the listing work against an empty bucket. Contract: ../../PLAN.md "Game bundle".
import sampleMeta from "../games/sample/meta.json";
import sampleTv from "../games/sample/tv.html"; // wrangler imports .html as text

export const SAMPLE = { meta: sampleMeta, tv: sampleTv };
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
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

// Every `<id>/meta.json` in the bucket, newest createdAt first (missing createdAt sorts last).
// Other keys (jobs/*, a stale index.json, tv.html) are skipped. Tens of games: one GET each is fine.
export async function listGames(env) {
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
  }))).filter(Boolean);
  const t = (m) => { const v = Date.parse(m.createdAt); return Number.isNaN(v) ? -Infinity : v; };
  metas.sort((a, b) => t(b) - t(a));
  if (!metas.some((m) => m.id === "sample")) metas.push(SAMPLE.meta); // compiled-in sample, always last
  return metas;
}

export async function putGame(env, meta, tv) {
  await env.GAMES.put(`${meta.id}/tv.html`, tv, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  await env.GAMES.put(`${meta.id}/meta.json`, JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
}

// Checks a pre-built bundle's meta (same rules as scripts/publish-games.mjs). Returns an error list.
export function checkMeta(meta, id) {
  const e = [];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return ["meta must be an object"];
  if (meta.id !== id) e.push(`meta.id ${JSON.stringify(meta.id)} must equal ${JSON.stringify(id)}`);
  for (const k of ["title", "description"]) if (typeof meta[k] !== "string" || !meta[k].trim()) e.push(`${k} missing`);
  if (!Array.isArray(meta.phases) || !meta.phases.length) e.push("phases missing");
  if (!Number.isInteger(meta.minPlayers) || meta.minPlayers < 1) e.push("minPlayers missing");
  return e;
}

// PUT /games/:id {meta, html}: publish a pre-built bundle over HTTP. Enabled only when the
// PUBLISH_TOKEN var/secret is set, and the request must carry it in `x-publish-token`.
async function publish(req, env, id) {
  const token = env.PUBLISH_TOKEN;
  if (!token) return cjson({ error: "not found" }, 404);
  if (req.headers.get("x-publish-token") !== token) return cjson({ error: "bad publish token" }, 403);
  let body;
  try { body = await req.json(); } catch { return cjson({ error: "body must be JSON {meta, html}" }, 400); }
  const meta = body?.meta, html = body?.html;
  const errors = checkMeta(meta, id);
  if (typeof html !== "string" || !html.trim()) errors.push("html missing");
  if (errors.length) return cjson({ error: errors.join("; ") }, 400);
  const stored = { ...meta, createdAt: meta.createdAt || new Date().toISOString() };
  await putGame(env, stored, html);
  return cjson({ id, meta: stored });
}

// GET /games, /games/:id/meta.json, /games/:id/tv.html; PUT /games/:id (see publish)
export async function handleGames(req, env, url) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const parts = url.pathname.split("/").filter(Boolean); // ["games", id?, file?]
  if (req.method === "PUT" && parts.length === 2 && ID_RE.test(parts[1])) return publish(req, env, parts[1]);
  if (req.method !== "GET" && req.method !== "HEAD") return cjson({ error: "method not allowed" }, 405);
  if (parts.length === 1) return cjson(await listGames(env));
  const [, id, file] = parts;
  if (parts.length !== 3 || !ID_RE.test(id) || (file !== "meta.json" && file !== "tv.html")) return cjson({ error: "not found" }, 404);

  const obj = await env.GAMES.get(`${id}/${file}`);
  let body = obj ? await obj.text() : null;
  if (body === null && id === "sample") body = file === "tv.html" ? SAMPLE.tv : JSON.stringify(SAMPLE.meta);
  if (body === null) return cjson({ error: "no such game" }, 404);
  if (file === "meta.json") return new Response(body, { headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": TV_CSP, ...CORS },
  });
}
