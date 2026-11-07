// Authoring manager. A coding model on Fireworks AI writes a game bundle (meta.json + tv.html) against the contract in
// ../../PLAN.md "Game bundle"; we validate it, retry once with the errors fed back, and store it in R2.
// Plain fetch to an OpenAI-compatible chat completions API (no SDK). Default Fireworks; set
// AUTHOR_BASE_URL to use OpenRouter (https://openrouter.ai/api/v1) or any compatible host. The key is
// AUTHOR_API_KEY, else FIREWORKS_API_KEY, else OPENROUTER_API_KEY.
// AUTHOR_FAKE skips the API and stores the sample (after a short delay, so the job states show).
//   POST /author { prompt, context? }        → 202 { jobId, status: "queued" }; the AuthorJob Durable
//                                              Object runs it and writes jobs/<jobId>.json to R2.
//   GET  /author/:jobId                      → that job state, 404 if unknown.
//   POST /author?wait=1 { prompt, context? } → runs inline: { id, meta } or 502 (tests, curl).
// AUTHOR_MODE=runner turns the Worker into a queue instead: POST /author only stores a queued job, and
// an external runner (a Mac running the `pi` agent in Docker) claims it, reports progress and
// completes it through the token-guarded /author/claim, /author/:jobId/{progress,complete} and
// /author/queue routes. Those all run inside one AuthorJob instance named "queue", one at a time,
// so a claim and a complete can never interleave their read-modify-write of a job.
// Why a Durable Object alarm and not ctx.waitUntil: waitUntil is cut off 30 s after the response
// is sent, and one attempt may take 90 s. An alarm handler gets 15 minutes of wall clock.
import { SAMPLE, CORS, cjson, newId, putGame, checkMeta, ID_RE } from "./games.mjs";

const DEFAULT_BASE_URL = "https://api.fireworks.ai/inference/v1";
const chatUrl = (env) => `${(env.AUTHOR_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
const apiKey = (env) => env.AUTHOR_API_KEY || env.FIREWORKS_API_KEY || env.OPENROUTER_API_KEY || "";
const isOpenRouter = (env) => /openrouter\.ai/.test(env.AUTHOR_BASE_URL || "");
// Override with env AUTHOR_MODEL. Alternatives (verify the exact id with
// `curl https://api.fireworks.ai/inference/v1/models -H "Authorization: Bearer $FIREWORKS_API_KEY"`):
//   accounts/fireworks/models/kimi-k2-instruct-0905   (Kimi K2 instruct)
//   accounts/fireworks/models/deepseek-v3p1           (DeepSeek V3.1; also deepseek-v3p2 if listed)
const DEFAULT_MODEL = "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct";
const DEFAULT_MAX_TOKENS = 16000;
const DEFAULT_TEMPERATURE = 0.4;
const DEFAULT_DEADLINE_MS = 240_000; // Opus writes a whole game in one shot; 90 s was too short
const deadlineMs = (env) => Number(env?.AUTHOR_DEADLINE_MS) > 0 ? Number(env.AUTHOR_DEADLINE_MS) : DEFAULT_DEADLINE_MS; // per attempt; with the one retry a job can run about 3 minutes
const FAKE_DELAY_MS = 300;
const JOB_RE = /^[a-z0-9]{12}$/;
const MAX_PROMPT_CHARS = 4000;
const RECLAIM_MS = 8 * 60_000; // a runner job still "running" this long after its claim is reclaimed
const MAX_RUNNER_ATTEMPTS = 3;   // a job reclaimed this many times becomes "error" instead
const LOG_CAP = 50;

export const SYSTEM_PROMPT = `You write party games for a television. Each game is a "bundle": a meta.json and a single tv.html page. The TV loads tv.html into a sandboxed iframe (sandbox="allow-scripts", no same-origin) and bridges it to players' phones and to a voice agent. You never see the phones' code; you drive them by posting declarative screens.

# The bridge (window.postMessage, exactly these shapes)

Host → game (listen with window.addEventListener("message", e => { const m = e.data; ... })):
- { type: "init", players: Player[], code: string }  — sent once when the game starts. Start the game here.
- { type: "players", players: Player[] }  — full current list, after any join, rejoin or leave.
- { type: "input", player: playerId, data }  — a phone's input (shapes below).
- { type: "sensor", player: playerId, kind: "gyro" | "camera" | "mic", data }  — sensor readings you asked for.
- { type: "voice", text: string }  — optional: a viewer's spoken instruction relayed by the agent ("skip", "make it harder"). Handle it sensibly or ignore it.
- { type: "ai_result", id: string, ok: boolean, data?, url?: string, error?: string }  — the answer to one of your "ai" / "ai_image" / "bot_answer" requests (below).
- { type: "motion", actions: { id, side?, slot }[], held: { id, side?, slot }[], controls: { id, value, slot }[] }  — camera motion (see "Camera motion"): actions are confirmed edges (a raise just happened), held are poses held right now, controls are current continuous values. slot is the camera player slot, 0 or 1.
- { type: "motion_status", state: string, reason?: string, slots: { slot, state }[] }  — the camera session's state; "ready" means motion events are flowing.
Player = { id: string, name: string, connected: boolean }. Players can join mid-game, leave, and come back with the same id: send late joiners the current screen.

Game → host (window.parent.postMessage(msg, "*")):
- { type: "screen", to: playerId | "*", screen: Screen }  — what a phone shows now.
- { type: "ask", to: playerId | "*", kind: "gyro" | "camera" | "mic", on: boolean, hz?: number }  — start/stop a phone sensor.
- { type: "play", to: playerId | "*", text?: string, url?: string }  — make a phone speak text or play a sound (url must be a data: URL).
- { type: "say", text: string }  — the TV's voice agent says this aloud. Use for announcements: round starts, results, winners. Keep it to one or two short sentences.
- { type: "state", summary: string, phase: string, scores?: { [playerName]: number } }  — post after every meaningful change. summary is plain English the agent reads to narrate and to answer "who's winning?"; phase is one of meta.phases.
- { type: "done" }  — the game is over; the host returns to the lobby. Post it a few seconds after showing final results.
- {type:"moment", title, caption?, players?: string[], kind?: "funny"|"win"|"fail"|"clutch"|"bot"|"award", clip?: "pose"}: fire and forget, no reply. Send about 3 moments and 2 to 4 kind:"award" moments per game (one award per standout player, title like "Most Robotic Human"); the TV builds the end-of-game recap and credits from them.
- { type: "ai", id: string, instruction: string, context?: any, schema?: JSONSchema }  — the host runs a language model for you (the Little SDK's app.compose) and answers with ai_result. data is the JSON object matching schema when you give one, otherwise text.
- { type: "ai_image", id: string, hint: string }  — the host generates an image (app.image) and answers with ai_result; url is the image to show (set it as an <img> src at runtime).
- { type: "bot_answer", id: string, prompt: string, humans: string[], imitate?: string[], caught?: string[], effort?: "joke" | "lazy" | "room" }  — an AI player's answer to prompt that must pass as human: humans are this round's (or the last round's) human answers so the host can match their style, imitate optional sample answers to resemble, caught answers of bots already spotted (to avoid), effort how hard to try. The host composes several candidates, rejects the ones that read as machine-written, shapes the best to the room (case, punctuation, length, typos) and answers with ai_result whose data is { text }.
- { type: "motion_start", actions?: string[], held?: string[], controls?: string[], maxPlayers?: number }  — ask the TV camera to watch players' bodies for these action, held-pose and control ids (see "Camera motion").
- Prefer motion_start {mode:"people"}: one raw motion stream, figures numbered as slots 0/1, skeleton-based single-arm raises; never open two motion streams.
- In people mode, motion frames also carry poses:[{slot, pose}] (airplane arms, hands on head, lean left/right, squat, jump); single-arm raises are the most reliable, body poses less so.
- { type: "motion_stop" }  — stop the camera session.

# Camera motion
The TV camera can watch players' bodies. Camera games are 2 players max: the camera tracks slots 0 and 1 only, so map those to players yourself and let everyone else play on their phones. Request only what the current phase needs (send a fresh motion_start when the phase changes, motion_stop when no phase needs it): over-asking makes the session flap and lose actions. Design around single-arm raises (left or right arm, reported as side): a both-arms raise is detected weakly, and squats and swipes are not detected at all. The game must stay fully playable if motion_status never reaches "ready": fall back to phone buttons for the same choices.

# AI players and generated content
You never call a model or any API yourself: the only way a game uses AI is the bridge (ai, ai_image, bot_answer, answered by ai_result), which the host runs on the Little SDK; the game has no network. For an AI player's answer that should pass as human, prefer bot_answer over raw "ai": the host then handles style matching and tell removal for you. Use "ai" for bots that play alongside the humans, generated prompts, judging or commentary. id is your own correlation id; the host just echoes it. A result takes a few seconds, so ask early (when a round opens, not when it closes) and keep your own timeout of about 15 s. If ok is false, the result never comes, or data has the wrong shape, keep going with fallback content you wrote into tv.html (canned answers, an emoji instead of an image). The game must be fully playable with every AI call failing. The host makes the call, so the game needs no API key. Never reveal a bot's identity on a phone screen unless the game wants it known. Example, a bot answering in the room's style with a canned fallback:

const pending = {}; let aiSeq = 0;
function ai(instruction, context, schema, fallback, cb) {
  const id = "ai" + (++aiSeq);
  const timer = setTimeout(() => { if (pending[id]) { delete pending[id]; cb(fallback); } }, 15000);
  pending[id] = (m) => { clearTimeout(timer); cb(m.ok && m.data && typeof m.data.answer === "string" && m.data.answer.trim() ? m.data.answer.trim() : fallback); };
  window.parent.postMessage({ type: "ai", id, instruction, context, schema }, "*");
}
// in the message listener: if (m.type === "ai_result" && pending[m.id]) { const f = pending[m.id]; delete pending[m.id]; f(m); }
// when the round opens (myRound guards against a result landing after the phase moved on):
const myRound = round;
ai("You are a human at a party game. Answer the prompt in under 12 words, casual, lowercase, like the example answers. Reply with the answer only.",
   { prompt: question, examples: lastRoundHumanAnswers },
   { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
   CANNED[Math.floor(Math.random() * CANNED.length)],
   (text) => { if (round === myRound) answers.set(BOT_ID, text); });

Screen kinds (the phone renders these; nothing else exists). Every kind also takes deadline?: number (epoch ms, e.g. Date.now() + 45000): the phone shows a big countdown and at zero disables its inputs and shows "Time's up, look at the TV". A text screen then auto-submits what was typed, or sends { kind: "text", text: "", late: true } if nothing was; a buttons screen sends nothing. Phone clocks are within about a second of yours: close the round on your own TV timer and accept answers up to 1.5 s after the deadline.
- { kind: "info", title: string, body?: string }
- { kind: "buttons", prompt?: string, items: { id: string, label: string }[] }  → input data { kind: "button", id }
- { kind: "text", prompt: string, maxLength?: number, placeholder?: string }  → input data { kind: "text", text, late?: true } (the phone shows a live "n/max" counter; default max 140)
- { kind: "pad", label?: string }  → a touch joystick streaming input data { kind: "pad", x, y } (each -1..1) at ~20 Hz
- { kind: "custom", html: string }  → your own self-contained HTML in a sandboxed iframe on the phone; it sends input with parent.postMessage({ type: "input", data }, "*"). Use only when the declarative kinds cannot express the interaction.
Sensors: "gyro" sends orientation/motion readings at hz; "camera" sends a JPEG data URL snapshot (hz 0 = one snapshot); "mic" sends loudness levels. Phones disable a buttons screen after one tap, so send a fresh screen for each new question.

# Rules for tv.html
- One complete HTML document, fully self-contained: inline <style> and <script> only. No external scripts, stylesheets, fonts, images, CDNs or URLs of any kind (the one exception: an image url returned in ai_result); no fetch, XMLHttpRequest, WebSocket, EventSource, import(), localStorage or cookies (the sandbox blocks them). Draw with CSS, inline SVG or canvas; emoji are fine.
- It is shown on a television seen from 3 metres: dark theme, high contrast, body text no smaller than about 4vh, headlines about 10vh or more, size everything in vh/vw, no scrolling, one idea on screen at a time.
- Before init arrives, show a short "waiting" title. All game logic lives in tv.html; the host does nothing but forward messages.
- Be robust: ignore unknown message types and malformed input, never assume a player id is known, cope with 1 player, end rounds on a timer as well as when everyone has answered, guard timeouts so a stale one cannot fire after the phase moved on.
- Keep it compact and readable (a few hundred lines at most). Never put three backticks inside the HTML.

# meta.json
{ "title": string, "description": string (one or two sentences a TV agent can read aloud), "phases": string[] (the phase names your state messages use), "minPlayers": number, "maxPlayers": number }
- meta.phonesRequired (optional, default true): set false only for camera-only games that must start with nobody joined; phones then stay optional for names and bets.
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
// Two attempts, each with its own 90 s deadline. A failed validation retries with the errors fed
// back; a timed-out first attempt retries with the plain request.
async function generate(env, prompt, context, onAttempt) {
  const model = env.AUTHOR_MODEL || DEFAULT_MODEL;
  const num = (v, d) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) ? n : d; };
  const maxTokens = Math.trunc(num(env.AUTHOR_MAX_TOKENS, DEFAULT_MAX_TOKENS));
  const temperature = num(env.AUTHOR_TEMPERATURE, DEFAULT_TEMPERATURE);
  const ask = `Write a game bundle for this request:\n\n${prompt}` +
    (context && Object.keys(context).length ? `\n\nContext from the TV (JSON):\n${JSON.stringify(context).slice(0, 4000)}` : "");
  let userText = ask, lastErrors = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    await onAttempt(attempt);
    const body = {
      model,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userText }],
      max_tokens: maxTokens,
      temperature,
      ...(isOpenRouter(env) ? { provider: { sort: "throughput" } } : {}),
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), deadlineMs(env));
    let data;
    try {
      const res = await fetch(chatUrl(env), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${apiKey(env)}`, ...(isOpenRouter(env) ? { "http-referer": "https://little-redwood-relay.nasloon.workers.dev", "x-title": "little-redwood author" } : {}) },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Fireworks API ${res.status}: ${(await res.text()).slice(0, 2000)}`);
      data = await res.json();
    } catch (e) {
      if (!ctrl.signal.aborted) throw e;
      lastErrors = [`attempt ${attempt} timed out after ${deadlineMs(env) / 1000} s`];
      userText = ask;
      continue;
    } finally {
      clearTimeout(timer);
    }
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("\n") : "";
    if (choice?.finish_reason === "length") lastErrors = ["the reply was cut off at max_tokens; make tv.html shorter"];
    else if (!text) lastErrors = [`the model returned no text (finish_reason ${choice?.finish_reason ?? "missing"})`];
    else {
      const v = validateBundle(text);
      if (v.ok) return { ...v, model: data.model ?? model };
      lastErrors = v.errors;
    }
    // Retry once as a fresh single-turn request carrying the failed attempt and its errors.
    userText = `${ask}\n\nYour previous attempt failed validation:\n- ${lastErrors.join("\n- ")}\n\nPrevious attempt:\n${text.slice(0, 60_000)}\n\nReply again with both fenced blocks, fixed.`;
  }
  throw new Error(`authoring failed twice: ${lastErrors.join("; ")}`);
}

// Generate, validate and store one bundle. Returns { id, meta, fake? }; throws with a readable message.
async function author(env, prompt, context, onAttempt = () => {}) {
  const id = newId();
  const base = { id, createdAt: new Date().toISOString(), prompt };
  if (env.AUTHOR_FAKE) {
    await onAttempt(1);
    await new Promise((r) => setTimeout(r, FAKE_DELAY_MS)); // lets a poller see "running"
    const { id: _, createdAt: __, prompt: ___, ...m } = SAMPLE.meta;
    // Run the canned reply through the same parser and validator the model's reply goes through.
    const v = validateBundle("```json\n" + JSON.stringify(m, null, 2) + "\n```\n\n```html\n" + SAMPLE.tv + "\n```");
    if (!v.ok) throw new Error(v.errors.join("; "));
    const meta = { ...v.meta, ...base };
    await putGame(env, meta, v.html);
    return { id, meta, fake: true };
  }
  const { meta: gen, html } = await generate(env, prompt, context, onAttempt);
  const meta = {
    title: gen.title.trim().slice(0, 80), description: gen.description.trim().slice(0, 400), phases: gen.phases,
    minPlayers: gen.minPlayers, maxPlayers: gen.maxPlayers ?? Math.max(gen.minPlayers, 12), ...base,
  };
  await putGame(env, meta, html);
  return { id, meta };
}

// ---- jobs ----
const jobKey = (jobId) => `jobs/${jobId}.json`;
const putJob = (env, job) => env.GAMES.put(jobKey(job.jobId), JSON.stringify(job), { httpMetadata: { contentType: "application/json" } });
const newJobId = () => newId() + newId().slice(0, 4);

async function runJob(env, job, context) {
  const save = (patch) => { Object.assign(job, patch, { updatedAt: new Date().toISOString() }); return putJob(env, job); };
  try {
    const { id, meta } = await author(env, job.prompt, context, (attempt) => save({ status: "running", attempt }));
    await save({ status: "done", id, meta });
  } catch (e) {
    await save({ status: "error", error: String(e?.message ?? e) });
  }
}

// One instance per job (named by jobId). fetch stores the input and sets an alarm for now; the
// alarm runs the job. Errors are caught inside runJob, so the alarm never throws and never retries.
export class AuthorJob {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(req) {
    const op = new URL(req.url).pathname.slice(1);
    if (op !== "start") { // runner-mode queue operations, on the instance named "queue"
      const body = await req.json();
      let out;
      await this.ctx.blockConcurrencyWhile(async () => { out = await queueOp(this.env, op, body); });
      return out.status === 204 ? new Response(null, { status: 204 }) : Response.json(out.body, { status: out.status });
    }
    await this.ctx.storage.put("input", await req.json());
    await this.ctx.storage.setAlarm(Date.now());
    return new Response(null, { status: 202 });
  }
  async alarm() {
    const input = await this.ctx.storage.get("input");
    if (!input) return;
    try { await runJob(this.env, input.job, input.context); } finally { await this.ctx.storage.deleteAll(); }
  }
}


// ---- runner mode: the queue ----
const isRunner = (env) => (env.AUTHOR_MODE || "direct").trim().toLowerCase() === "runner";
const stamp = () => new Date().toISOString();

async function readJob(env, jobId) {
  if (!JOB_RE.test(jobId)) return null;
  try { return await (await env.GAMES.get(jobKey(jobId)))?.json() ?? null; } catch { return null; }
}

async function listJobs(env) {
  const keys = [];
  let cursor;
  do {
    const page = await env.GAMES.list({ prefix: "jobs/", cursor, limit: 1000 });
    for (const o of page.objects) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const jobs = (await Promise.all(keys.map(async (k) => { try { return await (await env.GAMES.get(k))?.json(); } catch { return null; } })))
    .filter((j) => j && typeof j === "object" && JOB_RE.test(j.jobId ?? ""));
  const t = (j) => { const v = Date.parse(j.createdAt); return Number.isNaN(v) ? Infinity : v; };
  return jobs.sort((a, b) => t(a) - t(b));
}

// The queue operations. Each returns { status, body }. Run serially inside the "queue" instance.
async function queueOp(env, op, body) {
  const reclaimMs = Number(env.AUTHOR_RECLAIM_MS) > 0 ? Number(env.AUTHOR_RECLAIM_MS) : RECLAIM_MS;
  const now = Date.now();
  if (op === "claim") {
    const runner = String(body.runner ?? "").trim().slice(0, 80);
    for (const job of await listJobs(env)) {
      if (job.mode !== "runner") continue;
      const stale = job.status === "running" && now - (Date.parse(job.claimedAt) || 0) > reclaimMs;
      if (job.status !== "queued" && !stale) continue;
      if (stale && (job.attempt ?? 0) >= MAX_RUNNER_ATTEMPTS) { // stop handing out a job that keeps dying
        Object.assign(job, { status: "error", error: `runner ${job.runner} went silent; gave up after ${job.attempt} attempts`, updatedAt: stamp() });
        await putJob(env, job);
        continue;
      }
      if (stale) appendLog(job, `reclaimed from ${job.runner} after ${Math.round((now - Date.parse(job.claimedAt)) / 1000)} s without completing`);
      Object.assign(job, { status: "running", runner, claimedAt: stamp(), updatedAt: stamp(), attempt: (job.attempt ?? 0) + 1 });
      await putJob(env, job);
      return { status: 200, body: job };
    }
    return { status: 204 };
  }
  if (op === "queue") {
    const counts = { queued: 0, running: 0, done: 0, error: 0 };
    const queued = [], running = [];
    for (const j of await listJobs(env)) {
      counts[j.status] = (counts[j.status] ?? 0) + 1;
      if (j.status === "queued") queued.push({ jobId: j.jobId, createdAt: j.createdAt });
      if (j.status === "running") running.push({ jobId: j.jobId, runner: j.runner, claimedAt: j.claimedAt, attempt: j.attempt });
    }
    return { status: 200, body: { counts, queued, running } };
  }
  // progress / complete on one job
  const job = await readJob(env, body.jobId);
  if (!job) return { status: 404, body: { error: "no such job" } };
  const runner = typeof body.runner === "string" && body.runner.trim() ? body.runner.trim() : null;
  if (job.status !== "running") return { status: 409, body: { error: `job is ${job.status}, not running` } };
  if (runner && job.runner && runner !== job.runner) return { status: 409, body: { error: `job belongs to runner ${job.runner}` } };
  if (op === "progress") {
    if (typeof body.note !== "string" || !body.note.trim()) return { status: 400, body: { error: "note is required" } };
    appendLog(job, body.note.trim().slice(0, 500));
    job.updatedAt = stamp();
    await putJob(env, job);
    return { status: 200, body: { jobId: job.jobId, log: job.log } };
  }
  if (op === "complete") {
    if (typeof body.error === "string" && body.error.trim()) {
      Object.assign(job, { status: "error", error: body.error.trim().slice(0, 4000), updatedAt: stamp() });
      await putJob(env, job);
      return { status: 200, body: job };
    }
    const id = body.id;
    if (typeof id !== "string" || !ID_RE.test(id)) return { status: 400, body: { error: "body must be { id, meta, html? } or { error }" } };
    let meta;
    if (body.html !== undefined) { // inline bundle: store it here (same checks as PUT /games/:id)
      const errors = checkMeta(body.meta, id);
      if (typeof body.html !== "string" || !body.html.trim()) errors.push("html missing");
      if (errors.length) return { status: 400, body: { error: errors.join("; ") } };
      meta = { ...body.meta, createdAt: body.meta.createdAt || stamp(), prompt: body.meta.prompt ?? job.prompt };
      await putGame(env, meta, body.html);
    } else { // already published via PUT /games/:id: the stored meta.json is what the TV will load
      try { meta = await (await env.GAMES.get(`${id}/meta.json`))?.json(); } catch { meta = null; }
      if (!meta) return { status: 409, body: { error: `${id}/meta.json is not in the bucket; PUT /games/${id} first or send html inline` } };
    }
    Object.assign(job, { status: "done", id, meta, updatedAt: stamp() });
    await putJob(env, job);
    return { status: 200, body: job };
  }
  return { status: 404, body: { error: "not found" } };
}

function appendLog(job, note) {
  job.log = [...(Array.isArray(job.log) ? job.log : []), `${stamp()} ${note}`].slice(-LOG_CAP);
}

// Token-guarded runner routes: POST /author/claim, GET /author/queue, POST /author/:jobId/{progress,complete}.
async function handleRunner(req, env, op, jobId) {
  if (!env.PUBLISH_TOKEN) return cjson({ error: "runner endpoints are disabled: PUBLISH_TOKEN is not set" }, 503);
  if (req.headers.get("x-publish-token") !== env.PUBLISH_TOKEN) return cjson({ error: "bad publish token" }, 403);
  const want = op === "queue" ? "GET" : "POST";
  if (req.method !== want) return cjson({ error: `${want} only` }, 405);
  let body = {};
  if (want === "POST") {
    try { body = await req.json(); } catch { return cjson({ error: "body must be JSON" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return cjson({ error: "body must be a JSON object" }, 400);
  }
  if (jobId) body = { ...body, jobId };
  const res = await env.AUTHOR_JOB.get(env.AUTHOR_JOB.idFromName("queue"))
    .fetch(`https://job/${op}`, { method: "POST", body: JSON.stringify(body) });
  if (res.status === 204) return new Response(null, { status: 204 });
  return cjson(await res.json(), res.status);
}

// /author, /author/:jobId, and the runner routes
export async function handleAuthor(req, env, url) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const parts = url.pathname.split("/").filter(Boolean); // ["author", jobId | "claim" | "queue", op?]
  if (parts.length === 2 && (parts[1] === "claim" || parts[1] === "queue")) return handleRunner(req, env, parts[1]);
  if (parts.length === 3 && JOB_RE.test(parts[1]) && (parts[2] === "progress" || parts[2] === "complete")) return handleRunner(req, env, parts[2], parts[1]);
  if (parts.length === 2) {
    if (req.method !== "GET" && req.method !== "HEAD") return cjson({ error: "GET /author/:jobId" }, 405);
    const obj = JOB_RE.test(parts[1]) ? await env.GAMES.get(jobKey(parts[1])) : null;
    if (!obj) return cjson({ error: "no such job" }, 404);
    return new Response(await obj.text(), { headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
  }
  if (parts.length !== 1) return cjson({ error: "not found" }, 404);
  if (req.method !== "POST") return cjson({ error: "POST { prompt, context? }" }, 405);
  let body;
  try { body = await req.json(); } catch { return cjson({ error: "body must be JSON" }, 400); }
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim().slice(0, MAX_PROMPT_CHARS) : "";
  if (!prompt) return cjson({ error: "prompt is required" }, 400);
  const context = body.context && typeof body.context === "object" ? body.context : undefined;
  const wait = url.searchParams.has("wait") && url.searchParams.get("wait") !== "0";

  if (isRunner(env)) { // queue only: a runner claims it via POST /author/claim
    if (wait) return cjson({ error: "?wait=1 is only available when AUTHOR_MODE is direct; in runner mode POST /author and poll GET /author/:jobId" }, 400);
    const now = stamp();
    const job = { jobId: newJobId(), mode: "runner", status: "queued", prompt, ...(context ? { context } : {}), createdAt: now, updatedAt: now, attempt: 0, log: [] };
    await putJob(env, job);
    return cjson({ jobId: job.jobId, status: "queued" }, 202);
  }

  if (!env.AUTHOR_FAKE && !apiKey(env)) return cjson({ error: "no authoring API key: set AUTHOR_API_KEY, FIREWORKS_API_KEY or OPENROUTER_API_KEY (wrangler secret put …, or .dev.vars locally)" }, 500);

  if (wait) { // synchronous
    try { return cjson(await author(env, prompt, context)); } catch (e) { return cjson({ error: String(e?.message ?? e) }, 502); }
  }

  const now = new Date().toISOString();
  const job = { jobId: newJobId(), mode: "direct", status: "queued", prompt, createdAt: now, updatedAt: now, attempt: 0 };
  await putJob(env, job);
  const res = await env.AUTHOR_JOB.get(env.AUTHOR_JOB.idFromName(job.jobId)).fetch("https://job/start", { method: "POST", body: JSON.stringify({ job, context }) });
  if (res.status !== 202) {
    job.status = "error"; job.error = `could not start the job (${res.status})`; job.updatedAt = new Date().toISOString();
    await putJob(env, job);
    return cjson(job, 500);
  }
  return cjson({ jobId: job.jobId, status: "queued" }, 202);
}
