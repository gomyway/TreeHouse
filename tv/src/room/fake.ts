import { colorFor, type Player, type RoomEvent, type RoomTransport, type Screen } from "./model";

// A stand-in room for working on the TV without phones or a relay: open the app with
// ?fake=5 and five pretend players join, then answer whatever screen they are sent.

const NAMES = ["Ana", "Ben", "Ana", "Dee", "Eli", "Fay", "Gus", "Hana", "Ivo", "Jun", "Kai", "Lia"];

export function createFakeRoom(
  count: number,
  emit: (e: RoomEvent) => void,
): RoomTransport & { code: string; joinUrl: string } {
  const timers = new Set<number>();
  const later = (ms: number, fn: () => void) => {
    const t = window.setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  const players: Player[] = [];
  for (let i = 0; i < count; i++) {
    later(600 + i * 700, () => {
      const id = `fake_${i}`;
      const player: Player = { id, name: NAMES[i % NAMES.length], connected: true, joinedAt: Date.now(), color: colorFor(id) };
      players.push(player);
      emit({ type: "join", player });
    });
  }

  const answer = (p: Player, screen: Screen) => {
    if (screen.kind === "buttons" && screen.items.length) {
      const pick = screen.items[Math.floor(Math.random() * screen.items.length)];
      emit({ type: "input", playerId: p.id, data: { id: pick.id } });
    } else if (screen.kind === "text") {
      const lines = ["a tiny redwood", "pizza, obviously", "the couch wins", "ask the TV", "no comment", "dragons"];
      emit({ type: "input", playerId: p.id, data: { text: lines[Math.floor(Math.random() * lines.length)] } });
    }
  };

  return {
    code: "FAKE",
    joinUrl: "https://example.invalid/?c=FAKE",
    sendScreen(to, screen) {
      for (const p of players) {
        if (to !== "*" && to !== p.id) continue;
        later(1200 + Math.random() * 4000, () => answer(p, screen));
      }
    },
    ask() {},
    play() {},
    sendState() {},
    kick(playerId) {
      const i = players.findIndex((p) => p.id === playerId);
      if (i >= 0) players.splice(i, 1);
      emit({ type: "leave", playerId });
    },
    close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
