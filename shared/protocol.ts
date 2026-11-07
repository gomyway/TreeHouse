// Wire protocol shared by tv/, relay/ and phone/. The TV is the authority; the relay only routes.
// Every frame is one JSON object with a `type`. The relay stamps `player` on phone→TV frames and
// routes TV→phone frames by `to` (a playerId or "*").

export type PlayerId = string;
export type RoomCode = string; // 4 letters, no look-alikes

export interface Player {
  id: PlayerId;
  name: string;
  connected: boolean;
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
  | { type: "input"; player: PlayerId; data: unknown }
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
  | TvToRelay; // screen/state/ask/play/kick, delivered as-is

// ---- Phone → Relay (relay stamps `player`, forwards to TV) ----
export type PhoneToRelay =
  | { type: "input"; data: unknown }
  | { type: "sensor"; kind: SensorKind; data: unknown };

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O
export const CODE_LENGTH = 4;
export const MAX_FRAME_BYTES = 256 * 1024; // camera snaps fit, nothing bigger
export const TV_GRACE_MS = 60_000; // room survives a TV disconnect this long
export const PLAYER_GRACE_MS = 5 * 60_000; // a phone can rejoin with its playerId this long
