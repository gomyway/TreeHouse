import { useEffect, useRef, useState } from "react";
import { createFakeRoom } from "./fake";
import type { Player, PlayerId, RoomEvent, RoomStatus, RoomTransport } from "./model";
import { connectRelay } from "./relay";

// One room per app window. Picks the transport once:
//   ?fake=N or VITE_FAKE_PLAYERS=N → N pretend players, no relay (UI work without phones)
//   VITE_RELAY_URL   → the relay Worker (local `wrangler dev` or the deployed one)
//   neither          → ws://127.0.0.1:8787, the default `wrangler dev` address

const DEFAULT_RELAY = "ws://127.0.0.1:8787";

export interface Room {
  status: RoomStatus;
  code: string | null;
  joinUrl: string | null;
  players: Player[];
  transport: RoomTransport | null;
}

export function useRoom(onEvent: (e: RoomEvent, players: Player[]) => void): Room {
  const [status, setStatus] = useState<RoomStatus>("connecting");
  const [code, setCode] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState<string | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [transport, setTransport] = useState<RoomTransport | null>(null);

  const playersRef = useRef<Player[]>([]);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const apply = (e: RoomEvent) => {
      let next = playersRef.current;
      if (e.type === "join" || e.type === "rejoin") {
        const existing = next.find((p) => p.id === e.player.id);
        next = existing
          ? next.map((p) => (p.id === e.player.id ? { ...p, name: e.player.name || p.name, connected: true } : p))
          : [...next, e.player];
      } else if (e.type === "leave") {
        next = next.filter((p: Player) => p.id !== e.playerId);
      }
      if (next !== playersRef.current) {
        playersRef.current = next;
        setPlayers(next);
      }
      onEventRef.current(e, next);
    };

    const fake = Number(new URLSearchParams(location.search).get("fake") ?? import.meta.env.VITE_FAKE_PLAYERS ?? 0);
    if (fake > 0) {
      const room = createFakeRoom(Math.min(fake, 40), apply);
      setCode(room.code);
      setJoinUrl(room.joinUrl);
      setStatus("open");
      setTransport(room);
      return () => room.close();
    }

    const url = (import.meta.env.VITE_RELAY_URL as string | undefined) || DEFAULT_RELAY;
    const room = connectRelay(url, {
      onEvent: apply,
      onStatus: setStatus,
      onRoom: (c, u) => {
        setCode(c);
        setJoinUrl(u);
      },
    });
    setTransport(room);
    return () => room.close();
  }, []);

  return { status, code, joinUrl, players, transport };
}

export function playerName(players: Player[], id: PlayerId): string {
  return players.find((p) => p.id === id)?.name ?? "Someone";
}
