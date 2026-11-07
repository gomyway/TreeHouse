// Game storage on R2 (binding GAMES). A bundle is two objects, `<id>/meta.json` and `<id>/tv.html`,
// plus one `index.json` holding every meta, newest first. Only /author writes. The hand-written
// sample bundle (../games/sample) is compiled into the Worker, so GET /games/sample/* and the
// listing work against an empty bucket. Contract: ../../PLAN.md "Game bundle".
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

async function readIndex(env) {
  const obj = await env.GAMES.get("index.json");
  if (!obj) return [];
  try { const list = await obj.json(); return Array.isArray(list) ? list : []; } catch { return []; }
}

export async function listGames(env) {
  const list = (await readIndex(env)).filter((m) => m.id !== "sample");
  return [...list, SAMPLE.meta]; // the sample is always last
}

export async function putGame(env, meta, tv) {
  await env.GAMES.put(`${meta.id}/tv.html`, tv, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  await env.GAMES.put(`${meta.id}/meta.json`, JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
  // Read-modify-write: two authors finishing in the same instant can drop one index line (the
  // bundle itself stays fetchable by id). Fine at hackathon scale.
  const list = (await readIndex(env)).filter((m) => m.id !== meta.id);
  await env.GAMES.put("index.json", JSON.stringify([meta, ...list].slice(0, 500)), { httpMetadata: { contentType: "application/json" } });
}

// GET /games, /games/:id/meta.json, /games/:id/tv.html
export async function handleGames(req, env, url) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET" && req.method !== "HEAD") return cjson({ error: "method not allowed" }, 405);
  const parts = url.pathname.split("/").filter(Boolean); // ["games", id?, file?]
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
