import type { LittleApp } from "@kabletv/little-sdk";
import type { Player, PlayerId, RoomTransport, Screen, SensorKind } from "../room/model";
import { botAnswer } from "./bots";
import { trackPeople } from "./people";
import { COCO, type ClipFrame, type Moment } from "./memories";
import { createMotionSession, MOTION_ACTION_IDS, MOTION_CONTROL_IDS, MOTION_HELD_IDS } from "@kabletv/little-motion";

// Bridges one game bundle (a sandboxed iframe) to the room and to the Little host.
// Contract: PLAN.md "Game bundle", plus the AI-player extension:
//   host → game  init {players, code} · players {players} · input {player, data}
//                sensor {player, kind, data} · voice {text} · ai_result {id, ok, data|url, error?}
//   game → host  screen {to, screen} · ask {to, kind, on, hz} · play {to, text|url}
//                say {text} · state {summary, phase, scores?} · done
//                ai {id, instruction, context?, schema?} · ai_image {id, hint, instruction?}
//                bot_answer {id, prompt, humans, imitate?, caught?, effort?, names?} (see ./bots.ts)
//                motion_start {actions?, held?, controls?, maxPlayers?, mode?: "people"} · motion_stop
//                moment {title, caption?, players?, kind?, clip?: "pose"} → saved to the TV's memory
//                book and replayed in the end-of-game recap; clip "pose" attaches the last ~2.5 s
//                of stick figures (camera games)
//                (mode "people": one raw stream, phantom filtering, numbered figures 1..2 and
//                 skeleton-based arm-raise / both-arms-raise; adds host → game
//                 people {people:[{n, box, points, arms}]} ~10 Hz. See ./people.ts)
//   host → game  motion {actions:[{id, side?, slot}], held:[{id, side?, slot}], controls:[{id, value, slot}]}
//                motion_status {state, reason?, slots:[{slot, state}]} · said {id, ok, interrupted?}
// Camera games are capped at 2 players (tested on the TV); request only what a phase needs,
// since session status is aggregate across every requested semantic.

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

// guid lets a game key seat icons on FNV-1a(guid), the same hash the lobby uses.
const wire = (players: Player[]) => players.map((p) => ({ id: p.id, name: p.name, connected: p.connected, ...(p.guid ? { guid: p.guid } : {}) }));
const isTarget = (to: unknown): to is PlayerId | "*" => typeof to === "string" && to.length > 0 && to.length < 64;

export function createGameHost(opts: {
  frame: HTMLIFrameElement;
  app: LittleApp;
  transport: () => RoomTransport | null;
  onState: (s: GameState) => void;
  onDone: () => void;
  onMoment?: (m: Moment) => void;
  title?: string;
}): GameHost {
  const { frame, app } = opts;
  let disposed = false;
  let motion: { close(): void } | null = null;
  // Rolling skeleton buffer for moment clips (people mode only).
  const clipBuf: ClipFrame[] = [];
  const CLIP_MS = 2500;
  const stopMotion = () => {
    motion?.close();
    motion = null;
  };
  const startMotion = (m: Record<string, unknown>) => {
    stopMotion();
    if (!app.can("sense.motion")) {
      post({ type: "motion_status", state: "unavailable", reason: "not-granted", slots: [] });
      return;
    }
    if (m.mode === "people") {
      let provider = "starting";
      let seen = "";
      const status = (people: { n: number }[]) => {
        const slots = [1, 2].map((n) => ({ slot: n - 1, state: people.some((p) => p.n === n) ? "active" : "vacant" }));
        const key = provider + "|" + slots.map((x) => x.state).join(",");
        if (key === seen) return;
        seen = key;
        post({ type: "motion_status", state: provider === "ready" ? "ready" : provider, slots });
      };
      let last: { n: number }[] = [];
      motion = trackPeople(app, {
        onStatus: (state, reason) => {
          provider = state;
          if (state === "unavailable" || state === "ended") post({ type: "motion_status", state: "unavailable", reason, slots: [] });
          else status(last);
        },
        onPeople: (people) => {
          last = people;
          const t = Date.now();
          clipBuf.push({
            t,
            people: people.map((p) => ({
              n: p.n,
              pts: COCO.flatMap((k) => {
                const v = p.points[k];
                return v && v[2] >= 0.3 ? [Math.round(v[0] * 1000) / 1000, Math.round(v[1] * 1000) / 1000] : [-1, -1];
              }),
            })),
          });
          while (clipBuf.length && t - clipBuf[0].t > 3000) clipBuf.shift();
          status(people);
          post({ type: "people", people });
        },
        onActions: (actions) => {
          // One line per detected move, for tuning thresholds from the little dev log.
          console.info("[pose]", actions.map((a) => `p${a.slot + 1}:${a.id}${a.side ? "-" + a.side : ""}`).join(" "));
          post({ type: "motion", actions, held: [], controls: [] });
        },
      });
      return;
    }
    const pick = <T extends string>(v: unknown, allowed: readonly T[]) =>
      (Array.isArray(v) ? v : []).map(String).filter((x): x is T => (allowed as readonly string[]).includes(x));
    const max: 1 | 2 = Number(m.maxPlayers) === 1 ? 1 : 2;
    const session = createMotionSession(app, {
      actions: pick(m.actions, MOTION_ACTION_IDS),
      held: pick(m.held, MOTION_HELD_IDS),
      controls: pick(m.controls, MOTION_CONTROL_IDS).filter((c) => c !== "right-hand-cursor" && c !== "left-hand-cursor"),
      participants: { minimum: 1, maximum: max, assignment: { mode: "spatial" } },
    });
    let last = "";
    const offStatus = session.onStatus((st) => {
      const slots = (st.participants ?? []).map((p) => ({ slot: p.slot, state: p.state }));
      const key = `${st.state}|${st.reason ?? ""}|${slots.map((x) => x.state).join(",")}`;
      if (key === last) return; // status can arrive at the evidence rate; forward changes only
      last = key;
      post({ type: "motion_status", state: st.state, reason: st.reason, slots });
    });
    const offResult = session.onResult((r) => {
      const slotOf = (x: unknown) => (x as { playerSlot?: number }).playerSlot ?? 0;
      const actions = r.actions.filter((a) => a.phase === "confirmed").map((a) => ({ id: a.actionId, side: a.side, slot: slotOf(a) }));
      const held = r.held.filter((h) => h.phase === "active").map((h) => ({ id: h.actionId, side: h.side, slot: slotOf(h) }));
      const controls = r.controls
        .filter((c) => c.state === "active" && typeof c.value === "number")
        .map((c) => ({ id: c.id, value: c.value as number, slot: slotOf(c) }));
      if (actions.length || held.length || controls.length) post({ type: "motion", actions, held, controls });
    });
    motion = {
      close() {
        offStatus();
        offResult();
        session.close();
      },
    };
  };
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
      case "say": {
        const text = typeof m.text === "string" ? m.text.trim().slice(0, 400) : "";
        const done = (ok: boolean, interrupted?: boolean) => m.id != null && post({ type: "said", id: m.id, ok, interrupted });
        if (!text || !app.can("voice.say")) {
          done(false);
          break;
        }
        app.voice
          .say(text, m.interrupt === true ? { interrupt: true } : undefined)
          .then((r) => done(Boolean(r.ok), r.ok ? r.interrupted : undefined))
          .catch(() => done(false));
        break;
      }
      case "motion_start":
        startMotion(m);
        break;
      case "motion_stop":
        stopMotion();
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
      case "moment": {
        const title = typeof m.title === "string" ? m.title.trim().slice(0, 120) : "";
        if (!title) break;
        const strs = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 40)).slice(0, 6) : undefined);
        const now = Date.now();
        const clip = m.clip === "pose" && clipBuf.length ? clipBuf.filter((f) => now - f.t <= CLIP_MS).map((f) => ({ ...f, t: f.t - now })) : undefined;
        opts.onMoment?.({
          id: `m_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          at: now,
          game: opts.title ?? "Game",
          title,
          caption: typeof m.caption === "string" ? m.caption.slice(0, 200) : undefined,
          players: strs(m.players),
          kind: typeof m.kind === "string" ? m.kind.slice(0, 20) : undefined,
          clip: clip?.length ? clip : undefined,
        });
        break;
      }
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
      stopMotion();
      window.removeEventListener("message", onMessage);
    },
  };
}
