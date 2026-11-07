import { RELAY_HTTP } from "../config";

// Game bundles (PLAN.md "Game bundle"): meta.json + one self-contained tv.html.
// Two sources: games that ship with the TV app (public/games/) and games stored on the
// relay Worker (/games, including anything /author wrote).

export interface GameMeta {
  id: string;
  title: string;
  description: string;
  phases?: string[];
  minPlayers?: number;
  maxPlayers?: number;
  createdAt?: string;
  prompt?: string;
  /** where the bundle lives; set by listGames */
  source: "builtin" | "relay";
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
  const [builtin, relay] = await Promise.allSettled([
    getJson<Omit<GameMeta, "source">[]>("./games/index.json"),
    getJson<unknown>(`${RELAY_HTTP}/games`),
  ]);
  const out: GameMeta[] = [];
  if (builtin.status === "fulfilled") for (const g of builtin.value) out.push({ ...g, source: "builtin" });
  if (relay.status === "fulfilled") {
    const v = relay.value as { games?: unknown } | unknown[];
    const list = (Array.isArray(v) ? v : Array.isArray((v as { games?: unknown }).games) ? (v as { games: unknown[] }).games : []) as Omit<GameMeta, "source">[];
    for (const g of list) if (g && g.id && !out.some((o) => o.id === g.id)) out.push({ ...g, source: "relay" });
  }
  return out;
}

export async function loadGameHtml(meta: Pick<GameMeta, "id" | "source">): Promise<string> {
  const url =
    meta.source === "builtin"
      ? `./games/${encodeURIComponent(meta.id)}/tv.html`
      : `${RELAY_HTTP}/games/${encodeURIComponent(meta.id)}/tv.html`;
  const res = await fetch(url, { cache: "no-store" });
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
