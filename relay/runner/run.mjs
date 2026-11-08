#!/usr/bin/env node
// Authoring runner (Mac side). Claims authoring jobs from the relay Worker, runs the `pi` coding
// agent inside the little-redwood-author Docker image to write and test a game bundle (meta.json,
// tv.html and the lobby card lobby.html), re-runs the smoke harness on the host as the gate, and
// completes the job with { id, meta, html, lobby? } (which publishes the bundle).
//
//   node runner/run.mjs                  loop forever: claim, author, complete
//   node runner/run.mjs --once           one job, then exit
//   node runner/run.mjs --dry [--once]   skip pi: use the sample bundle as the result (tests the loop)
//   node runner/run.mjs --local "a game where ..."   no relay: author into runner/jobs/<id>/ and stop
//
// Env (falls back to relay/.dev.vars for PUBLISH_TOKEN and FIREWORKS_API_KEY):
//   RELAY_URL       default https://little-redwood-relay.nasloon.workers.dev
//   PUBLISH_TOKEN   sent as x-publish-token on claim/progress/complete
//   RUNNER          runner name reported on claim (default: hostname)
//   FIREWORKS_API_KEY  passed into the container as env, never written to disk
//   AUTHOR_MODEL    default accounts/fireworks/models/gpt-oss-120b
//   AUTHOR_THINKING default low
//   AUTHOR_IMAGE    default little-redwood-author
//   AUTHOR_TIMEOUT_S  agent wall clock, default 360

import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createPiTracker } from "./pi-events.mjs";
import { roomMemorySection, hasHistory } from "./room-memory.mjs";
import { decideScope, applyScope } from "./scope.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_DIR = resolve(HERE, "..");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const ONCE = has("--once");
const DRY = has("--dry");
const LOCAL = has("--local");
const localPrompt = LOCAL ? argv.filter((a) => !a.startsWith("--")).join(" ").trim() : "";
if (LOCAL && !localPrompt) { console.error('usage: node runner/run.mjs --local "describe the game"'); process.exit(2); }

const devVars = (() => {
  const p = join(RELAY_DIR, ".dev.vars");
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
})();
// Only secrets fall back to .dev.vars; its AUTHOR_MODEL etc. belong to the Worker's direct mode.
const env = (k, d) => process.env[k] || (["PUBLISH_TOKEN", "FIREWORKS_API_KEY", "OPENROUTER_API_KEY", "AUTHOR_PROVIDER"].includes(k) ? devVars[k] : undefined) || d;

const RELAY = env("RELAY_URL", "https://little-redwood-relay.nasloon.workers.dev").replace(/\/$/, "");
const TOKEN = env("PUBLISH_TOKEN", "");
const RUNNER = env("RUNNER", hostname());
const PROVIDER = env("AUTHOR_PROVIDER", "fireworks"); // fireworks | openrouter (pi has both built in)
const MODEL = env("AUTHOR_MODEL", PROVIDER === "openrouter" ? "anthropic/claude-opus-5.5" : "accounts/fireworks/models/deepseek-v4p1-flash-1017");
const THINKING = env("AUTHOR_THINKING", "low");
const IMAGE = env("AUTHOR_IMAGE", "little-redwood-author");
const TIMEOUT_S = Number(env("AUTHOR_TIMEOUT_S", 360));
const KEY_NAME = PROVIDER === "openrouter" ? "OPENROUTER_API_KEY" : "FIREWORKS_API_KEY";
const API_KEY = env(KEY_NAME, "");
const POLL_MS = 2000;

const JOBS = join(HERE, "jobs");
const LOGS = join(HERE, "logs");
mkdirSync(JOBS, { recursive: true });
mkdirSync(LOGS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const say = (s) => console.log(`${stamp()} ${s}`);

// ---------- relay calls ----------
async function relay(path, body, method = "POST") {
  const res = await fetch(RELAY + path, {
    method,
    headers: { "content-type": "application/json", "x-publish-token": TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return res;
}

async function claim() {
  const res = await relay("/author/claim", { runner: RUNNER });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`claim ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return await res.json();
}

// ---------- docker ----------
function dockerUp() {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}
async function ensureDocker() {
  if (dockerUp()) return;
  if (process.platform === "darwin") {
    say("Docker daemon is down; starting Docker Desktop");
    spawnSync("open", ["-a", "Docker"]);
    for (let i = 0; i < 45 && !dockerUp(); i++) await sleep(2000);
  }
  if (!dockerUp()) throw new Error("Docker daemon is not running");
}
function ensureImage() {
  if (spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0) return;
  say(`image ${IMAGE} missing; building it (one-time)`);
  const r = spawnSync("docker", ["build", "-t", IMAGE, HERE], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("docker build failed");
}

// ---------- one job ----------
// A reference bundle from the deployed relay, else from ../games/<id>. lobby is null when the bundle has
// no lobby card in either place (a relay that predates /games/:id/lobby.html falls back to the local file).
async function getReference(id) {
  const d = join(RELAY_DIR, "games", id);
  const localLobby = () => { try { return readFileSync(join(d, "lobby.html"), "utf8"); } catch { return null; } };
  const fetchText = async (f) => {
    const r = await fetch(`${RELAY}/games/${id}/${f}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`${f} ${r.status}`);
    return r.text();
  };
  try {
    const [tv, meta] = await Promise.all(["tv.html", "meta.json"].map(fetchText));
    JSON.parse(meta);
    let lobby = null, lobbyFrom = "none";
    try { lobby = await fetchText("lobby.html"); lobbyFrom = "relay"; } catch { lobby = localLobby(); if (lobby !== null) lobbyFrom = "local"; }
    return { tv, meta, lobby, from: "relay", lobbyFrom };
  } catch {
    const lobby = localLobby();
    return { tv: readFileSync(join(d, "tv.html"), "utf8"), meta: readFileSync(join(d, "meta.json"), "utf8"), lobby, from: "local", lobbyFrom: lobby !== null ? "local" : "none" };
  }
}

function slugify(title) {
  const base = String(title ?? "game").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 34).replace(/-+$/, "") || "game";
  const tail = [...randomBytes(4)].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
  return `${base}-${tail}`;
}

async function prepareJobDir(job, log) {
  const dir = join(JOBS, job.jobId);
  mkdirSync(join(dir, "reference"), { recursive: true });
  cpSync(join(HERE, "skill"), join(dir, "skill"), { recursive: true });
  mkdirSync(join(dir, "harness"), { recursive: true });
  cpSync(join(HERE, "harness", "smoke.mjs"), join(dir, "harness", "smoke.mjs"));
  cpSync(join(HERE, "..", "src", "gate.mjs"), join(dir, "harness", "gate.mjs")); // the static gate the harness runs first
  const sample = await getReference("sample");
  writeFileSync(join(dir, "reference", "sample.html"), sample.tv);
  writeFileSync(join(dir, "reference", "sample.meta.json"), sample.meta);
  if (sample.lobby !== null) writeFileSync(join(dir, "reference", "sample.lobby.html"), sample.lobby);
  try {
    const wtb = await getReference("whos-the-bot");
    writeFileSync(join(dir, "reference", "whos-the-bot.html"), wtb.tv);
  } catch {}
  log(`reference bundles from ${sample.from} (sample lobby card from ${sample.lobbyFrom})`);
  if (!existsSync(join(dir, "meta.json"))) writeFileSync(join(dir, "meta.json"), JSON.stringify({
    id: "my-game", title: "", description: "", phases: [], minPlayers: 1, maxPlayers: 8,
  }, null, 2) + "\n");
  const ctx = job.context && Object.keys(job.context).length ? `\n\n## Context from the TV (JSON)\n\n\`\`\`json\n${JSON.stringify(job.context, null, 2).slice(0, 4000)}\n\`\`\`\n` : "";
  // Players + "Room memory" from GET /memories (2 s timeout; empty or "No history yet" on failure).
  const memory = await roomMemorySection(RELAY, job.context).catch(() => "");
  if (memory) log("room memory block added to TASK.md");
  job.memoryInjected = hasHistory(memory); // drives the game's scope (scope.mjs)
  writeFileSync(join(dir, "TASK.md"), `# Game request\n\n${job.prompt}\n${ctx}${memory ? `\n${memory}` : ""}\n## Deliverable\n\nWrite \`meta.json\`, \`tv.html\` and the lobby card \`lobby.html\` in this directory following \`skill/SKILL.md\` and \`skill/CONTRACT.md\`.\nDone means \`node harness/smoke.mjs\` prints SMOKE PASS and the game is fun on a TV.\n`);
  return dir;
}

function runAgent(dir, log, onTick) {
  return new Promise((resolveRun) => {
    const name = `lr-author-${dir.split("/").pop().replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 40)}-${Date.now() % 100000}`;
  const task = "You are building a party game bundle in /job for the people in the room. Read /job/TASK.md, then /job/skill/SKILL.md (its Design rules are non-negotiable), /job/skill/CONTRACT.md, /job/reference/sample.html and /job/reference/sample.lobby.html; read /job/reference/whos-the-bot.html for how to tier roles only: it predates the look and voice rules, so never copy its styling, weights, emoji or long say lines; /job/reference/sample.html is the look reference. " +
    "Build the game TASK.md asks for, with every feature it names, cast with the joined players: their real names, an actionable phone screen for every player every round, rotating active roles with everyone else judging/betting/voting, no invented player characters or NPC contestants. The sample shows the bridge and TV sizing only, do not reskin it. " +
    "Write /job/meta.json and /job/tv.html (write tv.html whole in one go, then edit), then the lobby card /job/lobby.html (SKILL.md \"Lobby card\": the game's name as art, a backdrop from its motifs, the room as its seats, the join URL and code, the hook, a ready status line, idle motion). Run `node harness/smoke.mjs` from /job and fix every failure until it prints SMOKE PASS. " +
    "Then re-read TASK.md and the design rules, check each is met in tv.html, add what is missing, and improve the fun (clear hook, say lines, reveal naming players, winner), re-running the harness after each change. Finish only when it passes.";
    const args = ["run", "--rm", "--name", name,
      "--memory", "2g", "--cpus", "2",
      "-v", `${dir}:/job`, "-w", "/job",
      "-e", KEY_NAME,
      IMAGE,
      "pi", "-p", "--mode", "json", "--no-session", "--offline", "--no-context-files",
      "--skill", "/job/skill",
      "--provider", PROVIDER, "--model", MODEL, "--thinking", THINKING,
      task];
    log(`docker ${args.slice(0, -1).join(" ")} "<task>"`);
    const t0 = Date.now();
    const child = spawn("docker", args, { env: { ...process.env, [KEY_NAME]: API_KEY }, stdio: ["ignore", "pipe", "pipe"] });
    const pi = createPiTracker();
    const trace = join(LOGS, `${dir.split("/").pop()}.pi.jsonl`); // full event stream, for debugging
    child.stdout.on("data", (b) => { appendFileSync(trace, b); for (const l of pi.feed(b.toString())) log(`  ${l}`, true); });
    child.stderr.on("data", (b) => log(b.toString().replace(/\n$/, ""), true));
    let timedOut = false;
    const killer = setTimeout(() => { timedOut = true; log(`agent timed out after ${TIMEOUT_S} s; killing ${name}`); spawnSync("docker", ["kill", name], { stdio: "ignore" }); }, TIMEOUT_S * 1000);
    const ticker = setInterval(() => onTick(Math.round((Date.now() - t0) / 1000), pi.tally), 30_000);
    current.kill = () => spawnSync("docker", ["kill", name], { stdio: "ignore" });
    child.on("close", (code) => {
      clearTimeout(killer); clearInterval(ticker); current.kill = null;
      resolveRun({ code, timedOut, seconds: Math.round((Date.now() - t0) / 1000), tally: pi.tally });
    });
  });
}

function gate(dir) {
  const r = spawnSync(process.execPath, [join(HERE, "harness", "smoke.mjs"), dir], { encoding: "utf8", timeout: 120_000 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  return { pass: r.status === 0 && /SMOKE PASS/.test(out), out };
}

// A game takes at most 16 players (checkMeta in src/games.mjs): an agent-written maxPlayers above that is
// clamped and logged rather than failing the job.
const MAX_PLAYERS = 16;
function clampMaxPlayers(dir, log) {
  const p = join(dir, "meta.json");
  let meta;
  try { meta = JSON.parse(readFileSync(p, "utf8")); } catch { return; } // the gate reports a broken meta.json
  if (!(Number(meta?.maxPlayers) > MAX_PLAYERS)) return;
  log(`meta.maxPlayers ${meta.maxPlayers} clamped to ${MAX_PLAYERS}`);
  meta.maxPlayers = MAX_PLAYERS;
  writeFileSync(p, JSON.stringify(meta, null, 2) + "\n");
}

const current = { jobId: null, kill: null };

async function runJob(job) {
  const logFile = join(LOGS, `${job.jobId}.log`);
  const log = (s, raw = false) => {
    appendFileSync(logFile, raw ? s + "\n" : `${new Date().toISOString()} ${s}\n`);
    if (!raw) say(`[${job.jobId}] ${s}`);
  };
  const progress = async (note) => {
    log(`progress: ${note}`);
    if (LOCAL) return;
    try { await relay(`/author/${encodeURIComponent(job.jobId)}/progress`, { note, runner: RUNNER }); } catch (e) { log(`progress post failed: ${e.message}`); }
  };
  const complete = async (body) => {
    if (LOCAL) return;
    for (let i = 0; i < 3; i++) {
      try {
        const res = await relay(`/author/${encodeURIComponent(job.jobId)}/complete`, { ...body, runner: RUNNER });
        const text = await res.text();
        log(`complete → ${res.status} ${text.slice(0, 300)}`);
        if (res.ok) return true;
        if (res.status < 500) return false;
      } catch (e) { log(`complete failed: ${e.message}`); }
      await sleep(2000);
    }
    return false;
  };

  current.jobId = job.jobId;
  const t0 = Date.now();
  log(`job ${job.jobId} attempt ${job.attempt ?? 1}: ${String(job.prompt).slice(0, 200)}`);
  try {
    await progress(`claimed by ${RUNNER}`);
    const dir = await prepareJobDir(job, log);
    log(`job dir ${dir}`);

    if (DRY) {
      await progress("dry run: using the sample bundle instead of the agent");
      cpSync(join(dir, "reference", "sample.html"), join(dir, "tv.html"));
      if (existsSync(join(dir, "reference", "sample.lobby.html"))) cpSync(join(dir, "reference", "sample.lobby.html"), join(dir, "lobby.html"));
      const m = JSON.parse(readFileSync(join(dir, "reference", "sample.meta.json"), "utf8"));
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...m, title: `${m.title} (dry run)` }, null, 2));
    } else {
      if (!API_KEY) throw new Error(`${KEY_NAME} is not set (env or relay/.dev.vars)`);
      await progress(`agent started (${MODEL.split("/").pop()}, thinking ${THINKING})`);
      const run = await runAgent(dir, log, (s, t) => {
        const wrote = existsSync(join(dir, "tv.html")) ? `, tv.html ${Math.round(statSync(join(dir, "tv.html")).size / 1024)} KB` : "";
        progress(`agent working, ${s} s, ${t.tools} tool calls${wrote}${t.smoke ? `, last smoke ${t.smoke}` : ""}`);
      });
      const t = run.tally;
      await progress(run.timedOut ? `agent timed out after ${run.seconds} s (${t.tools} tool calls)`
        : `agent finished in ${run.seconds} s (exit ${run.code}, ${t.tools} tool calls${t.error ? `, model error: ${t.error.slice(0, 160)}` : ""})`);
    }

    clampMaxPlayers(dir, log); // before the gate, so the harness checks what gets published
    const g = gate(dir);
    writeFileSync(join(dir, "harness-result.txt"), g.out);
    const lastLines = g.out.trim().split("\n").slice(-12).join("\n");
    log(`gate:\n${g.out.trim()}`);
    await progress(g.pass ? "harness PASS" : `harness FAIL: ${lastLines.split("\n").filter((l) => l.startsWith("- ")).slice(0, 3).join(" ").slice(0, 300) || "see log"}`);
    if (!g.pass) {
      const error = `the game did not pass the smoke harness:\n${g.out.trim().slice(-1500)}`;
      await complete({ error });
      return { ok: false, dir, error };
    }

    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    const html = readFileSync(join(dir, "tv.html"), "utf8");
    const lobbyPath = join(dir, "lobby.html");
    const lobby = existsSync(lobbyPath) ? readFileSync(lobbyPath, "utf8") : null;
    const id = slugify(meta.title);
    meta.id = id;
    meta.lobby = lobby !== null; // the runner sets it; the relay stores lobby.html beside tv.html
    delete meta.createdAt;
    delete meta.prompt; // the relay fills in the job prompt
    if (LOCAL) {
      writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
      log(`done in ${Math.round((Date.now() - t0) / 1000)} s: ${dir}/tv.html (id ${id}, not published)`);
      return { ok: true, dir, id };
    }
    const sc = decideScope(job.context, job.memoryInjected);
    applyScope(meta, sc);
    if (sc.note) log(`scope: ${sc.note}`);
    log(`scope ${sc.scope}${sc.scope === "tv" ? ` (tvId ${sc.tvId}, crew ${sc.crew.length}; tvId sent: ${typeof job.context?.tvId === "string"}, memory history: ${!!job.memoryInjected})` : ""}`);
    await progress(`publishing ${id} (scope ${sc.scope}${sc.scope === "tv" ? `, crew ${sc.crew.length}` : ""})`);
    const ok = await complete({ id, meta, html, ...(lobby !== null ? { lobby } : {}) });
    log(`${ok ? "published" : "publish FAILED"} ${id} in ${Math.round((Date.now() - t0) / 1000)} s`);
    return { ok, dir, id };
  } catch (e) {
    log(`error: ${e.stack ?? e.message}`);
    await complete({ error: `runner error: ${e.message}` });
    return { ok: false, error: e.message };
  } finally {
    current.jobId = null;
  }
}

// ---------- main ----------
let stopping = false;
process.on("SIGINT", async () => {
  if (stopping) process.exit(130);
  stopping = true;
  say("stopping (Ctrl-C again to force)");
  if (current.kill) current.kill();
  if (current.jobId && !LOCAL) {
    try { await relay(`/author/${encodeURIComponent(current.jobId)}/complete`, { error: "runner stopped", runner: RUNNER }); } catch {}
  }
  process.exit(130);
});

if (!DRY) { await ensureDocker(); ensureImage(); }

if (LOCAL) {
  const jobId = `local-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
  const r = await runJob({ jobId, prompt: localPrompt, attempt: 1 });
  process.exit(r.ok ? 0 : 1);
}

if (!TOKEN) say("warning: PUBLISH_TOKEN is empty; the relay will refuse claims");
say(`runner ${RUNNER} polling ${RELAY} every ${POLL_MS / 1000} s${DRY ? " (dry run)" : ` (model ${MODEL}, image ${IMAGE})`}`);
let idleNoted = false;
while (!stopping) {
  let job = null;
  try { job = await claim(); }
  catch (e) { say(`claim failed: ${e.message}`); await sleep(/40[13]/.test(e.message) ? 15_000 : 5000); continue; }
  if (!job) {
    if (!idleNoted) { say("idle, waiting for jobs"); idleNoted = true; }
    await sleep(POLL_MS);
    continue;
  }
  idleNoted = false;
  const r = await runJob(job);
  if (ONCE) process.exit(r.ok ? 0 : 1);
}
