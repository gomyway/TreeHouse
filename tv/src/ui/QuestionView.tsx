import type { Player, PlayerId } from "../room/model";

export interface Answer {
  text: string;
  optionId?: string;
}
export interface Question {
  id: string;
  prompt: string;
  options: { id: string; label: string }[] | null;
  answers: Record<PlayerId, Answer>;
  open: boolean;
}

export function QuestionView({ question, players }: { question: Question; players: Player[] }) {
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
              <li
                key={id}
                className="answer"
                style={{ ["--c" as string]: p?.color ?? "#888" }}
                data-little="item"
                data-little-id={id}
                data-little-label={p?.name ?? "Player"}
                data-little-data={JSON.stringify({ answer: question.open ? null : a.text })}
              >
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
