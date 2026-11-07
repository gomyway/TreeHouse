import type { RelayToTv, TvToRelay } from "../../../shared/protocol";
import { colorFor, type Player, type PlayerId, type RoomEvent, type RoomStatus, type RoomTransport, type Screen } from "./model";

// The TV's connection to the relay, typed by shared/protocol.ts. Nothing outside this
// file knows the wire format: it maps RelayToTv frames onto RoomEvents and RoomTransport
// calls onto TvToRelay frames.
//   TV opens  <relay>/host  (reattach: /host?code=ABCD&token=<hostToken>)
//   relay → TV  room { code, hostToken, players[] } · join · rejoin · leave · input · sensor · error
//   TV → relay  screen · state · ask · play · kick (all routed by `to`)

export interface RelayRoom extends RoomTransport {
  readonly code: string | null;
  readonly joinUrl: string | null;
}

const toPlayer = (p: { id: string; name: string; connected?: boolean; guid?: string }): Player => ({
  id: p.id,
  name: String(p.name || "Player").slice(0, 24),
  connected: p.connected ?? true,
  joinedAt: Date.now(),
  color: colorFor(p.id),
  guid: typeof p.guid === "string" && p.guid ? p.guid : undefined,
});

export function connectRelay(
  relayUrl: string,
  handlers: {
    onEvent: (e: RoomEvent) => void;
    onStatus: (s: RoomStatus) => void;
    onRoom: (code: string, joinUrl: string) => void;
    onError?: (message: string) => void;
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
  let heartbeat: number | undefined;
  const outbox: string[] = [];

  const send = (msg: TvToRelay) => {
    const s = JSON.stringify(msg);
    if (ws?.readyState === WebSocket.OPEN) ws.send(s);
    else if (outbox.length < 200) outbox.push(s);
  };

  const handle = (m: RelayToTv) => {
    switch (m.type) {
      case "room":
        code = m.code;
        hostToken = m.hostToken;
        joinUrl = `${httpBase}/?c=${encodeURIComponent(code)}`;
        handlers.onRoom(code, joinUrl);
        handlers.onStatus("open");
        // A reattach keeps the lobby: the relay tells us who is still here.
        handlers.onEvent({ type: "sync", players: (m.players ?? []).map(toPlayer) });
        break;
      case "join":
      case "rejoin":
        handlers.onEvent({ type: m.type, player: toPlayer(m.player) });
        break;
      case "leave":
        handlers.onEvent({ type: "leave", playerId: m.player.id });
        break;
      case "input":
        handlers.onEvent({ type: "input", playerId: m.player, data: m.data });
        break;
      case "sensor":
        handlers.onEvent({ type: "sensor", playerId: m.player, kind: m.kind, data: m.data });
        break;
      case "error":
        handlers.onError?.(m.message);
        break;
    }
  };

  const open = () => {
    const qs = code && hostToken ? `?code=${encodeURIComponent(code)}&token=${encodeURIComponent(hostToken)}` : "";
    handlers.onStatus(attempt === 0 ? "connecting" : "reconnecting");
    const sock = new WebSocket(`${wsBase}/host${qs}`);
    ws = sock;

    sock.onopen = () => {
      attempt = 0;
      while (outbox.length) sock.send(outbox.shift()!);
      // Carrier NAT and idle proxies kill a silent socket in 30–60 s; the relay answers a bare
      // "ping" text frame with "pong" without waking the room.
      clearInterval(heartbeat);
      heartbeat = window.setInterval(() => {
        if (sock.readyState === WebSocket.OPEN) sock.send("ping");
      }, 20_000);
    };
    sock.onmessage = (ev) => {
      if (ev.data === "pong") return;
      try {
        handle(JSON.parse(String(ev.data)) as RelayToTv);
      } catch {
        /* ignore malformed frames */
      }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      clearInterval(heartbeat);
      if (closed) return;
      handlers.onStatus("reconnecting");
      // Reattach quickly: the relay holds the room for TV_GRACE_MS after the TV drops.
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
    ask(to, kind, on, hz) {
      send({ type: "ask", to, kind, on, hz });
    },
    play(to, text, url) {
      send({ type: "play", to, text, url });
    },
    sendState(to, payload) {
      send({ type: "state", to, payload });
    },
    credentials() {
      return code && hostToken ? { code, hostToken } : null;
    },
    kick(playerId: PlayerId) {
      send({ type: "kick", to: playerId });
    },
    close() {
      closed = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      ws?.close();
      handlers.onStatus("offline");
    },
  };
}
