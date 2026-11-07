import { RELAY_HTTP } from "../config";
import type { Player } from "../room/model";
import type { GameResult, Moment } from "./memories";

// Sends one finished game's moments to the Worker's memory store (relay/README.md "Memories"),
// filed per player guid and per crew so later games and authored games can call back to them.
// Must run right after done: the room's hostToken dies 60 s after the TV leaves the room.
// Fire and forget: the TV's own memory book (memories.ts) is already saved either way.

/** Fills playerGuids (parallel to players, by display name), crew and room on each moment. */
export function tagMoments(moments: Moment[], roster: Player[], room: string | null): Moment[] {
  const byName = new Map(roster.map((p) => [p.name.toLowerCase(), p.guid ?? ""]));
  const crew = [...new Set(roster.map((p) => p.guid).filter((g): g is string => !!g))].sort();
  return moments.map((m) => ({
    ...m,
    playerGuids: m.players?.map((n) => byName.get(n.toLowerCase()) ?? ""),
    crew: crew.length ? crew : undefined,
    room: room ?? undefined,
  }));
}

export async function postMemories(opts: {
  credentials: { code: string; hostToken: string } | null;
  game: string;
  at: number;
  moments: Moment[];
  result?: GameResult;
  roster: Player[];
}): Promise<void> {
  const { credentials } = opts;
  if (!credentials) return; // fake room or not connected: nothing to file
  const players = opts.roster.filter((p) => p.guid).map((p) => ({ guid: p.guid as string, name: p.name }));
  try {
    const res = await fetch(`${RELAY_HTTP}/memories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        room: credentials.code,
        hostToken: credentials.hostToken,
        game: opts.game,
        at: opts.at,
        moments: opts.moments,
        result: opts.result,
        players,
      }),
    });
    const body = await res.text();
    console.info("[memories] POST", res.status, body.slice(0, 160));
  } catch (e) {
    console.warn("[memories] POST failed", String((e as Error)?.message ?? e));
  }
}

/** Players for create_game's context, so the authoring runner can seed "Room memory". */
export function playersContext(roster: Player[]) {
  return roster.filter((p) => p.connected).map((p) => ({ id: p.id, name: p.name, guid: p.guid }));
}
