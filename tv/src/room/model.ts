// The TV app's own view of the room. The relay wire format lives in ./relay.ts and is
// mapped onto these types there, so a protocol change touches one file.

export type PlayerId = string;

export interface Player {
  id: PlayerId;
  name: string;
  /** false while the phone is disconnected but may still rejoin */
  connected: boolean;
  joinedAt: number;
  color: string;
}

/** Declarative screens a phone renders (PLAN.md "Screens are declarative"). */
export type Screen =
  | { kind: "info"; title: string; body?: string }
  | { kind: "buttons"; prompt?: string; items: { id: string; label: string }[] }
  | { kind: "text"; prompt: string; maxLength?: number }
  | { kind: "pad"; prompt?: string }
  | { kind: "custom"; html: string };

export type RoomStatus = "connecting" | "open" | "reconnecting" | "offline";

export type RoomEvent =
  | { type: "join"; player: Player }
  | { type: "rejoin"; player: Player }
  | { type: "leave"; playerId: PlayerId }
  | { type: "input"; playerId: PlayerId; data: unknown }
  | { type: "sensor"; playerId: PlayerId; kind: string; data: unknown };

export interface RoomTransport {
  /** Sends a screen to one player or to everyone ("*"). */
  sendScreen(to: PlayerId | "*", screen: Screen): void;
  /** Disconnects a player from the room. */
  kick(playerId: PlayerId): void;
  close(): void;
}

const PALETTE = ["#ff7a59", "#ffc145", "#5fd38d", "#4cc3ff", "#a98bff", "#ff6fb1", "#3ee6d0", "#ffa24c"];

export function colorFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
