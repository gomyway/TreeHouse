// The "Room memory" block for TASK.md: what the relay remembers about the players an authoring job
// was created for (job.context.players: [{ id, name, guid? }]). Fetches GET /memories?guids=… with a
// 2 s timeout; any failure just means "no history" (the game must never depend on it).
// Shapes: ../../shared/protocol.ts MemoriesResponse; routes: ../src/memories.mjs.

export function contextPlayers(context) {
  const list = Array.isArray(context?.players) ? context.players : [];
  return list.filter((p) => p && typeof p.name === "string" && p.name.trim())
    .map((p) => ({ id: p.id, name: p.name.trim().slice(0, 24), ...(typeof p.guid === "string" && p.guid ? { guid: p.guid } : {}) }));
}

export async function fetchMemories(relay, players, timeoutMs = 2000) {
  const guids = [...new Set(players.map((p) => p.guid).filter(Boolean))];
  if (!guids.length) return null;
  try {
    const res = await fetch(`${relay}/memories?guids=${guids.map(encodeURIComponent).join(",")}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data === "object" ? data : null;
  } catch { return null; }
}

const line = (m) => `"${m.title}"${m.caption ? ` (${m.caption})` : ""}${m.game ? `, in ${m.game}` : ""}`;

// Markdown for TASK.md: the expected players, then their history (or the first-game line).
export function roomMemoryMarkdown(players, data) {
  if (!players.length) return "";
  const out = [`## Players expected at start\n\n${players.map((p) => p.name).join(", ")} (more may join; use the \`init\` / \`players\` list as the truth).\n`];
  out.push("## Room memory\n");
  const byGuid = data?.players ?? {};
  const nameOf = (g) => players.find((p) => p.guid === g)?.name ?? byGuid[g]?.names?.[0] ?? "someone";
  const lines = [];
  for (const p of players) {
    const h = p.guid && byGuid[p.guid];
    if (!h || !h.games) continue;
    const parts = [`- **${p.name}**: ${h.games} game${h.games === 1 ? "" : "s"} played`];
    const older = (h.names ?? []).filter((n) => n.toLowerCase() !== p.name.toLowerCase());
    if (older.length) parts.push(` (also played as ${older.slice(0, 2).join(", ")})`);
    const wins = (h.results ?? []).filter((r) => r.winnerGuid === p.guid || (!r.winnerGuid && r.winner === p.name)).length;
    if (wins) parts.push(`; won ${wins} of their last ${h.results.length}`);
    if (h.awards?.length) parts.push(`; awards: ${h.awards.slice(0, 4).map((a) => `"${a.title}" (${a.game})`).join(", ")}`);
    lines.push(parts.join("") + ".");
    for (const m of (h.moments ?? []).filter((m) => m.kind !== "award").slice(0, 3)) lines.push(`  - ${line(m)}`);
  }
  for (const c of data?.crews ?? []) {
    if (!c.moments?.length) continue;
    lines.push(`- **${c.guids.map(nameOf).join(" + ")}** together: ${c.games} game${c.games === 1 ? "" : "s"}; standing moments:`);
    for (const m of c.moments.filter((m) => m.kind !== "award").slice(0, 3)) lines.push(`  - ${line(m)}`);
  }
  if (!lines.length) out.push("No history yet: this is their first game together.\n");
  else {
    out.push(lines.join("\n") + "\n");
    out.push("Use this history for callbacks: an opening line, award titles, the host's `say` lines and reveals " +
      "(\"Bo, last time you were Most Robotic Human\"). Do not make the game depend on it: it must play the same " +
      "for people with no history, and only name history for players who are actually in the room.\n");
  }
  return out.join("\n");
}

export async function roomMemorySection(relay, context) {
  const players = contextPlayers(context);
  if (!players.length) return "";
  return roomMemoryMarkdown(players, await fetchMemories(relay, players));
}
