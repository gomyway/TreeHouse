import { useLittleApp, useLittleEnter, useLittleTool } from "@kabletv/little-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { authorGame } from "./game/author";
import { findGame, listGames, loadGameHtml, type GameMeta } from "./game/catalog";
import { allMemories, pickHighlights, remember, type Moment } from "./game/memories";
import { playersContext, postMemories, tagMoments } from "./game/memoriesSync";
import { createGameHost, type GameHost, type GameState } from "./game/runner";
import { injectTheme } from "./game/theme";
import type { Player, RoomEvent, Screen } from "./room/model";
import { playerName, useRoom } from "./room/useRoom";
import { CameraCheck, type CameraSet } from "./ui/CameraCheck";
import { AuthoringView, GameView, ReadyView } from "./ui/GameView";
import { Lobby, StatusPill } from "./ui/Lobby";
import { QuestionView, type Answer, type Question } from "./ui/QuestionView";
import { Recap } from "./ui/Recap";
import { Deck } from "./ui/Deck";
import { SLIDES, findSlide } from "./deck/deck";
import { DEMO_CREDITS, DEMO_MOMENTS, DEMO_SCORES } from "./ui/recapDemo";

// The TV side of Little Redwood: a room phones join by code, a catalog of game bundles the
// TV runs in a sandboxed iframe (built-in, stored on the relay, or written live by /author),
// and a quick ask-the-room loop. The agent drives all of it through the tools below.

type View =
  | { kind: "lobby" }
  | { kind: "question" }
  | { kind: "camera"; set: CameraSet }
  | { kind: "deck"; index: number }
  | { kind: "ready"; meta: GameMeta }
  | { kind: "recap"; heading: string; moments: Moment[]; scores?: Record<string, number>; credits?: Moment[] }
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
  ready:
    "A new game the room asked for has just been written and is waiting on screen with the join code. Tell people to join on " +
    "their phones and to say start when everyone is in; then call start_game with that game. Do not start it before someone asks.",
  deck:
    "You are presenting the Little Redwood pitch deck on the TV. When you move to a slide, say its speaker notes in your own " +
    "warm words, in two or three sentences. next_slide and previous_slide move one slide; go_to_slide jumps by number or name; " +
    "read_slide gives the current slide's notes. back_to_lobby ends the presentation.",
  recap:
    "The best moments are replaying on screen next to the leaderboard. React to them in a sentence if asked, " +
    "or say who won. It returns to the lobby by itself; back_to_lobby skips it.",
  camera:
    "A camera check is on screen: it shows what the television's motion tracking sees for each player standing in front of it. " +
    "Encourage people to try both arms up, one arm, a squat, a swipe, arms wide and leaning. back_to_lobby or camera_check with on=false ends it.",
  authoring:
    "A new game is being written from the viewer's idea; it takes one to three minutes and starts by itself when ready. Keep the room " +
    "entertained in a sentence or two if asked, but do not call other tools until it is ready.",
};

const TOOLS: Record<View["kind"], string[]> = {
  lobby: ["read_join_info", "list_games", "start_game", "create_game", "ask_room", "kick_player", "camera_check", "show_memories", "present_deck"],
  question: ["read_join_info", "read_answers", "close_question", "back_to_lobby", "kick_player"],
  game: ["read_join_info", "read_game_state", "tell_game", "stop_game", "kick_player"],
  camera: ["camera_check", "back_to_lobby", "read_join_info"],
  recap: ["back_to_lobby", "read_join_info"],
  ready: ["start_game", "read_join_info", "back_to_lobby", "kick_player"],
  deck: ["next_slide", "previous_slide", "go_to_slide", "read_slide", "back_to_lobby"],
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
  // Dev preview of the recap: open the app with ?recapdemo.
  const [view, setView] = useState<View>(() =>
    new URLSearchParams(location.search).has("deck")
      ? { kind: "deck", index: 0 }
      : new URLSearchParams(location.search).has("recapdemo")
      ? { kind: "recap", heading: "Best moments · demo", moments: DEMO_MOMENTS, scores: DEMO_SCORES, credits: DEMO_CREDITS }
      : { kind: "lobby" },
  );
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
  const sessionMoments = useRef<Moment[]>([]);
  // Everyone who took part in the current game (kept even if they leave before the end), for
  // crediting moments and the crew in memories.
  const sessionRoster = useRef<Map<string, Player>>(new Map());
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

    if (v.kind === "game" && (e.type === "join" || e.type === "rejoin")) sessionRoster.current.set(e.player.id, e.player);
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
    // The host theme kit goes first in the bundle's <head>: shared fonts, palette and sizes.
    const html = await injectTheme(await loadGameHtml(meta), meta.palette);
    hostRef.current?.dispose();
    hostRef.current = null;
    sessionMoments.current = [];
    sessionRoster.current = new Map(roomRef.current.players.filter((p) => p.connected).map((p) => [p.id, p]));
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
      const v = viewRef.current;
      const title = v.kind === "game" ? v.meta.title : "Game";
      let doneHandled = false;
      const host = createGameHost({
        frame,
        app,
        title,
        transport: () => roomRef.current.transport,
        onState: setGameState,
        onMoment: (m) => {
          sessionMoments.current.push(m);
          console.info("[moment]", m.title, m.clip ? `(clip ${m.clip.length} frames)` : "");
        },
        // Game over: save the moments to the TV's memory book, then replay the best ones beside
        // the leaderboard before going back to the lobby.
        onDone: () => {
          if (doneHandled) return; // a game may send done twice
          doneHandled = true;
          const roster = [...sessionRoster.current.values()];
          const moments = tagMoments(sessionMoments.current, roster);
          const scores = gameStateRef.current?.scores;
          const hasScores = !!scores && Object.keys(scores).length > 0;
          // A winner only when one name clearly tops the board with points.
          const ranked = hasScores ? Object.entries(scores!).sort((a, b) => b[1] - a[1]) : [];
          const clear = ranked.length > 0 && ranked[0][1] > 0 && (ranked.length === 1 || ranked[1][1] < ranked[0][1]);
          const at = Date.now();
          const result = hasScores ? { at, game: title, winner: clear ? ranked[0][0] : undefined, scores: scores! } : undefined;
          remember(moments, result);
          // File the game on the Worker too, right away (the host token dies 60 s after the TV leaves).
          if (moments.length || result)
            void postMemories({ credentials: roomRef.current.transport?.credentials?.() ?? null, game: title, at, moments, result, roster });
          sessionMoments.current = [];
          if (!moments.length) return toLobby();
          hostRef.current?.dispose();
          hostRef.current = null;
          setView({ kind: "recap", heading: `Best moments · ${title}`, moments: pickHighlights(moments, 5), scores, credits: moments.filter((m) => m.kind === "award") });
          roomRef.current.transport?.sendScreen("*", { kind: "info", title: "Best moments!", body: "Look at the TV." });
          if (app.can("voice.say")) void app.voice.say("Here are the best moments!");
        },
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
    const v = viewRef.current;
    const q = String(id ?? game ?? "");
    // "start" on the ready screen means the game that is waiting there.
    const meta = (v.kind === "ready" && (!q || findGame([v.meta], q)) ? v.meta : undefined) ?? findGame(list, q);
    if (!meta) return { ok: false, detail: `No game matches "${q}". Available: ${list.map((g) => g.title).join(", ")}.` };
    const blocked = whyNotStart(meta);
    if (blocked) return { ok: false, detail: blocked, say: blocked };
    try {
      await startGame(meta);
      return { detail: `Started ${meta.title} with ${activePlayers.length} players.` };
    } catch (e) {
      return { ok: false, detail: String((e as Error).message) };
    }
  });

  // A game starts only with enough people: meta.minPlayers phones, or anyone at all for a
  // phone-optional (camera) game. Returns a sentence to say when it can't start yet.
  function whyNotStart(meta: GameMeta): string | null {
    const joined = roomRef.current.players.filter((p) => p.connected).length;
    if (meta.phonesRequired === false) return null;
    const need = Math.max(1, meta.minPlayers ?? 1);
    if (joined >= need) return null;
    const code = roomRef.current.code ? ` The code is ${roomRef.current.code.split("").join(" ")}.` : "";
    return joined === 0
      ? `Nobody has joined yet. Scan the code on the TV to play ${meta.title}.${code}`
      : `${meta.title} needs ${need} players and ${joined} ${joined === 1 ? "has" : "have"} joined. Grab another phone!${code}`;
  }

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
      // Who is in the room, with guids, so the runner can seed the game with "Room memory".
      { players: playersContext(roomRef.current.players) },
    )
      .then(async (meta) => {
        if (authorAbort.current !== ctl) return;
        authorAbort.current = null;
        const list = await refreshGames();
        const ready = list.find((g) => g.id === meta.id) ?? meta;
        // Never auto-start: show it with the join code and wait for "start".
        setView({ kind: "ready", meta: ready });
        roomRef.current.transport?.sendScreen("*", { kind: "info", title: `${ready.title} is ready!`, body: "Say start when everyone is in." });
        if (app.can("voice.say")) void app.voice.say(`${ready.title} is ready! Join on your phones, and say start when everyone is in.`);
      })
      .catch((e: Error) => {
        if (authorAbort.current !== ctl) return;
        authorAbort.current = null;
        setView((v) => (v.kind === "authoring" ? { ...v, error: e.message } : v));
      });
    return { detail: "Started writing the game. It takes one to three minutes; then it waits on screen until someone says start.", say: "Ooh, I like it. Give me a minute or two to build that." };
  });

  // ---- Presentation ----
  const showSlide = (i: number) => {
    const k = Math.max(0, Math.min(SLIDES.length - 1, i));
    setView({ kind: "deck", index: k });
    const sl = SLIDES[k];
    return { detail: JSON.stringify({ slide: sl.n, of: SLIDES.length, title: sl.title, notes: sl.notes }), say: sl.notes };
  };
  useLittleTool<{ slide?: unknown }>("present_deck", ({ slide }) => showSlide(findSlide(slide as string | number | undefined) ?? 0));
  useLittleTool("next_slide", () => {
    const v = viewRef.current;
    if (v.kind !== "deck") return showSlide(0);
    if (v.index + 1 >= SLIDES.length) return { detail: "That was the last slide.", say: "That's the end of our deck. Thanks for watching!" };
    return showSlide(v.index + 1);
  });
  useLittleTool("previous_slide", () => {
    const v = viewRef.current;
    return showSlide(v.kind === "deck" ? v.index - 1 : 0);
  });
  useLittleTool<{ slide?: unknown }>("go_to_slide", ({ slide }) => {
    const i = findSlide(slide as string | number | undefined);
    if (i === null) return { ok: false, detail: `No slide matches "${String(slide)}". There are ${SLIDES.length}: ${SLIDES.map((x) => `${x.n} ${x.title}`).join("; ")}` };
    return showSlide(i);
  });
  useLittleTool("read_slide", () => {
    const v = viewRef.current;
    const sl = SLIDES[v.kind === "deck" ? v.index : 0];
    return { detail: JSON.stringify({ slide: sl.n, of: SLIDES.length, title: sl.title, notes: sl.notes }) };
  });

  // ---- Memories ----
  useLittleTool("show_memories", () => {
    const book = allMemories();
    if (!book.moments.length) return { ok: false, detail: "No memories yet: play a game first." };
    const wins: Record<string, number> = {};
    for (const r of book.results) if (r.winner) wins[r.winner] = (wins[r.winner] ?? 0) + 1;
    const moments = pickHighlights(book.moments, 8);
    setView({ kind: "recap", heading: "Best moments on this TV", moments, scores: Object.keys(wins).length ? wins : undefined });
    return {
      detail: JSON.stringify({ moments: book.moments.length, games: book.results.length, showing: moments.map((m) => m.title), winsByPlayer: wins }),
    };
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
      if (v.kind === "ready" && e.key === "Enter") {
        const blocked = whyNotStart(v.meta);
        if (blocked) {
          if (app.can("voice.say")) void app.voice.say(blocked);
        } else void startGame(v.meta);
        return;
      }
      if (v.kind === "deck") {
        if (e.key === "ArrowRight" || e.key === "Enter") setView({ kind: "deck", index: Math.min(SLIDES.length - 1, v.index + 1) });
        if (e.key === "ArrowLeft") setView({ kind: "deck", index: Math.max(0, v.index - 1) });
        return;
      }
      if (v.kind !== "lobby") return;
      const n = Math.min(6, gamesRef.current.length);
      if (!n) return;
      // Two columns: left/right within a row, up/down between rows.
      if (e.key === "ArrowRight") setFocus((f) => Math.min(n - 1, f + 1));
      if (e.key === "ArrowLeft") setFocus((f) => Math.max(0, f - 1));
      if (e.key === "ArrowDown") setFocus((f) => (f + 2 < n ? f + 2 : f));
      if (e.key === "ArrowUp") setFocus((f) => (f - 2 >= 0 ? f - 2 : f));
      if (e.key === "Enter") {
        const g = gamesRef.current[Math.min(focus, n - 1)];
        if (!g) return;
        const blocked = whyNotStart(g);
        if (blocked) {
          if (app.can("voice.say")) void app.voice.say(blocked);
        } else void startGame(g);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [app, focus, startGame, toLobby]);

  if (view.kind === "deck") {
    return (
      <div className="stage stage-game">
        <Deck index={view.index} />
      </div>
    );
  }

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
      ) : view.kind === "recap" ? (
        <Recap key={view.heading + view.moments.length} heading={view.heading} moments={view.moments} scores={view.scores} credits={view.credits} onFinished={toLobby} />
      ) : view.kind === "camera" ? (
        <CameraCheck key={view.set} set={view.set} />
      ) : view.kind === "ready" ? (
        <ReadyView
          title={view.meta.title}
          description={view.meta.description}
          minPlayers={view.meta.minPlayers ?? 1}
          phonesOptional={view.meta.phonesRequired === false}
          code={room.code}
          joinUrl={room.joinUrl}
          players={activePlayers}
        />
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
