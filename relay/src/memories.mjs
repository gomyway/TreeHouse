// Memories on R2 (binding GAMES, prefix memories/). The TV posts a finished game's moments (the same
// shapes as its memory book, tv/src/game/memories.ts, plus guids); the Worker files them per game,
// per player guid and per crew (the sorted guids of everyone in the room), and reads them back for
// the host and for the authoring runner's "Room memory" block. Contract: ../../PLAN.md "Memories";
// types: ../../shared/protocol.ts (Moment, ClipFrame, GameResult, MemoriesResponse).
//
//   POST   /memories          { tvId?, room, hostToken, game, at, moments, result?, players? } → 200 counts
//   GET    /memories?guids=a,b,c → MemoriesResponse
//   GET    /memories/:guid    → that guid's index (debug), 404 if none
//   DELETE /memories/:guid    → forget that guid (index deleted, crew files deleted, games and
//                               co-players' indexes scrubbed), 200 counts
//
// Layout: memories/game/<room>-<at>.json (the whole post, clips kept), memories/guid/<guid>.json,
// memories/crew/<sha256 hex of sorted guids joined by ",">.json. Read-modify-write without locks:
// two posts at the same instant for the same guid can lose one update (best effort).

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};
const cjson = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });

export const GUID_RE = /^[A-Za-z0-9-]{8,64}$/; // same rule the relay applies to Player.guid
const CODE_RE = /^[A-HJ-NP-Z]{4}$/;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_POST_MOMENTS = 100;
const IDX_MOMENTS = 60, IDX_RESULTS = 30, IDX_AWARDS = 30, IDX_NAMES = 10, IDX_GAMES = 60;
const OUT_MOMENTS = 10, OUT_RESULTS = 5, OUT_NAMES = 5, PAIR_SCAN = 6;

const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const guids = (v) => (Array.isArray(v) ? v.filter((g) => typeof g === "string" && GUID_RE.test(g)) : []);
const crewOf = (list) => [...new Set(list)].sort();

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const crewKey = async (crew) => `memories/crew/${await sha256(crewOf(crew).join(","))}.json`;
const guidKey = (g) => `memories/guid/${g}.json`;

async function getJson(env, key) {
  try { return (await (await env.GAMES.get(key))?.json()) ?? null; } catch { return null; }
}
const putJson = (env, key, v) => env.GAMES.put(key, JSON.stringify(v), { httpMetadata: { contentType: "application/json" } });

// ---- shapes ----
function cleanClip(clip) {
  if (!Array.isArray(clip)) return undefined;
  const frames = clip.filter((f) => f && typeof f.t === "number" && Array.isArray(f.people)).slice(0, 300).map((f) => ({
    t: f.t,
    people: f.people.filter((p) => p && typeof p.n === "number" && Array.isArray(p.pts)).slice(0, 4)
      .map((p) => ({ n: p.n, pts: p.pts.slice(0, 34).map((x) => (typeof x === "number" ? x : -1)) })),
  }));
  return frames.length ? frames : undefined;
}

function cleanMoment(m, ctx) {
  if (!m || typeof m !== "object") return null;
  const title = str(m.title, 120);
  if (!title) return null;
  const out = {
    id: str(m.id, 40) ?? `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: num(m.at) ?? ctx.at,
    game: str(m.game, 80) ?? ctx.game,
    title,
  };
  const caption = str(m.caption, 200); if (caption) out.caption = caption;
  if (Array.isArray(m.players)) {
    const players = m.players.slice(0, 6).map((p) => (typeof p === "string" ? p.slice(0, 24) : ""));
    out.players = players;
    if (Array.isArray(m.playerGuids)) // parallel to players: keep the index alignment, "" for unknown
      out.playerGuids = players.map((_, i) => (typeof m.playerGuids[i] === "string" && GUID_RE.test(m.playerGuids[i]) ? m.playerGuids[i] : ""));
  }
  const kind = str(m.kind, 20); if (kind) out.kind = kind;
  out.crew = guids(m.crew).length ? crewOf(guids(m.crew)) : ctx.crew;
  out.room = ctx.room;
  const clip = cleanClip(m.clip); if (clip) out.clip = clip;
  return out;
}

function cleanResult(r, ctx) {
  if (!r || typeof r !== "object") return null;
  const scores = {};
  if (r.scores && typeof r.scores === "object") for (const [k, v] of Object.entries(r.scores).slice(0, 24)) if (num(v) !== undefined) scores[String(k).slice(0, 24)] = v;
  const out = { at: num(r.at) ?? ctx.at, game: str(r.game, 80) ?? ctx.game, scores };
  const winner = str(r.winner, 24); if (winner) out.winner = winner;
  if (typeof r.winnerGuid === "string" && GUID_RE.test(r.winnerGuid)) out.winnerGuid = r.winnerGuid;
  if (r.scoresByGuid && typeof r.scoresByGuid === "object") {
    const sbg = {};
    for (const [k, v] of Object.entries(r.scoresByGuid).slice(0, 24)) if (GUID_RE.test(k) && num(v) !== undefined) sbg[k] = v;
    if (Object.keys(sbg).length) out.scoresByGuid = sbg;
  }
  out.crew = guids(r.crew).length ? crewOf(guids(r.crew)) : ctx.crew;
  out.room = ctx.room;
  return out;
}

const compact = (m) => { const { clip, ...rest } = m; return rest; };
const momentGuids = (m) => (m.playerGuids ?? []).filter(Boolean);
const resultGuids = (r) => new Set([...(r.crew ?? []), ...Object.keys(r.scoresByGuid ?? {}), ...(r.winnerGuid ? [r.winnerGuid] : [])]);
const newestFirst = (a, b) => (b.at ?? 0) - (a.at ?? 0);
const mergeById = (fresh, old, cap) => {
  const ids = new Set(fresh.map((m) => m.id));
  return [...fresh, ...old.filter((m) => !ids.has(m.id))].sort(newestFirst).slice(0, cap);
};
const mergeResults = (fresh, old, cap) => {
  const k = (r) => `${r.room ?? ""}-${r.at}-${r.game}`;
  const ks = new Set(fresh.map(k));
  return [...fresh, ...old.filter((r) => !ks.has(k(r)))].sort(newestFirst).slice(0, cap);
};

// ---- auth: ask the room's Durable Object ----
async function hostOk(env, room, token) {
  try {
    const res = await env.ROOM.get(env.ROOM.idFromName(room)).fetch(new Request(`https://room/verify-token?token=${encodeURIComponent(token)}`));
    return res.ok && (await res.json()).hostOk === true;
  } catch { return false; }
}

// ---- POST ----
async function post(req, env) {
  const raw = await req.text();
  if (raw.length > MAX_BODY) return cjson({ error: "body too large" }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return cjson({ error: "body must be JSON" }, 400); }
  const room = String(body?.room ?? "").toUpperCase();
  const at = num(body?.at), game = str(body?.game, 80);
  if (!CODE_RE.test(room)) return cjson({ error: "room must be a 4-letter code" }, 400);
  if (typeof body.hostToken !== "string" || !body.hostToken) return cjson({ error: "hostToken missing" }, 400);
  if (at === undefined || !game) return cjson({ error: "game and at are required" }, 400);
  if (!Array.isArray(body.moments)) return cjson({ error: "moments must be an array" }, 400);
  if (!(await hostOk(env, room, body.hostToken))) return cjson({ error: "bad host token for this room" }, 403);

  // The room's crew: the first moment/result crew given, else every guid that appears.
  const named = Array.isArray(body.players) ? body.players.filter((p) => p && GUID_RE.test(p.guid ?? "") && str(p.name, 24)) : [];
  const given = [body.crew, body.result?.crew, ...body.moments.map((m) => m?.crew)].map(guids).find((l) => l.length);
  const crew = crewOf(given ?? [...named.map((p) => p.guid), ...body.moments.flatMap((m) => guids(m?.playerGuids)), ...guids(Object.keys(body.result?.scoresByGuid ?? {}))]);
  const ctx = { room, at, game, crew };
  const moments = body.moments.slice(0, MAX_POST_MOMENTS).map((m) => cleanMoment(m, ctx)).filter(Boolean).sort(newestFirst);
  const result = body.result ? cleanResult(body.result, ctx) : null;
  const tvId = str(body.tvId, 80);
  const gameKey = `memories/game/${room}-${at}.json`;
  // Display names by guid for this game: explicit players, then the moments' parallel lists.
  const names = {};
  for (const p of named) names[p.guid] = p.name.trim().slice(0, 24);
  for (const m of moments) (m.playerGuids ?? []).forEach((g, i) => { if (g && m.players[i] && !names[g]) names[g] = m.players[i]; });
  const gameDoc = { ...(tvId ? { tvId } : {}), room, game, at, crew, players: Object.entries(names).map(([guid, name]) => ({ guid, name })), moments, ...(result ? { result } : {}) };
  await putJson(env, gameKey, gameDoc);

  const all = new Set([...crew, ...moments.flatMap(momentGuids), ...(result ? resultGuids(result) : [])]);
  const cKey = crew.length >= 2 ? await crewKey(crew) : null;
  await Promise.all([...all].map(async (g) => {
    const idx = (await getJson(env, guidKey(g))) ?? { guid: g, names: [], games: 0, lastSeen: 0, gameKeys: [], crewKeys: [], awards: [], moments: [], results: [] };
    const isNew = !idx.gameKeys.includes(gameKey);
    if (isNew) { idx.games += 1; idx.gameKeys = [gameKey, ...idx.gameKeys].slice(0, IDX_GAMES); }
    if (cKey && !idx.crewKeys.includes(cKey)) idx.crewKeys = [cKey, ...idx.crewKeys].slice(0, IDX_GAMES);
    idx.lastSeen = Math.max(idx.lastSeen, at);
    if (names[g]) idx.names = [names[g], ...idx.names.filter((n) => n !== names[g])].slice(0, IDX_NAMES);
    // A moment with nobody resolved (no playerGuids) belongs to the whole room.
    const mine = moments.filter((m) => momentGuids(m).includes(g) || (!momentGuids(m).length && crew.includes(g))).map(compact);
    idx.moments = mergeById(mine, idx.moments, IDX_MOMENTS);
    const awards = mine.filter((m) => m.kind === "award").map((m) => ({ id: m.id, title: m.title, game: m.game, at: m.at }));
    idx.awards = mergeById(awards, idx.awards, IDX_AWARDS);
    if (result && resultGuids(result).has(g)) idx.results = mergeResults([result], idx.results, IDX_RESULTS);
    await putJson(env, guidKey(g), idx);
  }));

  if (cKey) {
    const c = (await getJson(env, cKey)) ?? { guids: crew, games: 0, gameKeys: [], moments: [], results: [] };
    if (!c.gameKeys.includes(gameKey)) { c.games += 1; c.gameKeys = [gameKey, ...c.gameKeys].slice(0, IDX_GAMES); }
    c.moments = mergeById(moments.map(compact), c.moments, IDX_MOMENTS);
    if (result) c.results = mergeResults([result], c.results, IDX_RESULTS);
    await putJson(env, cKey, c);
  }
  return cjson({ ok: true, game: gameKey, moments: moments.length, clips: moments.filter((m) => m.clip).length, players: all.size, crew: cKey ? crew.length : 0 });
}

// ---- GET ?guids= ----
async function query(env, list) {
  const gs = [...new Set(list.split(",").map((s) => s.trim()).filter((g) => GUID_RE.test(g)))].slice(0, 24);
  const players = {};
  await Promise.all(gs.map(async (g) => {
    const idx = await getJson(env, guidKey(g));
    if (!idx) return;
    players[g] = {
      names: idx.names.slice(0, OUT_NAMES), games: idx.games, lastSeen: idx.lastSeen,
      awards: idx.awards.map(({ title, game, at }) => ({ title, game, at })),
      moments: idx.moments.slice(0, OUT_MOMENTS), results: idx.results.slice(0, OUT_RESULTS),
    };
  }));
  const known = gs.filter((g) => players[g]);
  const sets = new Map();
  const add = (s) => { const c = crewOf(s); if (c.length >= 2) sets.set(c.join(","), c); };
  add(known);
  const scan = known.slice(0, PAIR_SCAN);
  for (let i = 0; i < scan.length; i++) for (let j = i + 1; j < scan.length; j++) add([scan[i], scan[j]]);
  const crews = (await Promise.all([...sets.values()].map(async (s) => {
    const c = await getJson(env, await crewKey(s));
    return c ? { guids: s, games: c.games, moments: c.moments.slice(0, OUT_MOMENTS) } : null;
  }))).filter(Boolean).sort((a, b) => b.guids.length - a.guids.length);
  return { players, crews };
}

// ---- DELETE /memories/:guid ----
function scrubMoment(m, g) {
  const out = { ...m };
  if (Array.isArray(m.playerGuids)) {
    const keep = m.playerGuids.map((x) => x !== g);
    out.playerGuids = m.playerGuids.filter((_, i) => keep[i]);
    if (Array.isArray(m.players)) out.players = m.players.filter((_, i) => keep[i]);
  }
  if (Array.isArray(m.crew)) out.crew = m.crew.filter((x) => x !== g);
  return out;
}
function scrubResult(r, g, names) {
  const out = { ...r, scores: { ...r.scores } };
  if (Array.isArray(r.crew)) out.crew = r.crew.filter((x) => x !== g);
  if (r.scoresByGuid) { out.scoresByGuid = { ...r.scoresByGuid }; delete out.scoresByGuid[g]; }
  for (const n of names) delete out.scores[n];
  if (r.winnerGuid === g || (r.winner && names.has(r.winner) && !r.winnerGuid)) { delete out.winner; delete out.winnerGuid; }
  return out;
}

async function forget(env, g) {
  const idx = await getJson(env, guidKey(g));
  if (!idx) return cjson({ error: "no memories for this guid" }, 404);
  const counts = { guid: 1, games: 0, crews: 0, players: 0 };
  const others = new Set(), allNames = new Set();
  for (const key of idx.gameKeys.slice(0, IDX_GAMES)) {
    const doc = await getJson(env, key);
    if (!doc) continue;
    const names = new Set((doc.players ?? []).filter((p) => p.guid === g).map((p) => p.name));
    for (const m of doc.moments ?? []) (m.playerGuids ?? []).forEach((x, i) => { if (x === g && m.players?.[i]) names.add(m.players[i]); });
    for (const x of doc.crew ?? []) if (x !== g) others.add(x);
    doc.crew = (doc.crew ?? []).filter((x) => x !== g);
    doc.players = (doc.players ?? []).filter((p) => p.guid !== g);
    doc.moments = (doc.moments ?? []).map((m) => scrubMoment(m, g));
    if (doc.result) doc.result = scrubResult(doc.result, g, names);
    await putJson(env, key, doc);
    counts.games++;
    for (const n of names) allNames.add(n);
  }
  // A crew file is "this exact group", keyed by a hash that includes g: delete it outright.
  for (const key of idx.crewKeys ?? []) { if (await env.GAMES.head(key)) { await env.GAMES.delete(key); counts.crews++; } }
  // Co-players' indexes hold compact copies naming g: scrub them too (capped).
  for (const o of [...others].slice(0, 60)) {
    const oi = await getJson(env, guidKey(o));
    if (!oi) continue;
    oi.moments = oi.moments.map((m) => scrubMoment(m, g));
    oi.results = oi.results.map((r) => scrubResult(r, g, allNames));
    oi.crewKeys = (oi.crewKeys ?? []).filter((k) => !(idx.crewKeys ?? []).includes(k));
    await putJson(env, guidKey(o), oi);
    counts.players++;
  }
  await env.GAMES.delete(guidKey(g));
  return cjson({ ok: true, deleted: counts });
}

export async function handleMemories(req, env, url) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const parts = url.pathname.split("/").filter(Boolean); // ["memories", guid?]
  if (parts.length === 1) {
    if (req.method === "POST") return post(req, env);
    if (req.method === "GET") return cjson(await query(env, url.searchParams.get("guids") ?? ""));
    return cjson({ error: "method not allowed" }, 405);
  }
  const g = parts[1];
  if (parts.length !== 2 || !GUID_RE.test(g)) return cjson({ error: "not found" }, 404);
  if (req.method === "DELETE") return forget(env, g);
  if (req.method === "GET") {
    const idx = await getJson(env, guidKey(g));
    return idx ? cjson(idx) : cjson({ error: "no memories for this guid" }, 404);
  }
  return cjson({ error: "method not allowed" }, 405);
}
