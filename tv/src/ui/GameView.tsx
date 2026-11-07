import { useEffect, useRef } from "react";
import type { GameState } from "../game/runner";
import { Qr } from "./Qr";

// Full-screen stage for a running game bundle. The iframe is sandboxed (scripts only, no
// same-origin, no network) and loaded with srcdoc. The host keeps a thin strip on top so
// latecomers can still join and the agent can read the game's state.

export function GameView({
  title,
  html,
  code,
  state,
  onFrame,
}: {
  title: string;
  html: string;
  code: string | null;
  state: GameState | null;
  onFrame: (frame: HTMLIFrameElement | null) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    onFrame(ref.current);
    return () => onFrame(null);
  }, [onFrame]);

  return (
    <main className="game" data-little="region" data-little-label={`Game: ${title}`}>
      <iframe ref={ref} className="game-frame" title={title} sandbox="allow-scripts" srcDoc={html} />
      <div className="game-strip">
        <span className="game-title">{title}</span>
        <span
          className="game-state"
          data-little="readout"
          data-little-label="Game state"
          data-little-data={JSON.stringify({ phase: state?.phase ?? "starting", scores: state?.scores ?? {} })}
        >
          {state?.summary ?? "Starting…"}
        </span>
        {code ? <span className="game-code">Join: {code}</span> : null}
      </div>
    </main>
  );
}

export function AuthoringView({ prompt, status, elapsedMs, error }: { prompt: string; status: string; elapsedMs: number; error?: string }) {
  const steps = ["Reading your idea", "Inventing the rules", "Designing the phone screens", "Building the TV stage", "Play-testing"];
  const step = Math.min(steps.length - 1, Math.floor(elapsedMs / 25_000));
  return (
    <main
      className="authoring"
      data-little="region"
      data-little-label="Writing a game"
      data-little-data={JSON.stringify({ status, seconds: Math.round(elapsedMs / 1000), error: error ?? null })}
    >
      <div className="eyebrow">{error ? "That didn't work" : "Writing your game"}</div>
      <h1 className="prompt">“{prompt}”</h1>
      {error ? (
        <div className="author-error">{error}</div>
      ) : (
        <ol className="author-steps">
          {steps.map((s, i) => (
            <li key={s} className={i < step ? "done" : i === step ? "now" : ""}>
              {s}
            </li>
          ))}
        </ol>
      )}
      <div className="hint">{error ? "Press Back to return to the lobby." : `${Math.round(elapsedMs / 1000)} s · usually 1–3 minutes`}</div>
    </main>
  );
}

/** A freshly written game waits here (never auto-starts) until someone says start. */
export function ReadyView({
  title,
  description,
  minPlayers,
  phonesOptional,
  code,
  joinUrl,
  players,
}: {
  title: string;
  description: string;
  minPlayers: number;
  phonesOptional: boolean;
  code: string | null;
  joinUrl: string | null;
  players: { id: string; name: string; color: string }[];
}) {
  const need = phonesOptional ? 0 : Math.max(1, minPlayers);
  const enough = players.length >= need;
  return (
    <main
      className="ready"
      data-little="region"
      data-little-label={`${title} is ready`}
      data-little-data={JSON.stringify({ title, players: players.length, needs: need, canStart: enough })}
    >
      <section className="ready-main">
        <div className="eyebrow">Your new game is ready</div>
        <h1 className="ready-title">{title}</h1>
        <p className="ready-desc">{description}</p>
        <div className={`ready-cta${enough ? " go" : ""}`} data-little="readout" data-little-label="How to start">
          {enough ? "Say “start” when everyone is in" : `Waiting for ${need - players.length} more player${need - players.length === 1 ? "" : "s"}…`}
        </div>
      </section>
      <section className="ready-side card">
        {joinUrl && code ? (
          <>
            <Qr value={joinUrl} size={260} />
            <div className="code small" aria-label={`Room code ${code.split("").join(" ")}`}>
              {code.split("").map((ch, i) => (
                <span key={i}>{ch}</span>
              ))}
            </div>
          </>
        ) : null}
        <ul className="ready-players">
          {players.map((p) => (
            <li key={p.id} style={{ ["--c" as string]: p.color }}>
              <span className="avatar">{p.name.slice(0, 1).toUpperCase()}</span>
              {p.name}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
