// The TV's memory book: fun moments from every game, kept on the television itself.
// Web storage on a Little TV belongs to the household profile on screen and survives restarts
// (SKILL.md "Saved state and per-viewer storage"), so localStorage is the right home; it's
// capped so it stays small. Every read/write is guarded: storage can be unavailable.

/** One skeleton frame: per person [n, flat mirrored points [x,y, x,y, …] in COCO-17 order]. */
export type ClipFrame = { t: number; people: { n: number; pts: number[] }[] };

export interface Moment {
  id: string;
  at: number; // epoch ms
  game: string; // game title
  title: string;
  caption?: string;
  players?: string[];
  kind?: "funny" | "win" | "fail" | "clutch" | "bot" | string;
  clip?: ClipFrame[]; // camera games: ~2.5 s of stick figures before the moment
  playerGuids?: string[]; // parallel to players ("" where unknown)
  crew?: string[]; // sorted guids of everyone in the room
  room?: string; // room code
}

export interface GameResult {
  at: number;
  game: string;
  winner?: string;
  scores: Record<string, number>;
}

const KEY = "lr.memories.v1";
const MAX_MOMENTS = 60;
const MAX_CLIPS = 20; // clips are the heavy part
const MAX_RESULTS = 30;

export const COCO = [
  "nose", "left_eye", "right_eye", "left_ear", "right_ear", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
  "left_wrist", "right_wrist", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle",
] as const;

interface Book {
  moments: Moment[];
  results: GameResult[];
}

function load(): Book {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const b = JSON.parse(raw) as Partial<Book>;
      return { moments: Array.isArray(b.moments) ? b.moments : [], results: Array.isArray(b.results) ? b.results : [] };
    }
  } catch {
    /* storage unavailable or corrupt: start empty */
  }
  return { moments: [], results: [] };
}

function save(b: Book) {
  // Newest first; drop clips from older moments before dropping moments.
  b.moments = b.moments.slice(0, MAX_MOMENTS);
  let clips = 0;
  for (const m of b.moments) if (m.clip && ++clips > MAX_CLIPS) delete m.clip;
  b.results = b.results.slice(0, MAX_RESULTS);
  try {
    localStorage.setItem(KEY, JSON.stringify(b));
  } catch {
    try {
      // Quota: keep the words, lose the pictures.
      for (const m of b.moments) delete m.clip;
      localStorage.setItem(KEY, JSON.stringify(b));
    } catch {
      /* give up quietly; the recap still plays from memory */
    }
  }
}

export function remember(moments: Moment[], result?: GameResult) {
  const b = load();
  b.moments = [...moments].reverse().concat(b.moments);
  if (result) b.results.unshift(result);
  save(b);
}

export function allMemories(): Book {
  return load();
}

export function memoryCount(): number {
  return load().moments.length;
}

/** Pick the best few for a recap: clips and wins first, then the rest, newest first. */
export function pickHighlights(moments: Moment[], max = 5): Moment[] {
  moments = moments.filter((m) => m.kind !== "award"); // awards go in the credits roll
  const rank = (m: Moment) => (m.clip?.length ? 3 : 0) + (m.kind === "win" ? 2 : 0) + (m.kind === "funny" || m.kind === "bot" ? 1 : 0);
  return [...moments].sort((a, b) => rank(b) - rank(a) || b.at - a.at).slice(0, max);
}
