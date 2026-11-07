import { colorFor, type Player, type PlayerId, type RoomEvent, type RoomStatus, type RoomTransport, type Screen } from "./model";

// The TV's connection to the relay. Wire shapes follow PLAN.md ("Join flow"):
//   TV opens  wss://<relay>/host            → relay sends { type: "room", code, hostToken? }
//   relay → TV  { type: "join" | "rejoin", player } · { type: "leave", player | playerId }
//               { type: "input", player, data } · { type: "sensor", player, kind, data }
//   TV → relay  { type: "screen", to, screen } · { type: "kick", player }
// When shared/protocol.ts lands, swap the loose parsing below for its types. Nothing
// outside this file knows the wire format.

type Wire = Record<string, unknown>;

export interface RelayRoom extends RoomTransport {
  readonly code: string | null;
  readonly joinUrl: string | null;
}

export function connectRelay(
  relayUrl: string,
  handlers: {
    onEvent: (e: RoomEvent) => void;
    onStatus: (s: RoomStatus) => void;
    onRoom: (code: string, joinUrl: string) => void;
  },
): RelayRoom {
  const wsBase = relayUrl.replace(/^http/, "ws").replace(/\/+$/, "");
  const httpBase = wsBase.replace(/^ws/, "http");

  let ws: WebSocket | null = null;
  let code: string | null = null;
  let hostToken: string | null = null;
  let joinUrl: string | null = null;
  let closed = false;
  let attempt = 0;
  let retry: number | undefined;
  const outbox: string[] = [];

  const send = (msg: Wire) => {
    const s = JSON.stringify(msg);
    if (ws?.readyState === WebSocket.OPEN) ws.send(s);
    else outbox.push(s);
  };

  const toPlayer = (raw: unknown): Player | null => {
    if (typeof raw === "string") return { id: raw, name: raw, connected: true, joinedAt: Date.now(), color: colorFor(raw) };
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Wire;
    const id = String(r.id ?? r.playerId ?? "");
    if (!id) return null;
    const name = String(r.name ?? "Player").slice(0, 24);
    return { id, name, connected: true, joinedAt: Date.now(), color: colorFor(id) };
  };
  const idOf = (m: Wire): PlayerId | null => {
    const p = m.player ?? m.playerId ?? m.from;
    if (typeof p === "string") return p;
    if (p && typeof p === "object") return String((p as Wire).id ?? "") || null;
    return null;
  };

  const open = () => {
    const params = new URLSearchParams();
    if (code && hostToken) {
      params.set("code", code);
      params.set("token", hostToken);
    }
    const qs = params.toString();
    handlers.onStatus(attempt === 0 ? "connecting" : "reconnecting");
    const sock = new WebSocket(`${wsBase}/host${qs ? `?${qs}` : ""}`);
    ws = sock;

    sock.onopen = () => {
      attempt = 0;
      while (outbox.length) sock.send(outbox.shift()!);
    };
    sock.onmessage = (ev) => {
      let m: Wire;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      switch (m.type) {
        case "room": {
          code = String(m.code ?? "");
          hostToken = typeof m.hostToken === "string" ? m.hostToken : typeof m.token === "string" ? m.token : hostToken;
          joinUrl = typeof m.joinUrl === "string" ? m.joinUrl : `${httpBase}/?c=${encodeURIComponent(code)}`;
          handlers.onRoom(code, joinUrl);
          handlers.onStatus("open");
          break;
        }
        case "join":
        case "rejoin": {
          const player = toPlayer(m.player);
          if (player) handlers.onEvent({ type: m.type, player });
          break;
        }
        case "leave": {
          const id = idOf(m);
          if (id) handlers.onEvent({ type: "leave", playerId: id });
          break;
        }
        case "input": {
          const id = idOf(m);
          if (id) handlers.onEvent({ type: "input", playerId: id, data: m.data });
          break;
        }
        case "sensor": {
          const id = idOf(m);
          if (id) handlers.onEvent({ type: "sensor", playerId: id, kind: String(m.kind ?? ""), data: m.data });
          break;
        }
      }
    };
    sock.onclose = () => {
      if (ws !== sock || closed) return;
      handlers.onStatus("reconnecting");
      // Reattach quickly: the relay holds the room for 60 s after the TV drops.
      const delay = Math.min(1000 * 2 ** attempt, 8000);
      attempt += 1;
      retry = window.setTimeout(open, delay);
    };
  };

  open();

  return {
    get code() {
      return code;
    },
    get joinUrl() {
      return joinUrl;
    },
    sendScreen(to: PlayerId | "*", screen: Screen) {
      send({ type: "screen", to, screen });
    },
    kick(playerId: PlayerId) {
      send({ type: "kick", player: playerId });
    },
    close() {
      closed = true;
      clearTimeout(retry);
      ws?.close();
      handlers.onStatus("offline");
    },
  };
}
