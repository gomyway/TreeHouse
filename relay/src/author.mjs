// Authoring manager: POST /author { prompt, context? } → { id, meta }. Claude writes a game bundle
// (meta.json + tv.html) against the contract in ../../PLAN.md "Game bundle"; we validate it, retry
// once with the errors fed back, and store it in R2. AUTHOR_FAKE skips the API and stores the sample.
import Anthropic from "@anthropic-ai/sdk";
import { SAMPLE, CORS, cjson, newId, putGame } from "./games.mjs";

const DEFAULT_MODEL = "claude-opus-5-5";
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
const DEADLINE_MS = 90_000;
const MAX_PROMPT_CHARS = 4000;

export const SYSTEM_PROMPT = `You write party games for a television. Each game is a "bundle": a meta.json and a single tv.html page. The TV loads tv.html into a sandboxed iframe (sandbox="allow-scripts", no same-origin) and bridges it to players' phones and to a voice agent. You never see the phones' code; you drive them by posting declarative screens.

# The bridge (window.postMessage, exactly these shapes)

Host → game (listen with window.addEventListener("message", e => { const m = e.data; ... })):
- { type: "init", players: Player[], code: string }  — sent once when the game starts. Start the game here.
- { type: "players", players: Player[] }  — full current list, after any join, rejoin or leave.
- { type: "input", player: playerId, data }  — a phone's input (shapes below).
- { type: "sensor", player: playerId, kind: "gyro" | "camera" | "mic", data }  — sensor readings you asked for.
- { type: "voice", text: string }  — optional: a viewer's spoken instruction relayed by the agent ("skip", "make it harder"). Handle it sensibly or ignore it.
Player = { id: string, name: string, connected: boolean }. Players can join mid-game, leave, and come back with the same id: send late joiners the current screen.

Game → host (window.parent.postMessage(msg, "*")):
- { type: "screen", to: playerId | "*", screen: Screen }  — what a phone shows now.
- { type: "ask", to: playerId | "*", kind: "gyro" | "camera" | "mic", on: boolean, hz?: number }  — start/stop a phone sensor.
- { type: "play", to: playerId | "*", text?: string, url?: string }  — make a phone speak text or play a sound (url must be a data: URL).
- { type: "say", text: string }  — the TV's voice agent says this aloud. Use for announcements: round starts, results, winners. Keep it to one or two short sentences.
- { type: "state", summary: string, phase: string, scores?: { [playerName]: number } }  — post after every meaningful change. summary is plain English the agent reads to narrate and to answer "who's winning?"; phase is one of meta.phases.
- { type: "done" }  — the game is over; the host returns to the lobby. Post it a few seconds after showing final results.

Screen kinds (the phone renders these; nothing else exists):
- { kind: "info", title: string, body?: string }
- { kind: "buttons", prompt?: string, items: { id: string, label: string }[] }  → input data { kind: "button", id }
- { kind: "text", prompt: string, maxLength?: number, placeholder?: string }  → input data { kind: "text", text }
- { kind: "pad", label?: string }  → a touch joystick streaming input data { kind: "pad", x, y } (each -1..1) at ~20 Hz
- { kind: "custom", html: string }  → your own self-contained HTML in a sandboxed iframe on the phone; it sends input with parent.postMessage({ type: "input", data }, "*"). Use only when the declarative kinds cannot express the interaction.
Sensors: "gyro" sends orientation/motion readings at hz; "camera" sends a JPEG data URL snapshot (hz 0 = one snapshot); "mic" sends loudness levels. Phones disable a buttons screen after one tap, so send a fresh screen for each new question.

# Rules for tv.html
- One complete HTML document, fully self-contained: inline <style> and <script> only. No external scripts, stylesheets, fonts, images, CDNs or URLs of any kind; no fetch, XMLHttpRequest, WebSocket, EventSource, import(), localStorage or cookies (the sandbox blocks them). Draw with CSS, inline SVG or canvas; emoji are fine.
- It is shown on a television seen from 3 metres: dark theme, high contrast, body text no smaller than about 4vh, headlines about 10vh or more, size everything in vh/vw, no scrolling, one idea on screen at a time.
- Before init arrives, show a short "waiting" title. All game logic lives in tv.html; the host does nothing but forward messages.
- Be robust: ignore unknown message types and malformed input, never assume a player id is known, cope with 1 player, end rounds on a timer as well as when everyone has answered, guard timeouts so a stale one cannot fire after the phase moved on.
- Keep it compact and readable (a few hundred lines at most). Never put three backticks inside the HTML.

# meta.json
{ "title": string, "description": string (one or two sentences a TV agent can read aloud), "phases": string[] (the phase names your state messages use), "minPlayers": number, "maxPlayers": number }
Do not include id, createdAt or prompt; the server adds them.

# Output format
Reply with exactly two fenced code blocks and nothing else: first \`\`\`json with meta.json, then \`\`\`html with tv.html.

# Reference implementation
This sample bundle follows the contract exactly. Match its bridge handling and TV sizing; invent your own game.

\`\`\`json
${JSON.stringify((({ id, createdAt, prompt, ...m }) => m)(SAMPLE.meta), null, 2)}
\`\`\`

\`\`\`html
${SAMPLE.tv.trim()}
\`\`\``;

// ---- parsing and validation ----
function extractBlocks(text) {
  const fence = (lang) => {
    const m = text.match(new RegExp("```" + lang + "[^\\n]*\\n"));
    if (!m) return null;
    const start = m.index + m[0].length;
    return { start, text: text.slice(start) };
  };
  let metaRaw = null, html = null;
  const j = fence("json");
  if (j) { const end = j.text.indexOf("```"); metaRaw = end >= 0 ? j.text.slice(0, end) : null; }
  const h = fence("html");
  if (h) { const end = h.text.lastIndexOf("```"); html = end >= 0 ? h.text.slice(0, end) : h.text; }
  if (html === null) { // no html fence: take the document itself
    const s = text.search(/<!doctype html|<html[\s>]/i), e = text.toLowerCase().lastIndexOf("</html>");
    if (s >= 0 && e > s) html = text.slice(s, e + 7);
  }
  if (metaRaw === null) { // no json fence: first {...} before the html
    const before = text.slice(0, h ? h.start : text.length);
    const s = before.indexOf("{"), e = before.lastIndexOf("}");
    if (s >= 0 && e > s) { try { JSON.parse(before.slice(s, e + 1)); metaRaw = before.slice(s, e + 1); } catch {} }
  }
  return { metaRaw, html: html?.trim() ?? null };
}

export function validateBundle(text) {
  const errors = [];
  const { metaRaw, html } = extractBlocks(text);
  let meta = null;
  if (metaRaw === null) errors.push("no ```json block with meta.json found");
  else { try { meta = JSON.parse(metaRaw); } catch (e) { errors.push(`meta.json is not valid JSON: ${e.message}`); } }
  if (meta) {
    if (typeof meta.title !== "string" || !meta.title.trim()) errors.push("meta.title must be a non-empty string");
    if (typeof meta.description !== "string" || !meta.description.trim()) errors.push("meta.description must be a non-empty string");
    if (!Array.isArray(meta.phases) || !meta.phases.length || !meta.phases.every((p) => typeof p === "string")) errors.push("meta.phases must be a non-empty array of strings");
    if (!Number.isInteger(meta.minPlayers) || meta.minPlayers < 1) errors.push("meta.minPlayers must be an integer >= 1");
    if (meta.maxPlayers !== undefined && (!Number.isInteger(meta.maxPlayers) || meta.maxPlayers < (meta.minPlayers ?? 1))) errors.push("meta.maxPlayers must be an integer >= minPlayers");
  }
  if (!html) errors.push("no ```html block with tv.html found");
  else {
    if (!/<script[\s>]/i.test(html)) errors.push("tv.html has no inline <script>");
    if (!html.includes("postMessage")) errors.push("tv.html never calls postMessage");
    if (!/addEventListener\(\s*["']message["']|onmessage\s*=/.test(html)) errors.push("tv.html never listens for message events");
    if (!/["'`]init["'`]/.test(html)) errors.push('tv.html does not handle the "init" message');
    if (/<(script|link|img|iframe|audio|video|source)\b[^>]*\b(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html)) errors.push("tv.html loads an external resource; everything must be inline");
    if (/\b(fetch\s*\(|XMLHttpRequest|new\s+WebSocket|EventSource)/.test(html)) errors.push("tv.html uses the network (fetch/XHR/WebSocket/EventSource); it must not");
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, meta, html };
}

// ---- the model call ----
async function generate(env, prompt, context, signal) {
  const model = env.AUTHOR_MODEL || DEFAULT_MODEL;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: DEADLINE_MS });
  const ask = `Write a game bundle for this request:\n\n${prompt}` +
    (context && Object.keys(context).length ? `\n\nContext from the TV (JSON):\n${JSON.stringify(context).slice(0, 4000)}` : "");
  let userText = ask, lastErrors = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const params = {
      model,
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userText }],
    };
    // Server-side refusal fallback where the model supports it (Claude API).
    if (FALLBACK_MODELS.has(model)) { params.betas = ["server-side-fallback-2026-07-01"]; params.fallbacks = "default"; }
    const msg = await client.beta.messages.stream(params, { signal }).finalMessage();
    if (msg.stop_reason === "refusal") throw new Error(`model refused: ${msg.stop_details?.explanation ?? msg.stop_details?.category ?? "no details"}`);
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (msg.stop_reason === "max_tokens") lastErrors = ["the reply was cut off at max_tokens; make tv.html shorter"];
    else {
      const v = validateBundle(text);
      if (v.ok) return { ...v, model: msg.model };
      lastErrors = v.errors;
    }
    // Retry once as a fresh single-turn request carrying the failed attempt and its errors.
    userText = `${ask}\n\nYour previous attempt failed validation:\n- ${lastErrors.join("\n- ")}\n\nPrevious attempt:\n${text.slice(0, 60_000)}\n\nReply again with both fenced blocks, fixed.`;
  }
  throw new Error(`bundle failed validation twice: ${lastErrors.join("; ")}`);
}

export async function handleAuthor(req, env) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return cjson({ error: "POST { prompt, context? }" }, 405);
  let body;
  try { body = await req.json(); } catch { return cjson({ error: "body must be JSON" }, 400); }
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim().slice(0, MAX_PROMPT_CHARS) : "";
  if (!prompt) return cjson({ error: "prompt is required" }, 400);
  const context = body.context && typeof body.context === "object" ? body.context : undefined;

  const id = newId();
  const base = { id, createdAt: new Date().toISOString(), prompt };
  if (env.AUTHOR_FAKE) {
    const { id: _, createdAt: __, prompt: ___, ...m } = SAMPLE.meta;
    // Run the canned reply through the same parser and validator the model's reply goes through.
    const v = validateBundle("```json\n" + JSON.stringify(m, null, 2) + "\n```\n\n```html\n" + SAMPLE.tv + "\n```");
    if (!v.ok) return cjson({ error: v.errors.join("; ") }, 502);
    const meta = { ...v.meta, ...base };
    await putGame(env, meta, v.html);
    return cjson({ id, meta, fake: true });
  }
  if (!env.ANTHROPIC_API_KEY) return cjson({ error: "ANTHROPIC_API_KEY is not set (wrangler secret put ANTHROPIC_API_KEY, or .dev.vars locally)" }, 500);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEADLINE_MS);
  try {
    const { meta: gen, html } = await generate(env, prompt, context, ctrl.signal);
    const meta = {
      title: gen.title.trim().slice(0, 80), description: gen.description.trim().slice(0, 400), phases: gen.phases,
      minPlayers: gen.minPlayers, maxPlayers: gen.maxPlayers ?? Math.max(gen.minPlayers, 12), ...base,
    };
    await putGame(env, meta, html);
    return cjson({ id, meta });
  } catch (e) {
    const msg = ctrl.signal.aborted ? `authoring timed out after ${DEADLINE_MS / 1000} s` : String(e?.message ?? e);
    return cjson({ error: msg }, 502);
  } finally {
    clearTimeout(timer);
  }
}
