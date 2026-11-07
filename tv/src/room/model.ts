import type { Screen, SensorKind } from "../../../shared/protocol";

// The TV app's own view of the room. The relay wire format (shared/protocol.ts) is mapped
// onto these types in ./relay.ts, so a protocol change touches one file.

export type { Screen, SensorKind };
export type PlayerId = string;

export interface Player {
  id: PlayerId;
  name: string;
  /** false while the phone is disconnected but may still rejoin */
  connected: boolean;
  joinedAt: number;
  color: string;
}

export type RoomStatus = "connecting" | "open" | "reconnecting" | "offline";

export type RoomEvent =
  /** the full player list, sent when the TV (re)attaches to its room */
  | { type: "sync"; players: Player[] }
  | { type: "join"; player: Player }
  | { type: "rejoin"; player: Player }
  | { type: "leave"; playerId: PlayerId }
  | { type: "input"; playerId: PlayerId; data: unknown }
  | { type: "sensor"; playerId: PlayerId; kind: SensorKind; data: unknown };

export interface RoomTransport {
  /** Sends a screen to one player or to everyone ("*"). */
  sendScreen(to: PlayerId | "*", screen: Screen): void;
  /** Turns a phone sensor stream on or off (the phone shows a tap-to-allow first). */
  ask(to: PlayerId | "*", kind: SensorKind, on: boolean, hz?: number): void;
  /** Speaks text or plays a sound on phones. */
  play(to: PlayerId | "*", text?: string, url?: string): void;
  /** Pushes app state to phones (custom screens receive it). */
  sendState(to: PlayerId | "*", payload: unknown): void;
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
