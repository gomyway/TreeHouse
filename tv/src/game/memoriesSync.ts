import { RELAY_HTTP } from "../config";
import type { Player } from "../room/model";
import type { GameResult, Moment } from "./memories";

// Sends one finished game's moments to the Worker's memory store (relay/README.md "Memories"),
// filed per player guid and per crew so later games and authored games can call back to them.
// Must run right after done: the room's hostToken dies 60 s after the TV leaves the room.
// Fire and forget: the TV's own memory book (memories.ts) is already saved either way.

// Names the games make up for people without a phone ("Player 2", "Someone") must never be
// credited to a real phone that happens to use the same name.
const PLACEHOLDER = /^(player \d+|someone|nobody|left|right|the bot|bot \d+)$/i;

/** Fills playerGuids (parallel to players, by display name) on each moment. crew and room go once
 *  on the post itself; the Worker fills them in per moment. */
export function tagMoments(moments: Moment[], roster: Player[]): Moment[] {
  const byName = new Map(roster.map((p) => [p.name.toLowerCase(), p.guid ?? ""]));
  return moments.map((m) => ({
    ...m,
    playerGuids: m.players?.map((n) => (PLACEHOLDER.test(n.trim()) ? "" : byName.get(n.toLowerCase()) ?? "")),
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
  const crew = [...new Set(players.map((p) => p.guid))].sort();
  const body = JSON.stringify({
    room: credentials.code,
    hostToken: credentials.hostToken,
    game: opts.game,
    at: opts.at,
    moments: opts.moments,
    result: opts.result,
    players,
    crew,
  });
  // keepalive lets the request finish if the TV closes the app during the recap; browsers cap
  // keepalive bodies at 64 KB, so big posts (pose clips) go without it. One retry on failure;
  // re-posting the same room+at replaces the game, so a retry never double counts.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${RELAY_HTTP}/memories`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: body.length < 60_000,
      });
      console.info("[memories] POST", res.status, (await res.text()).slice(0, 160));
      if (res.ok || (res.status >= 400 && res.status < 500)) return;
    } catch (e) {
      console.warn("[memories] POST failed", String((e as Error)?.message ?? e));
    }
    if (attempt === 1) await new Promise((r) => setTimeout(r, 3000));
  }
}

/** Players for create_game's context, so the authoring runner can seed "Room memory". */
export function playersContext(roster: Player[]) {
  return roster.filter((p) => p.connected).map((p) => ({ id: p.id, name: p.name, guid: p.guid }));
}
