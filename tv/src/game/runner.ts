import type { LittleApp } from "@kabletv/little-sdk";
import type { Player, PlayerId, RoomTransport, Screen, SensorKind } from "../room/model";
import { botAnswer } from "./bots";

// Bridges one game bundle (a sandboxed iframe) to the room and to the Little host.
// Contract: PLAN.md "Game bundle", plus the AI-player extension:
//   host → game  init {players, code} · players {players} · input {player, data}
//                sensor {player, kind, data} · voice {text} · ai_result {id, ok, data|url, error?}
//   game → host  screen {to, screen} · ask {to, kind, on, hz} · play {to, text|url}
//                say {text} · state {summary, phase, scores?} · done
//                ai {id, instruction, context?, schema?} · ai_image {id, hint, instruction?}
//                bot_answer {id, prompt, humans, imitate?, caught?, effort?, names?} (see ./bots.ts)

export interface GameState {
  summary: string;
  phase: string;
  scores?: Record<string, number>;
}

export interface GameHost {
  /** Called once the iframe has loaded. */
  start(players: Player[], code: string | null): void;
  players(players: Player[]): void;
  input(player: PlayerId, data: unknown): void;
  sensor(player: PlayerId, kind: SensorKind, data: unknown): void;
  voice(text: string): void;
  dispose(): void;
}

const wire = (players: Player[]) => players.map((p) => ({ id: p.id, name: p.name, connected: p.connected }));
const isTarget = (to: unknown): to is PlayerId | "*" => typeof to === "string" && to.length > 0 && to.length < 64;

export function createGameHost(opts: {
  frame: HTMLIFrameElement;
  app: LittleApp;
  transport: () => RoomTransport | null;
  onState: (s: GameState) => void;
  onDone: () => void;
}): GameHost {
  const { frame, app } = opts;
  let disposed = false;
  const post = (msg: unknown) => {
    if (!disposed) frame.contentWindow?.postMessage(msg, "*");
  };

  const runAi = async (m: Record<string, unknown>) => {
    const id = m.id;
    const timeout = new Promise<{ ok: false; error: { code: string } }>((r) =>
      setTimeout(() => r({ ok: false, error: { code: "timeout" } }), 25_000),
    );
    try {
      if (m.type === "ai") {
        const res = await Promise.race([
          app.compose({
            instruction: String(m.instruction ?? "").slice(0, 6000),
            context: (m.context && typeof m.context === "object" ? m.context : {}) as Record<string, unknown>,
            schema: (m.schema && typeof m.schema === "object" ? m.schema : undefined) as Record<string, unknown> | undefined,
          }),
          timeout,
        ]);
        post(res.ok ? { type: "ai_result", id, ok: true, data: res.data } : { type: "ai_result", id, ok: false, error: res.error?.code ?? "failed" });
      } else {
        const res = await Promise.race([
          app.image({ hint: String(m.hint ?? "").slice(0, 500), instruction: m.instruction ? String(m.instruction).slice(0, 2000) : undefined }),
          timeout,
        ]);
        post(res.ok ? { type: "ai_result", id, ok: true, url: res.url } : { type: "ai_result", id, ok: false, error: res.error?.code ?? "failed" });
      }
    } catch (e) {
      post({ type: "ai_result", id, ok: false, error: String((e as Error)?.message ?? e) });
    }
  };

  const onMessage = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow) return; // only our sandboxed game
    const m = e.data as Record<string, unknown> | null;
    if (!m || typeof m.type !== "string") return;
    const t = opts.transport();
    switch (m.type) {
      case "screen":
        if (isTarget(m.to) && m.screen && typeof m.screen === "object") t?.sendScreen(m.to, m.screen as Screen);
        break;
      case "ask":
        if (isTarget(m.to) && (m.kind === "gyro" || m.kind === "camera" || m.kind === "mic"))
          t?.ask(m.to, m.kind, Boolean(m.on), typeof m.hz === "number" ? m.hz : undefined);
        break;
      case "play":
        if (isTarget(m.to)) t?.play(m.to, typeof m.text === "string" ? m.text : undefined, typeof m.url === "string" ? m.url : undefined);
        break;
      case "say":
        if (typeof m.text === "string" && m.text.trim() && app.can("voice.say")) void app.voice.say(m.text.slice(0, 400));
        break;
      case "state":
        opts.onState({
          summary: String(m.summary ?? "").slice(0, 2000),
          phase: String(m.phase ?? ""),
          scores: m.scores && typeof m.scores === "object" ? (m.scores as Record<string, number>) : undefined,
        });
        break;
      case "done":
        opts.onDone();
        break;
      case "ai":
      case "ai_image":
        void runAi(m);
        break;
      case "bot_answer": {
        const strs = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 200)).slice(0, 30) : undefined);
        const effort = m.effort === "lazy" || m.effort === "room" || m.effort === "joke" ? m.effort : undefined;
        const work = botAnswer(app, {
          prompt: String(m.prompt ?? "").slice(0, 300),
          humans: strs(m.humans) ?? [],
          imitate: strs(m.imitate),
          caught: strs(m.caught),
          names: strs(m.names),
          effort,
        });
        const timeout = new Promise<null>((r) => setTimeout(() => r(null), 25_000));
        Promise.race([work, timeout])
          .then((text) => post(text ? { type: "ai_result", id: m.id, ok: true, data: { text } } : { type: "ai_result", id: m.id, ok: false, error: "no_answer" }))
          .catch((e) => post({ type: "ai_result", id: m.id, ok: false, error: String((e as Error)?.message ?? e) }));
        break;
      }
    }
  };
  window.addEventListener("message", onMessage);

  return {
    start(players, code) {
      post({ type: "init", players: wire(players), code });
    },
    players(players) {
      post({ type: "players", players: wire(players) });
    },
    input(player, data) {
      post({ type: "input", player, data });
    },
    sensor(player, kind, data) {
      post({ type: "sensor", player, kind, data });
    },
    voice(text) {
      post({ type: "voice", text });
    },
    dispose() {
      disposed = true;
      window.removeEventListener("message", onMessage);
    },
  };
}
