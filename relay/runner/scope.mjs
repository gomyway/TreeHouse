// Game scope decision for an authored bundle (PLAN.md "Game scope"). Pure, so test/scope.mjs can
// check it without a relay. A game is per TV ("tv") when it may carry details about specific people:
// the TV sent its tvId, or a Room memory block with real history went into TASK.md, or the job's
// context.players carries guids. Otherwise it is global. Rules mirror checkMeta in ../src/games.mjs.

const TVID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const GUID_RE = /^[A-Za-z0-9-]{8,64}$/; // same as GUID_RE in ../src/memories.mjs
const MAX_CREW = 24;
export const UNKNOWN_TV = "unknown-tv";

// → { scope: "global" } or { scope: "tv", tvId, crew, note? }. `note` explains a fallback tvId.
export function decideScope(context, memoryInjected = false) {
  const ctx = context && typeof context === "object" ? context : {};
  const players = Array.isArray(ctx.players) ? ctx.players : [];
  const crew = [...new Set(players.map((p) => p?.guid).filter((g) => typeof g === "string" && GUID_RE.test(g)))].sort().slice(0, MAX_CREW);
  const sentTv = typeof ctx.tvId === "string";
  if (!sentTv && !memoryInjected && !crew.length) return { scope: "global" };
  let tvId = sentTv ? ctx.tvId.trim() : "", note;
  if (sentTv && !TVID_RE.test(tvId)) {
    const clean = tvId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
    note = `context.tvId ${JSON.stringify(ctx.tvId.slice(0, 80))} is not a valid tvId; using ${JSON.stringify(clean || UNKNOWN_TV)}`;
    tvId = clean;
  }
  if (!tvId) {
    // No tvId: the TV could not list or load a tv-scoped bundle, so publish it global and say so.
    // (Memory-seeded text then stays visible to every TV until the host sends context.tvId.)
    return { scope: "global", crew, note: note ?? `no context.tvId sent; publishing global (memory-seeded: ${memoryInjected}, crew ${crew.length})` };
  }
  return { scope: "tv", tvId, crew, ...(note ? { note } : {}) };
}

// Applies a decision to a meta object (mutates and returns it).
export function applyScope(meta, d) {
  delete meta.scope; delete meta.tvId; delete meta.crew;
  if (d.scope === "tv") Object.assign(meta, { scope: "tv", tvId: d.tvId, crew: d.crew });
  else meta.scope = "global";
  return meta;
}
