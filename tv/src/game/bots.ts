import type { LittleApp } from "@kabletv/little-sdk";
import { pickMostHuman, styleStats } from "../../../shared/humanize";

// AI players as a host service (PLAN.md contract extension):
//   game → host  { type: "bot_answer", id, prompt, humans: string[], imitate?: string[],
//                  caught?: string[], effort?: "joke" | "lazy" | "room", names?: string[] }
//   host → game  { type: "ai_result", id, ok, data: { text } }
// The model writes 4 candidates; code picks the most human one and roughens it to the room's
// measured style. Games must still work when ok is false (they keep a canned fallback).

const SCHEMA = {
  type: "object",
  properties: { candidates: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 6 } },
  required: ["candidates"],
} as const;

export interface BotAnswerRequest {
  prompt: string;
  humans: string[];
  imitate?: string[];
  caught?: string[];
  effort?: "joke" | "lazy" | "room";
  names?: string[];
}

export async function botAnswer(app: LittleApp, req: BotAnswerRequest): Promise<string | null> {
  const stats = styleStats(req.imitate?.length ? req.imitate : req.humans);
  const effort =
    req.effort === "lazy"
      ? "low effort: one to three words, the kind of thing someone types when they can't think of anything"
      : req.effort === "room"
        ? "an in-joke: mention someone in the room by first name or the place you're at (a hackathon), like friends do"
        : "a quick joke, the first funny thing that comes to mind, not a polished one-liner";

  const instruction = [
    "You are a regular person at a house party playing a phone game. You are NOT an assistant.",
    "Everyone answers the prompt on their phone; the room then tries to spot which answer was written by an AI.",
    "Your only goal is to be indistinguishable from the humans. Write 5 very different candidate answers.",
    `Each answer should be ${effort}.`,
    `Match the humans' style: about ${stats.medianLen} characters (never more than ${stats.maxLen}),`,
    `${Math.round(stats.lowerRate * 100)}% of them are all lowercase, ${Math.round(stats.periodRate * 100)}% end with a period,`,
    `${Math.round(stats.emojiRate * 100)}% use an emoji. No dashes, semicolons, quotes, or fancy words. Don't start with "Ah" or "Well".`,
    "Do not copy or closely paraphrase any human answer.",
    req.imitate?.length ? "Write exactly like the person whose earlier answers are in `imitate`: same voice, length and habits." : "",
    req.caught?.length ? "Answers in `caught` were spotted as AI in earlier rounds; avoid whatever made them obvious." : "",
  ]
    .filter(Boolean)
    .join(" ");

  const res = await app.compose({
    instruction,
    schema: SCHEMA as unknown as Record<string, unknown>,
    context: {
      prompt: req.prompt,
      humanAnswersSoFar: req.humans.slice(-12),
      imitate: req.imitate?.slice(-6) ?? [],
      caught: req.caught?.slice(-6) ?? [],
      peopleInTheRoom: req.names?.slice(0, 12) ?? [],
    },
  });
  if (!res.ok) return null;
  const candidates = Array.isArray(res.data.candidates) ? (res.data.candidates as unknown[]).map(String) : [];
  return pickMostHuman(candidates, stats, { existing: req.humans, imitate: req.imitate, rng: Math.random })?.text ?? null;
}
