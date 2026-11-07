import { useLittleApp, useLittleEnter, useLittleTool } from "@kabletv/little-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Player, PlayerId, RoomEvent, Screen } from "./room/model";
import { playerName, useRoom } from "./room/useRoom";
import { Qr } from "./ui/Qr";

// The TV side of Little Redwood: a room phones join by code, plus the first end-to-end
// loop from PLAN.md (the TV asks every phone a question and shows the answers). The game
// itself is still being designed; everything here is experience-agnostic.

interface Answer {
  text: string;
  optionId?: string;
}
interface Question {
  id: string;
  prompt: string;
  options: { id: string; label: string }[] | null;
  answers: Record<PlayerId, Answer>;
  open: boolean;
}

const LOBBY_GUIDE =
  "You are the host of Little Redwood, a party room people join from their phones. " +
  "Read the join code aloud letter by letter when asked (read_join_info). " +
  "When the room wants to play or you are asked to poll them, use ask_room with a short, fun question; " +
  "pass 2 to 6 options for a vote, or none for a free-text answer. Keep spoken lines short and warm.";
const QUESTION_GUIDE =
  "A question is open on everyone's phone. Use read_answers to see who has answered. " +
  "When most people have answered or the viewer says so, call close_question, then react to the results " +
  "in one or two playful sentences, naming a few players. back_to_lobby returns to the join screen.";

function screenFor(q: Question): Screen {
  return q.options
    ? { kind: "buttons", prompt: q.prompt, items: q.options }
    : { kind: "text", prompt: q.prompt, maxLength: 80 };
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
  const [question, setQuestion] = useState<Question | null>(null);
  const questionRef = useRef<Question | null>(null);
  questionRef.current = question;

  // Batch join announcements so ten people scanning at once is one line, not ten.
  const pendingJoins = useRef<string[]>([]);
  const joinTimer = useRef<number | undefined>(undefined);
  const announceJoin = useCallback(
    (name: string) => {
      pendingJoins.current.push(name);
      clearTimeout(joinTimer.current);
      joinTimer.current = window.setTimeout(() => {
        const names = pendingJoins.current.splice(0);
        if (!names.length || !app.can("voice.say")) return;
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
    const q = questionRef.current;
    if (e.type === "join" || e.type === "rejoin") {
      if (e.type === "join") announceJoin(e.player.name);
      t?.sendScreen(e.player.id, q?.open ? screenFor(q) : { kind: "info", title: `You're in, ${e.player.name}!`, body: "Eyes on the TV." });
    } else if (e.type === "input" && q?.open) {
      const answer = parseAnswer(q, e.data);
      if (!answer) return;
      setQuestion((cur) => (cur && cur.id === q.id ? { ...cur, answers: { ...cur.answers, [e.playerId]: answer } } : cur));
      t?.sendScreen(e.playerId, { kind: "info", title: "Got it!", body: `You said: ${answer.text}` });
    }
    void players;
  });
  const roomRef = useRef(room);
  roomRef.current = room;

  const activePlayers = room.players.filter((p) => p.connected);

  // Steer the agent per view.
  useEffect(() => {
    app.setGuide(question ? QUESTION_GUIDE : LOBBY_GUIDE);
    app.setActiveTools(
      question
        ? question.open
          ? ["read_join_info", "read_answers", "close_question", "back_to_lobby", "kick_player"]
          : ["read_join_info", "read_answers", "ask_room", "back_to_lobby", "kick_player"]
        : ["read_join_info", "ask_room", "kick_player"],
    );
  }, [app, question]);

  const backToLobby = useCallback(() => {
    setQuestion(null);
    room.transport?.sendScreen("*", { kind: "info", title: "Back in the lobby", body: "Eyes on the TV." });
  }, [room.transport]);

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

  useLittleTool("read_join_info", () => {
    if (!room.code) return { ok: false, detail: "The room is still being created; try again in a moment." };
    const spelled = room.code.split("").join(" ");
    return {
      detail: JSON.stringify({ code: room.code, joinUrl: room.joinUrl, players: activePlayers.map((p) => p.name) }),
      say: `Scan the code on screen, or go to the link and enter ${spelled}.`,
    };
  });

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

  useLittleTool("back_to_lobby", () => {
    backToLobby();
  });

  useLittleTool<{ id?: string }>("kick_player", ({ id }) => {
    const p = room.players.find((x) => x.id === String(id ?? ""));
    if (!p) return { ok: false, detail: `No player with id ${String(id)}.` };
    room.transport?.kick(p.id);
    return { detail: `Removed ${p.name}.` };
  });

  // Remote: Back leaves the question view, then the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (questionRef.current) backToLobby();
      else void app.exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [app, backToLobby]);

  return (
    <div className="stage">
      <header className="topbar">
        <div className="brand">
          Little <span>Redwood</span>
        </div>
        <StatusPill status={room.status} />
      </header>

      {question ? (
        <QuestionView question={question} players={activePlayers} />
      ) : (
        <Lobby code={room.code} joinUrl={room.joinUrl} players={activePlayers} status={room.status} />
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const label = { connecting: "Opening room…", open: "Room open", reconnecting: "Reconnecting…", offline: "Offline" }[status] ?? status;
  return (
    <div className={`pill pill-${status}`} data-little="readout" data-little-label="Room status" data-little-data={JSON.stringify({ status })}>
      <i /> {label}
    </div>
  );
}

function Lobby({ code, joinUrl, players, status }: { code: string | null; joinUrl: string | null; players: Player[]; status: string }) {
  const shortUrl = joinUrl?.replace(/^https?:\/\//, "").replace(/\/?\?c=.*$/, "");
  return (
    <main className="lobby" data-little="region" data-little-label="Lobby">
      <section
        className="join card"
        data-little="readout"
        data-little-label="How to join"
        data-little-data={JSON.stringify({ code, joinUrl, players: players.length })}
      >
        {joinUrl && code ? (
          <>
            <Qr value={joinUrl} size={360} />
            <div className="join-text">
              <div className="eyebrow">Grab your phone</div>
              <div className="join-line">
                Scan, or go to <b>{shortUrl}</b>
              </div>
              <div className="eyebrow">and enter</div>
              <div className="code" aria-label={`Room code ${code.split("").join(" ")}`}>
                {code.split("").map((ch, i) => (
                  <span key={i}>{ch}</span>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="join-wait">{status === "offline" ? "Can't reach the room server." : "Opening a room…"}</div>
        )}
      </section>

      <section className="players card" data-little="region" data-little-label="Players">
        <div className="players-head">
          <span className="eyebrow">In the room</span>
          <span className="count" data-little="readout" data-little-label="Player count" data-little-data={JSON.stringify({ value: players.length })}>
            {players.length}
          </span>
        </div>
        {players.length ? (
          <ul className="player-grid">
            {players.map((p, i) => (
              <li
                key={p.id}
                className="player"
                data-little="item"
                data-little-id={p.id}
                data-little-label={p.name}
                data-little-order={i + 1}
                style={{ ["--c" as string]: p.color }}
              >
                <span className="avatar">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="name">{p.name}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty">Waiting for the first player…</div>
        )}
        <div className="hint">Say “ask everyone…” to poll the room</div>
      </section>
    </main>
  );
}

function QuestionView({ question, players }: { question: Question; players: Player[] }) {
  const answered = Object.keys(question.answers).length;
  const byId = new Map(players.map((p) => [p.id, p]));
  const max = Math.max(1, ...(question.options ?? []).map((o) => Object.values(question.answers).filter((a) => a.optionId === o.id).length));

  return (
    <main className="question" data-little="region" data-little-label="Question">
      <h1 className="prompt" data-little="readout" data-little-label="Question" data-little-data={JSON.stringify({ open: question.open })}>
        {question.prompt}
      </h1>
      <div
        className="progress"
        data-little="readout"
        data-little-label="Answers received"
        data-little-data={JSON.stringify({ answered, players: players.length, open: question.open })}
      >
        {question.open ? `${answered} of ${players.length} answered` : "Answers are in"}
      </div>

      {question.options ? (
        <ul className="bars">
          {question.options.map((o) => {
            const votes = Object.values(question.answers).filter((a) => a.optionId === o.id).length;
            return (
              <li key={o.id} className="bar" data-little="item" data-little-id={o.id} data-little-label={o.label} data-little-data={JSON.stringify({ votes })}>
                <span className="bar-label">{o.label}</span>
                <span className="bar-track">
                  <span className="bar-fill" style={{ width: question.open ? "0%" : `${(votes / max) * 100}%` }} />
                </span>
                <span className="bar-votes">{question.open ? "?" : votes}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="answers">
          {Object.entries(question.answers).map(([id, a]) => {
            const p = byId.get(id);
            return (
              <li key={id} className="answer" style={{ ["--c" as string]: p?.color ?? "#888" }} data-little="item" data-little-id={id} data-little-label={p?.name ?? "Player"} data-little-data={JSON.stringify({ answer: question.open ? null : a.text })}>
                <span className="avatar">{(p?.name ?? "?").slice(0, 1).toUpperCase()}</span>
                <span className="answer-text">{question.open ? "• • •" : a.text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
