import { RELAY_HTTP } from "../config";

// Game bundles (PLAN.md "Game bundle"): meta.json + one self-contained tv.html.
// The game server (relay Worker /games) is the single source of truth: hand-written bundles
// live in relay/games/ and are published there (cd relay && pnpm games:publish <id>), and
// /author writes new ones there too.

export interface GameMeta {
  id: string;
  title: string;
  description: string;
  phases?: string[];
  minPlayers?: number;
  maxPlayers?: number;
  createdAt?: string;
  /** palette id from the authoring kit; the host theme maps it to --bg/--ink/... */
  palette?: string;
  /** one line naming the game's world, shown large when its tile is focused in the lobby */
  hook?: string;
  /** themed player seats: 6-12 inline SVGs (viewBox 0 0 48 48, currentColor) */
  seats?: { name: string; svg: string }[];
  /** false: the game can start with nobody joined by phone (e.g. camera games) */
  phonesRequired?: boolean;
  prompt?: string;
  /** where the bundle lives; always the game server */
  source: "relay";
}

async function getJson<T>(url: string, ms = 8000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export async function listGames(): Promise<GameMeta[]> {
  const v = await getJson<unknown>(`${RELAY_HTTP}/games`);
  const list = (Array.isArray(v) ? v : []) as Omit<GameMeta, "source">[];
  const out: GameMeta[] = [];
  for (const g of list)
    if (g && g.id && !out.some((o) => o.id === g.id))
      // 16 players per game, period (relay room cap); older metas said up to 40.
      out.push({ ...g, maxPlayers: g.maxPlayers ? Math.min(16, g.maxPlayers) : g.maxPlayers, source: "relay" });
  return out;
}

export async function loadGameHtml(meta: Pick<GameMeta, "id">): Promise<string> {
  const res = await fetch(`${RELAY_HTTP}/games/${encodeURIComponent(meta.id)}/tv.html`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not load ${meta.id} (${res.status})`);
  return res.text();
}

/** Finds a game by id or by a loose title match ("who's the bot" → whos-the-bot). */
export function findGame(games: GameMeta[], query: string): GameMeta | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const q = norm(query);
  if (!q) return undefined;
  return (
    games.find((g) => norm(g.id) === q) ??
    games.find((g) => norm(g.title) === q) ??
    games.find((g) => norm(g.title).includes(q) || q.includes(norm(g.title)) || norm(g.id).includes(q))
  );
}
