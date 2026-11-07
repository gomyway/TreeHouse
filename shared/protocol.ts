// Wire protocol shared by tv/, relay/ and phone/. The TV is the authority; the relay only routes.
// Every frame is one JSON object with a `type`. The relay stamps `player` on phone→TV frames and
// routes TV→phone frames by `to` (a playerId or "*").

export type PlayerId = string;
export type RoomCode = string; // 4 letters, no look-alikes

export interface Player {
  id: PlayerId;
  name: string;
  connected: boolean;
  // Per-device key the phone generates once and keeps in localStorage (`lr.guid`). Not an account and
  // not tied to the typed name: it only lets the host resolve moments to the same person across rooms
  // and days (PLAN.md "Memories"). Absent when the phone sent none or an invalid one (8-64 [A-Za-z0-9-]).
  guid?: string;
  // True when this player joined while another connected player in the room had the same guid
  // (two tabs on one phone). Still a separate player.
  sameDevice?: boolean;
}

// ---- Phone screens (declarative; the shell renders them) ----
// `deadline` (optional, every kind): epoch ms by the TV's clock. The phone shows a big countdown
// (its own clock, assumed within ~1 s of the TV's) and at zero disables the inputs and shows
// "Time's up, look at the TV". A `text` screen then auto-submits what was typed, or sends
// { kind: "text", text: "", late: true } if nothing was; a `buttons` screen sends nothing.
// The TV still ends the round on its own timer; allow ~1.5 s grace for auto-submitted answers.
export type Screen =
  | { kind: "info"; title: string; body?: string; deadline?: number }
  | { kind: "buttons"; prompt?: string; items: { id: string; label: string }[]; deadline?: number }
  | { kind: "text"; prompt: string; maxLength?: number; placeholder?: string; deadline?: number } // shows a live "n/max" counter
  | { kind: "pad"; label?: string; deadline?: number } // touch joystick, streams `input` {kind:"pad", x, y} at ~20 Hz
  | { kind: "custom"; html: string; deadline?: number }; // sandboxed iframe; posts {type:"input", data} back

// The `data` of a phone `input` frame, by screen kind (custom screens send whatever they like).
export type ScreenInput =
  | { kind: "button"; id: string }
  | { kind: "text"; text: string; late?: true } // late: the deadline passed with nothing typed
  | { kind: "pad"; x: number; y: number };

export type SensorKind = "gyro" | "camera" | "mic";

// ---- Relay → TV ----
export type RelayToTv =
  | { type: "room"; code: RoomCode; hostToken: string; players: Player[] }
  | { type: "join"; player: Player }
  | { type: "rejoin"; player: Player }
  | { type: "leave"; player: Player }
  | { type: "input"; player: PlayerId; seq?: number; data: unknown }
  | { type: "sensor"; player: PlayerId; kind: SensorKind; data: unknown }
  | { type: "error"; message: string };

// ---- TV → Relay (routed to phones by `to`) ----
export type TvToRelay =
  | { type: "screen"; to: PlayerId | "*"; screen: Screen }
  | { type: "state"; to?: PlayerId | "*"; payload: unknown }
  | { type: "ask"; to: PlayerId | "*"; kind: SensorKind; on: boolean; hz?: number }
  | { type: "play"; to: PlayerId | "*"; text?: string; url?: string }
  | { type: "kick"; to: PlayerId };

// ---- Relay → Phone ----
export type RelayToPhone =
  | { type: "joined"; code: RoomCode; player: Player }
  | { type: "tv"; status: "connected" | "reconnecting" | "closed" }
  | { type: "error"; message: string }
  // Reply to a phone `input` that carried `seq`, sent once the relay has handed it to the TV socket.
  // delivered: false means no TV socket was attached (inside the TV grace window): the input was dropped.
  | { type: "ack"; seq: number; delivered: boolean }
  | TvToRelay; // screen/state/ask/play/kick, delivered as-is

// ---- Phone → Relay (relay stamps `player`, forwards to TV) ----
export type PhoneToRelay =
  // seq: increasing per phone page load; set on discrete inputs (taps, text, custom), omitted on the
  // pad's 20 Hz stream. The relay acks it; the TV receives it too and may ignore it. A phone may
  // send the same seq twice after a reconnect, and a re-tap sends a new seq for the same answer.
  | { type: "input"; seq?: number; data: unknown }
  | { type: "sensor"; kind: SensorKind; data: unknown };

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O
export const CODE_LENGTH = 4;
export const MAX_FRAME_BYTES = 256 * 1024; // camera snaps fit, nothing bigger
export const TV_GRACE_MS = 60_000; // room survives a TV disconnect this long
export const PLAYER_GRACE_MS = 5 * 60_000; // a phone can rejoin with its playerId this long

// ---- Game bundles (PLAN.md "Game bundle", "Game scope"; relay/src/games.mjs) ----
/** `<id>/meta.json`. GET /games lists these; GET /games?tv=<tvId> adds that TV's own (scope "tv"). */
export interface BundleMeta {
  id: string; // [a-z0-9][a-z0-9-]{0,39}
  title: string;
  description: string;
  phases: string[];
  minPlayers: number;
  maxPlayers?: number;
  createdAt?: string; // ISO; the server fills it in
  prompt?: string;
  phonesRequired?: boolean;
  /** "global" (default when absent): every TV. "tv": only the TV `tvId` (authored with Room memory). */
  scope?: "global" | "tv";
  tvId?: string; // 1-64 chars of [A-Za-z0-9._-]; the TV that asked (or "unknown-tv")
  crew?: string[]; // sorted player guids present at authoring time
}

// ---- Memories (PLAN.md "Memories"; relay/src/memories.mjs) ----
// Mirrors the TV memory book (tv/src/game/memories.ts, localStorage "lr.memories.v1":
// { moments: Moment[] newest first, max 60, only 20 keep clips; results: GameResult[] max 30 }),
// plus guids so the Worker can file them per person and per crew.

/** One skeleton frame: t is ms relative to the moment (negative, ~2.5 s window); per camera figure n
 *  (1|2), pts = COCO-17 × [x, y] (34 numbers, 0..1, 3 decimals, -1,-1 when a point is missing). */
export interface ClipFrame { t: number; people: { n: number; pts: number[] }[] }

export interface Moment {
  id: string; // "m_<base36 time + 4 chars>"
  at: number; // epoch ms
  game: string; // game title
  title: string; // ≤ 120
  caption?: string; // ≤ 200
  players?: string[]; // display names, ≤ 6
  playerGuids?: string[]; // parallel to players ("" where unknown)
  kind?: "funny" | "win" | "fail" | "clutch" | "bot" | "award" | (string & {});
  clip?: ClipFrame[]; // only in the game file on the Worker; never in index copies
  crew?: string[]; // sorted guids of everyone in the room
  room?: RoomCode;
}

export interface GameResult {
  at: number;
  game: string;
  winner?: string; // display name
  scores: Record<string, number>; // by display name
  winnerGuid?: string;
  scoresByGuid?: Record<string, number>;
  crew?: string[];
  room?: RoomCode;
}

/** POST /memories (auth: the room's hostToken). */
export interface MemoriesPost {
  tvId?: string;
  room: RoomCode;
  hostToken: string;
  game: string;
  at: number;
  moments: Moment[];
  result?: GameResult;
  players?: { guid: string; name: string }[]; // optional: names for crew members with no moment
}

/** GET /memories?guids=a,b,c (unknown guids are absent from `players`). */
export interface MemoriesResponse {
  players: Record<string, {
    names: string[]; // most recent first, ≤ 5
    games: number;
    lastSeen: number;
    awards: { title: string; game: string; at: number }[];
    moments: Moment[]; // no clips, newest first, ≤ 10
    results: GameResult[]; // ≤ 5
  }>;
  crews: { guids: string[]; games: number; moments: Moment[] }[]; // subsets of size ≥ 2 that played as a room
}
