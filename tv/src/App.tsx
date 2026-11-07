import { useLittleApp, useLittleEnter, useLittleTool } from "@kabletv/little-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { authorGame } from "./game/author";
import { findGame, listGames, loadGameHtml, type GameMeta } from "./game/catalog";
import { createGameHost, type GameHost, type GameState } from "./game/runner";
import type { Player, RoomEvent, Screen } from "./room/model";
import { playerName, useRoom } from "./room/useRoom";
import { CameraCheck, type CameraSet } from "./ui/CameraCheck";
import { AuthoringView, GameView } from "./ui/GameView";
import { Lobby, StatusPill } from "./ui/Lobby";
import { QuestionView, type Answer, type Question } from "./ui/QuestionView";

// The TV side of Little Redwood: a room phones join by code, a catalog of game bundles the
// TV runs in a sandboxed iframe (built-in, stored on the relay, or written live by /author),
// and a quick ask-the-room loop. The agent drives all of it through the tools below.

type View =
  | { kind: "lobby" }
  | { kind: "question" }
  | { kind: "camera"; set: CameraSet }
  | { kind: "game"; meta: GameMeta; html: string }
  | { kind: "authoring"; prompt: string; status: string; elapsedMs: number; error?: string };

const GUIDES: Record<View["kind"], string> = {
  lobby:
    "You are the host of Little Redwood, a party room people join from their phones. Read the join code aloud letter by letter " +
    "when asked (read_join_info). To play, use list_games and start_game; Who's the Bot? is the house favourite. If the viewer " +
    "describes a new game, call create_game with their description. ask_room polls everyone's phones. Keep spoken lines short and warm.",
  question:
    "A question is open on everyone's phone. Use read_answers to see who has answered. When most people have answered or the viewer " +
    "says so, call close_question, then react to the results in one or two playful sentences, naming a few players.",
  game:
    "A game is running on the TV and phones. The game speaks its own lines; do not repeat them. Use read_game_state to answer " +
    "questions about the score or what is happening. Pass the viewer's instructions for the game (skip, reveal, make it harder, " +
    "add a bot, change the topic) to tell_game verbatim. stop_game returns to the lobby.",
  camera:
    "A camera check is on screen: it shows what the television's motion tracking sees for each player standing in front of it. " +
    "Encourage people to try both arms up, one arm, a squat, a swipe, arms wide and leaning. back_to_lobby or camera_check with on=false ends it.",
  authoring:
    "A new game is being written from the viewer's idea; it takes one to three minutes and starts by itself when ready. Keep the room " +
    "entertained in a sentence or two if asked, but do not call other tools until it is ready.",
};

const TOOLS: Record<View["kind"], string[]> = {
  lobby: ["read_join_info", "list_games", "start_game", "create_game", "ask_room", "kick_player", "camera_check"],
  question: ["read_join_info", "read_answers", "close_question", "back_to_lobby", "kick_player"],
  game: ["read_join_info", "read_game_state", "tell_game", "stop_game", "kick_player"],
  camera: ["camera_check", "back_to_lobby", "read_join_info"],
  authoring: ["read_join_info", "back_to_lobby"],
};

const LOBBY_SCREEN = (name?: string): Screen => ({ kind: "info", title: name ? `You're in, ${name}!` : "Back in the lobby", body: "Eyes on the TV." });

function screenFor(q: Question): Screen {
  return q.options ? { kind: "buttons", prompt: q.prompt, items: q.options } : { kind: "text", prompt: q.prompt, maxLength: 80 };
}

function parseAnswer(q: Question, data: unknown): Answer | null {
  if (data == null) return null;
  const d = (typeof data === "object" ? data : { value: data }) as Record<string, unknown>;
  if (q.options) {
    const raw = String(d.id ?? d.choice ?? d.value ?? "");
    const opt = q.options.find((o) => o.id === raw) ?? q.options.find((o) => o.label === raw);
    return opt ? { text: opt.label, optionId: opt.id } : null;
  }
  const text = String(d.text ?? d.value ?? "").trim().slice(0, 80);
  return text ? { text } : null;
}

export default function App() {
  const app = useLittleApp();
  const [view, setView] = useState<View>({ kind: "lobby" });
  const viewRef = useRef(view);
  viewRef.current = view;

  const [question, setQuestion] = useState<Question | null>(null);
  const questionRef = useRef<Question | null>(null);
  questionRef.current = question;

  const [games, setGames] = useState<GameMeta[]>([]);
  const gamesRef = useRef(games);
  gamesRef.current = games;
  const [focus, setFocus] = useState(0);

  const [gameState, setGameState] = useState<GameState | null>(null);
  const gameStateRef = useRef<GameState | null>(null);
  gameStateRef.current = gameState;
  const hostRef = useRef<GameHost | null>(null);
  const authorAbort = useRef<AbortController | null>(null);

  const refreshGames = useCallback(async () => {
    const list = await listGames().catch(() => [] as GameMeta[]);
    setGames(list);
    return list;
  }, []);
  useEffect(() => {
    void refreshGames();
  }, [refreshGames]);

  // Batch join announcements so ten people scanning at once is one line, not ten.
  const pendingJoins = useRef<string[]>([]);
  const joinTimer = useRef<number | undefined>(undefined);
  const announceJoin = useCallback(
    (name: string) => {
      pendingJoins.current.push(name);
      clearTimeout(joinTimer.current);
      joinTimer.current = window.setTimeout(() => {
        const names = pendingJoins.current.splice(0);
        if (!names.length || !app.can("voice.say") || viewRef.current.kind === "game") return;
        const line =
          names.length === 1
            ? `Welcome, ${names[0]}!`
            : names.length <= 3
              ? `Welcome, ${names.slice(0, -1).join(", ")} and ${names.at(-1)}!`
              : `Welcome, ${names.slice(0, 2).join(", ")} and ${names.length - 2} more!`;
        void app.voice.say(line);
      }, 1500);
    },
    [app],
  );

  const room = useRoom((e: RoomEvent, players: Player[]) => {
    const t = roomRef.current.transport;
    const v = viewRef.current;
    const host = hostRef.current;

    if (v.kind === "game" && host) {
      if (e.type === "join" || e.type === "rejoin" || e.type === "leave" || e.type === "sync") host.players(players);
      if (e.type === "input") host.input(e.playerId, e.data);
      if (e.type === "sensor") host.sensor(e.playerId, e.kind, e.data);
      return;
    }

    const q = questionRef.current;
    if (e.type === "join" || e.type === "rejoin") {
      if (e.type === "join") announceJoin(e.player.name);
      t?.sendScreen(e.player.id, v.kind === "question" && q?.open ? screenFor(q) : LOBBY_SCREEN(e.player.name));
    } else if (e.type === "input" && v.kind === "question" && q?.open) {
      const answer = parseAnswer(q, e.data);
      if (!answer) return;
      setQuestion((cur) => (cur && cur.id === q.id ? { ...cur, answers: { ...cur.answers, [e.playerId]: answer } } : cur));
      t?.sendScreen(e.playerId, { kind: "info", title: "Got it!", body: `You said: ${answer.text}` });
    }
  });
  const roomRef = useRef(room);
  roomRef.current = room;

  const activePlayers = room.players.filter((p) => p.connected);

  // Steer the agent per view.
  useEffect(() => {
    app.setGuide(GUIDES[view.kind]);
    const tools = TOOLS[view.kind].filter((n) => !(view.kind === "question" && question && !question.open && n === "close_question"));
    app.setActiveTools(tools);
  }, [app, view.kind, question]);

  const toLobby = useCallback(() => {
    hostRef.current?.dispose();
    hostRef.current = null;
    authorAbort.current?.abort();
    authorAbort.current = null;
    setGameState(null);
    setQuestion(null);
    setView({ kind: "lobby" });
    roomRef.current.transport?.sendScreen("*", LOBBY_SCREEN());
    for (const k of ["gyro", "camera", "mic"] as const) roomRef.current.transport?.ask("*", k, false);
  }, []);

  const startGame = useCallback(async (meta: GameMeta) => {
    const html = await loadGameHtml(meta);
    hostRef.current?.dispose();
    hostRef.current = null;
    setGameState(null);
    setQuestion(null);
    setView({ kind: "game", meta, html });
  }, []);

  // The GameView hands us its iframe; we bridge it once the bundle has loaded.
  const onFrame = useCallback(
    (frame: HTMLIFrameElement | null) => {
      hostRef.current?.dispose();
      hostRef.current = null;
      if (!frame) return;
      const host = createGameHost({
        frame,
        app,
        transport: () => roomRef.current.transport,
        onState: setGameState,
        onDone: toLobby,
      });
      hostRef.current = host;
      frame.addEventListener(
        "load",
        () => {
          if (hostRef.current === host) host.start(roomRef.current.players.filter((p) => p.connected), roomRef.current.code);
        },
        { once: true },
      );
    },
    [app, toLobby],
  );

  const summarize = (q: Question) => {
    const names = (id: string) => playerName(roomRef.current.players, id);
    if (q.options) {
      const counts = q.options.map((o) => ({
        option: o.label,
        votes: Object.values(q.answers).filter((a) => a.optionId === o.id).length,
        voters: Object.entries(q.answers).filter(([, a]) => a.optionId === o.id).map(([id]) => names(id)),
      }));
      return { question: q.prompt, answered: Object.keys(q.answers).length, players: activePlayers.length, counts };
    }
    return {
      question: q.prompt,
      answered: Object.keys(q.answers).length,
      players: activePlayers.length,
      answers: Object.entries(q.answers).map(([id, a]) => ({ player: names(id), answer: a.text })),
    };
  };

  useLittleEnter(() => {});

  // ---- Room tools ----
  useLittleTool("read_join_info", () => {
    if (!room.code) return { ok: false, detail: "The room is still being created; try again in a moment." };
    const spelled = room.code.split("").join(" ");
    return {
      detail: JSON.stringify({ code: room.code, joinUrl: room.joinUrl, players: activePlayers.map((p) => p.name) }),
      say: `Scan the code on screen, or go to the link and enter ${spelled}.`,
    };
  });

  useLittleTool<{ id?: string }>("kick_player", ({ id }) => {
    const p = room.players.find((x) => x.id === String(id ?? ""));
    if (!p) return { ok: false, detail: `No player with id ${String(id)}.` };
    room.transport?.kick(p.id);
    return { detail: `Removed ${p.name}.` };
  });

  useLittleTool("back_to_lobby", () => {
    toLobby();
  });

  // ---- Ask-the-room tools ----
  useLittleTool<{ question?: string; options?: unknown }>("ask_room", ({ question: prompt, options }) => {
    const text = String(prompt ?? "").trim().slice(0, 140);
    if (!text) return { ok: false, detail: "ask_room needs a question." };
    if (!activePlayers.length) return { ok: false, detail: "Nobody has joined yet. Invite people to scan the code first." };
    const labels = Array.isArray(options) ? options.map((o) => String(o).trim()).filter(Boolean).slice(0, 6) : [];
    const q: Question = {
      id: `q_${Date.now().toString(36)}`,
      prompt: text,
      options: labels.length >= 2 ? labels.map((label, i) => ({ id: `o${i + 1}`, label: label.slice(0, 40) })) : null,
      answers: {},
      open: true,
    };
    setQuestion(q);
    setView({ kind: "question" });
    room.transport?.sendScreen("*", screenFor(q));
    return { detail: `Asked ${activePlayers.length} phones: "${text}"${q.options ? ` with ${q.options.length} options` : " (free text)"}.` };
  });

  useLittleTool("read_answers", () => {
    const q = questionRef.current;
    if (!q) return { ok: false, detail: "No question has been asked yet." };
    return { detail: JSON.stringify(summarize(q)) };
  });

  useLittleTool("close_question", () => {
    const q = questionRef.current;
    if (!q) return { ok: false, detail: "No question is open." };
    const closed = { ...q, open: false };
    setQuestion(closed);
    room.transport?.sendScreen("*", { kind: "info", title: "Answers are in!", body: "Look at the TV." });
    return { detail: JSON.stringify(summarize(closed)) };
  });

  // ---- Game tools ----
  useLittleTool("list_games", async () => {
    const list = await refreshGames();
    if (!list.length) return { ok: false, detail: "No games could be loaded right now." };
    return { detail: JSON.stringify(list.map((g) => ({ id: g.id, title: g.title, description: g.description, players: `${g.minPlayers ?? 1}-${g.maxPlayers ?? 12}` }))) };
  });

  useLittleTool<{ id?: string; game?: string }>("start_game", async ({ id, game }) => {
    const list = gamesRef.current.length ? gamesRef.current : await refreshGames();
    const meta = findGame(list, String(id ?? game ?? ""));
    if (!meta) return { ok: false, detail: `No game matches "${String(id ?? game ?? "")}". Available: ${list.map((g) => g.title).join(", ")}.` };
    if (!activePlayers.length) return { ok: false, detail: "Nobody has joined yet. Ask people to scan the code first." };
    try {
      await startGame(meta);
      return { detail: `Started ${meta.title} with ${activePlayers.length} players.` };
    } catch (e) {
      return { ok: false, detail: String((e as Error).message) };
    }
  });

  useLittleTool("stop_game", () => {
    if (viewRef.current.kind !== "game") return { ok: false, detail: "No game is running." };
    toLobby();
  });

  useLittleTool<{ text?: string }>("tell_game", ({ text }) => {
    const t = String(text ?? "").trim().slice(0, 300);
    if (!t) return { ok: false, detail: "tell_game needs the viewer's instruction." };
    if (!hostRef.current) return { ok: false, detail: "No game is running." };
    hostRef.current.voice(t);
    return { detail: "Passed to the game." };
  });

  useLittleTool("read_game_state", () => {
    const v = viewRef.current;
    if (v.kind !== "game") return { ok: false, detail: "No game is running." };
    return { detail: JSON.stringify({ game: v.meta.title, ...(gameStateRef.current ?? { phase: "starting", summary: "" }) }) };
  });

  useLittleTool<{ prompt?: string }>("create_game", ({ prompt }) => {
    const idea = String(prompt ?? "").trim().slice(0, 1000);
    if (!idea) return { ok: false, detail: "create_game needs a description of the game." };
    if (viewRef.current.kind === "authoring") return { ok: false, detail: "A game is already being written." };
    const ctl = new AbortController();
    authorAbort.current?.abort();
    authorAbort.current = ctl;
    setView({ kind: "authoring", prompt: idea, status: "queued", elapsedMs: 0 });
    room.transport?.sendScreen("*", { kind: "info", title: "A new game is being written…", body: "Eyes on the TV." });
    authorGame(
      idea,
      (p) => setView((v) => (v.kind === "authoring" && authorAbort.current === ctl ? { ...v, status: p.status, elapsedMs: p.elapsedMs } : v)),
      ctl.signal,
    )
      .then(async (meta) => {
        if (authorAbort.current !== ctl) return;
        authorAbort.current = null;
        await refreshGames();
        if (app.can("voice.say")) void app.voice.say(`Your game is ready: ${meta.title}!`);
        await startGame(meta);
      })
      .catch((e: Error) => {
        if (authorAbort.current !== ctl) return;
        authorAbort.current = null;
        setView((v) => (v.kind === "authoring" ? { ...v, error: e.message } : v));
      });
    return { detail: "Started writing the game. It takes one to three minutes and starts by itself.", say: "Ooh, I like it. Give me a minute or two to build that." };
  });

  // ---- Camera check ----
  useLittleTool<{ on?: unknown; set?: unknown }>("camera_check", ({ on, set }) => {
    const turnOn = on === undefined ? true : on === true || on === "true";
    if (!turnOn) {
      if (viewRef.current.kind === "camera") toLobby();
      return { detail: "Camera check closed." };
    }
    if (viewRef.current.kind === "game") return { ok: false, detail: "Stop the game first." };
    setView({ kind: "camera", set: set === "holds" ? "holds" : "moves" });
    return { detail: "Camera check is on. It shows each player slot left to right with every move it recognizes." };
  });

  // ---- Remote ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = viewRef.current;
      if (e.key === "Escape") {
        if (v.kind !== "lobby") toLobby();
        else void app.exit();
        return;
      }
      if (v.kind !== "lobby") return;
      const n = Math.min(4, gamesRef.current.length);
      if (!n) return;
      if (e.key === "ArrowRight") setFocus((f) => (f + 1) % n);
      if (e.key === "ArrowLeft") setFocus((f) => (f - 1 + n) % n);
      if (e.key === "Enter") {
        const g = gamesRef.current[Math.min(focus, n - 1)];
        if (g && roomRef.current.players.some((p) => p.connected)) void startGame(g);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [app, focus, startGame, toLobby]);

  if (view.kind === "game") {
    return (
      <div className="stage stage-game">
        <GameView title={view.meta.title} html={view.html} code={room.code} state={gameState} onFrame={onFrame} />
      </div>
    );
  }

  return (
    <div className="stage">
      <header className="topbar">
        <div className="brand">
          Little <span>Redwood</span>
        </div>
        <StatusPill status={room.status} />
      </header>

      {view.kind === "question" && question ? (
        <QuestionView question={question} players={activePlayers} />
      ) : view.kind === "camera" ? (
        <CameraCheck key={view.set} set={view.set} />
      ) : view.kind === "authoring" ? (
        <AuthoringView prompt={view.prompt} status={view.status} elapsedMs={view.elapsedMs} error={view.error} />
      ) : (
        <Lobby
          code={room.code}
          joinUrl={room.joinUrl}
          players={activePlayers}
          status={room.status}
          games={games}
          focus={focus}
          onPick={(g) => void startGame(g)}
        />
      )}
    </div>
  );
}
