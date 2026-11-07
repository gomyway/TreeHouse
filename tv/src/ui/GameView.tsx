import { useEffect, useRef } from "react";
import type { GameState } from "../game/runner";

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
