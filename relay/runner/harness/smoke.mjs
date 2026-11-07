#!/usr/bin/env node
// Smoke harness for a game bundle (meta.json + tv.html). It plays the role of the TV host:
// loads tv.html into jsdom, sends `init` with 3 fake players, answers every phone screen the game
// shows, answers ai / ai_image / bot_answer requests, and checks that the game keeps going.
//
//   node harness/smoke.mjs [bundleDir]            (default: the current directory)
//   node harness/smoke.mjs --html x/tv.html --meta x/meta.json
//   options: --speed 20 (game clock runs this many times faster than real time)
//            --budget 300 (game-time seconds per pass before giving up)
//            --ai both|ok|fail (which passes to run: AI calls answered + camera ready,
//                              or AI calls failing + camera unavailable)
//            --verbose (print every message)
//
// Exit 0 and a final "SMOKE PASS" line when everything holds; exit 1 and "SMOKE FAIL" otherwise.

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";

// jsdom is resolved with require() so NODE_PATH works (the Docker image installs it globally).
const require = createRequire(import.meta.url);
let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require("jsdom")); }
catch { console.error("SMOKE FAIL\n- jsdom is not installed (npm i jsdom, or set NODE_PATH to a global node_modules)"); process.exit(2); }

// ---------- args ----------
const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf("--" + name); return i >= 0 ? argv[i + 1] : d; };
const flag = (name) => argv.includes("--" + name);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--html", "--meta", "--speed", "--budget", "--ai"].includes(argv[i - 1])));
const dir = resolve(positional[0] ?? ".");
const htmlPath = resolve(opt("html", join(dir, "tv.html")));
const metaPath = resolve(opt("meta", join(dir, "meta.json")));
const SPEED = Number(opt("speed", 20));
const BUDGET_MS = Number(opt("budget", 300)) * 1000;   // game time
const AI_MODE = opt("ai", "both");
const VERBOSE = flag("verbose");

const PLAYERS = [
  { id: "p1", name: "Ada", connected: true },
  { id: "p2", name: "Bo", connected: true },
  { id: "p3", name: "Cy", connected: true },
];
const LATE = { id: "p4", name: "Dee", connected: true };
const TEXTS = ["pizza", "my cat", "a very tired penguin", "nope", "tacos forever", "grandma"];
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const SCREEN_KINDS = new Set(["info", "buttons", "text", "pad", "custom"]);
const INPUT_KINDS = new Set(["buttons", "text", "pad", "custom"]);
const GAME_TYPES = new Set(["screen", "ask", "play", "say", "state", "done", "ai", "ai_image", "bot_answer", "motion_start", "motion_stop"]);

const failures = [];
const warnings = [];
const fail = (s) => failures.push(s);
const warn = (s) => { if (!warnings.includes(s)) warnings.push(s); };
const log = (...a) => console.log(...a);

// ---------- static checks ----------
let meta = null, html = null;
if (!existsSync(metaPath)) fail(`meta.json not found at ${metaPath}`);
else {
  try { meta = JSON.parse(readFileSync(metaPath, "utf8")); } catch (e) { fail(`meta.json is not valid JSON: ${e.message}`); }
}
if (meta) {
  const str = (k) => typeof meta[k] === "string" && meta[k].trim();
  if (!str("id")) fail("meta.id must be a non-empty string");
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(meta.id)) warn(`meta.id "${meta.id}" should be lowercase-kebab (the runner replaces it anyway)`);
  if (!str("title")) fail("meta.title must be a non-empty string");
  if (!str("description")) fail("meta.description must be a non-empty string");
  if (!Array.isArray(meta.phases) || !meta.phases.length || !meta.phases.every((p) => typeof p === "string")) fail("meta.phases must be a non-empty array of strings");
  if (!Number.isInteger(meta.minPlayers) || meta.minPlayers < 1) fail("meta.minPlayers must be an integer >= 1");
  if (meta.maxPlayers !== undefined && (!Number.isInteger(meta.maxPlayers) || meta.maxPlayers < (meta.minPlayers ?? 1))) fail("meta.maxPlayers must be an integer >= minPlayers");
  if (Number.isInteger(meta.minPlayers) && meta.minPlayers > 3) warn(`meta.minPlayers is ${meta.minPlayers}; the harness plays with 3`);
}
if (!existsSync(htmlPath)) fail(`tv.html not found at ${htmlPath}`);
else html = readFileSync(htmlPath, "utf8");
if (html) {
  if (!/<script[\s>]/i.test(html)) fail("tv.html has no inline <script>");
  if (/<script\b[^>]*\bsrc\s*=/i.test(html)) fail("tv.html has a <script src=...>; inline all code");
  // Any src/href attribute in markup that is not data:, blob:, # or empty.
  const attr = /<[a-z][^>]*?\s(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const m of html.matchAll(attr)) {
    const v = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (v && !/^(data:|blob:|#|javascript:void)/i.test(v) && !v.includes("${")) fail(`tv.html references an external resource: ${m[1]}="${v.slice(0, 80)}"`);
  }
  if (/@import\b|url\(\s*["']?(https?:)?\/\//i.test(html)) fail("tv.html CSS loads an external resource (@import or url(http...))");
  const net = html.match(/\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+WebSocket\b|\bWebSocket\s*\(|\bEventSource\b|\bimport\s*\(|\bsendBeacon\b/);
  if (net) fail(`tv.html uses the network (${net[0].trim()}); bundles have no network, use the ai/ai_image/bot_answer bridge`);
  const store = html.match(/\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/);
  if (store) fail(`tv.html uses ${store[1]}; the sandboxed iframe blocks it (keep state in variables)`);
  if (/api\.(openai|anthropic|fireworks)|\/v1\/chat\/completions|api[_-]?key/i.test(html)) fail("tv.html mentions a model API or key; AI goes only through the host bridge");
  if (!/addEventListener\(\s*["']message["']|onmessage\s*=/.test(html)) fail("tv.html never listens for message events");
  if (!/["'`]init["'`]/.test(html)) fail('tv.html does not handle the "init" message');
  if (html.length > 200_000) warn(`tv.html is ${Math.round(html.length / 1024)} KB; keep it compact`);
}

// ---------- one simulated session ----------
function runPass(aiOk) {
  return new Promise((done) => {
    const tag = aiOk ? "ai-ok" : "ai-fail";
    const pf = []; const pw = [];
    const pfail = (s) => { if (!pf.includes(s)) pf.push(s); };
    const pwarn = (s) => { if (!pw.includes(s)) pw.push(s); };
    const errors = [];
    const stats = { motion_start: 0, state: 0, screen: 0, say: 0, ai: 0, ai_image: 0, bot_answer: 0, inputs: 0, ask: 0, play: 0 };
    const seenScreen = new Map();          // playerId -> last screen JSON answered
    const answered = new Map(PLAYERS.map((p) => [p.id, 0]));
    const phaseEntries = new Map();
    let phase = null, inputPhase = null, gotDone = false, firstInputAt = 0;
    let afterInput = { state: 0, screen: 0 };
    let motionOn = 0, motionLive = false;
    let lateJoined = false, lateGotScreen = false, finished = false;
    const realStart = Date.now();
    const timers = [];

    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => {
      const msg = String(e?.message ?? e);
      if (/^Not implemented/.test(msg)) { pwarn(`jsdom: ${msg.split("\n")[0]}`); return; }
      errors.push(msg.split("\n")[0] + (e?.detail?.stack ? " | " + String(e.detail.stack).split("\n").slice(0, 2).join(" ") : ""));
    });
    vc.on("error", (...a) => pwarn("console.error: " + a.map(String).join(" ").slice(0, 160)));
    const onRejection = (r) => errors.push("unhandled promise rejection: " + String(r?.stack ?? r).split("\n")[0]);
    process.on("unhandledRejection", onRejection);

    let window;
    const deliver = (msg, delay = 30) => {
      timers.push(setTimeout(() => {
        if (finished) return;
        if (VERBOSE) log(`  [${tag}] host→game ${JSON.stringify(msg).slice(0, 200)}`);
        try {
          const data = window.JSON.parse(JSON.stringify(msg)); // in the game's realm, as structured clone would
          window.dispatchEvent(new window.MessageEvent("message", { data, origin: "null" }));
        } catch (e) { errors.push("dispatch threw: " + e.message); }
      }, delay));
    };
    const rnd = (a, b) => a + Math.floor(Math.random() * (b - a));

    function fromSchema(s, depth = 0) {
      if (!s || typeof s !== "object" || depth > 4) return "idk lol";
      if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
      const t = Array.isArray(s.type) ? s.type[0] : s.type;
      if (t === "object" || s.properties) return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, fromSchema(v, depth + 1)]));
      if (t === "array") return [fromSchema(s.items, depth + 1)];
      if (t === "number" || t === "integer") return 1;
      if (t === "boolean") return true;
      return "idk lol";
    }

    function answerScreen(pid, screen) {
      const key = JSON.stringify(screen);
      if (seenScreen.get(pid) === key) return;
      seenScreen.set(pid, key);
      if (!screen || !INPUT_KINDS.has(screen.kind)) return;
      if (!firstInputAt) {
        // The round's phase: whatever state the game posts in the same turn as this screen.
        firstInputAt = Date.now();
        timers.push(setTimeout(() => { inputPhase = phase; }, 20));
      }
      const send = (data, delay) => {
        timers.push(setTimeout(() => {
          if (finished || seenScreen.get(pid) !== key) return; // screen replaced before we answered
          stats.inputs++; answered.set(pid, (answered.get(pid) ?? 0) + 1);
          afterInput = { state: 0, screen: 0 };
          deliver({ type: "input", player: pid, data }, 0);
        }, delay));
      };
      if (screen.kind === "buttons") {
        if (!Array.isArray(screen.items) || !screen.items.length) return;
        send({ kind: "button", id: String(screen.items[0].id) }, rnd(80, 400));
      } else if (screen.kind === "text") {
        send({ kind: "text", text: TEXTS[rnd(0, TEXTS.length)] }, rnd(100, 500));
      } else if (screen.kind === "pad") {
        for (let i = 0; i < 20; i++) timers.push(setTimeout(() => { if (!finished && seenScreen.get(pid) === key) deliver({ type: "input", player: pid, data: { kind: "pad", x: Math.sin(i / 3), y: Math.cos(i / 3) } }, 0); }, 50 * i));
        stats.inputs++; answered.set(pid, (answered.get(pid) ?? 0) + 1); afterInput = { state: 0, screen: 0 };
      } else if (screen.kind === "custom") {
        send({ kind: "custom", value: 1 }, rnd(100, 400));
      }
    }

    function checkScreen(s, to) {
      if (!s || typeof s !== "object" || !SCREEN_KINDS.has(s.kind)) { pfail(`screen with unknown kind ${JSON.stringify(s?.kind)} (allowed: ${[...SCREEN_KINDS].join(", ")})`); return false; }
      if (s.kind === "info" && typeof s.title !== "string") pfail("info screen without a string title");
      if (s.kind === "buttons" && (!Array.isArray(s.items) || !s.items.length || !s.items.every((i) => i && typeof i.label === "string" && (typeof i.id === "string" || typeof i.id === "number"))))
        pfail("buttons screen needs items: [{ id, label }, ...] (non-empty)");
      if (s.kind === "text" && typeof s.prompt !== "string") pfail("text screen without a string prompt");
      if (s.kind === "custom" && typeof s.html !== "string") pfail("custom screen without html");
      if (s.deadline !== undefined) {
        const now = window.Date.now();
        if (typeof s.deadline !== "number" || s.deadline < 1e12) pfail(`screen deadline must be epoch ms (Date.now() + ms), got ${JSON.stringify(s.deadline)}`);
        else if (s.deadline < now - 2000) pwarn("a screen was sent with a deadline already in the past");
        else if (s.deadline > now + 10 * 60_000) pwarn("a screen deadline is more than 10 minutes away");
      }
      if (to !== "*" && ![...PLAYERS, LATE].some((p) => p.id === to)) pwarn(`screen sent to unknown player ${JSON.stringify(to)}`);
      return true;
    }

    function onGameMessage(raw) {
      if (finished) return;
      let m;
      try { m = JSON.parse(JSON.stringify(raw)); } catch { pfail("posted a message that is not JSON-serializable"); return; }
      if (VERBOSE) log(`  [${tag}] game→host ${JSON.stringify(m).slice(0, 200)}`);
      if (!m || typeof m.type !== "string") { pwarn("posted a message without a string type"); return; }
      if (!GAME_TYPES.has(m.type)) { pwarn(`posted unknown message type "${m.type}"`); return; }
      switch (m.type) {
        case "state": {
          stats.state++; afterInput.state++;
          if (typeof m.summary !== "string" || !m.summary.trim()) pfail("state.summary must be a non-empty string");
          if (typeof m.phase !== "string") pfail("state.phase must be a string");
          else {
            if (meta && Array.isArray(meta.phases) && !meta.phases.includes(m.phase)) pwarn(`state.phase "${m.phase}" is not in meta.phases`);
            if (m.phase !== phase) { phase = m.phase; phaseEntries.set(phase, (phaseEntries.get(phase) ?? 0) + 1); }
          }
          if (m.scores !== undefined && (typeof m.scores !== "object" || m.scores === null || Array.isArray(m.scores))) pfail("state.scores must be an object { name: number }");
          break;
        }
        case "screen": {
          stats.screen++; afterInput.screen++;
          if (typeof m.to !== "string") { pfail('screen.to must be a player id or "*"'); break; }
          if (!checkScreen(m.screen, m.to)) break;
          if (m.to === LATE.id || (m.to === "*" && lateJoined)) lateGotScreen = true;
          const targets = m.to === "*" ? [...PLAYERS, ...(lateJoined ? [LATE] : [])].map((p) => p.id) : [m.to];
          for (const pid of targets) if (PLAYERS.some((p) => p.id === pid) || pid === LATE.id) answerScreen(pid, m.screen);
          break;
        }
        case "say": stats.say++; if (typeof m.text !== "string") pfail("say.text must be a string"); break;
        case "ask": stats.ask++; if (!["gyro", "camera", "mic"].includes(m.kind)) pfail(`ask.kind must be gyro|camera|mic, got ${JSON.stringify(m.kind)}`); break;
        case "play": stats.play++; if (m.url && !/^data:/.test(m.url)) pfail("play.url must be a data: URL"); break;
        case "done": gotDone = true; timers.push(setTimeout(() => finish("done"), 200)); break;
        case "motion_start": {
          // Camera/motion bridge. ai-ok pass: tracking is ready and a few canned frames arrive.
          // ai-fail pass: the camera never becomes ready, so the game must fall back to phone buttons.
          stats.motion_start++;
          if (!firstInputAt) { firstInputAt = Date.now(); timers.push(setTimeout(() => { inputPhase = phase; }, 20)); } // motion counts as player input
          const list = (k) => (Array.isArray(m[k]) ? m[k].filter((x) => typeof x === "string") : []);
          const actions = list("actions"), held = list("held"), controls = list("controls");
          if (!actions.length && !held.length && !controls.length) pwarn("motion_start without any actions/held/controls");
          if (m.maxPlayers !== undefined && (!Number.isInteger(m.maxPlayers) || m.maxPlayers > 2)) pwarn("motion_start maxPlayers should be 1 or 2 (camera games are 2 players max)");
          motionOn++;
          const gen = motionOn;
          if (!aiOk) { deliver({ type: "motion_status", state: "unavailable", reason: "harness: no camera", slots: [] }, 60); break; }
          deliver({ type: "motion_status", state: "ready", slots: [{ slot: 0, state: "tracking" }, { slot: 1, state: "tracking" }] }, 300 / SPEED);
          for (let i = 0; i < 3; i++) {
            timers.push(setTimeout(() => {
              if (gen !== motionOn || !motionLive) return;
              stats.inputs++; afterInput = { state: 0, screen: 0 };
              deliver({
                type: "motion",
                actions: actions.length ? [{ id: actions[i % actions.length], side: i % 2 ? "right" : "left", slot: i % 2 }] : [],
                held: held.length ? [{ id: held[0], side: "left", slot: 0 }] : [],
                controls: controls.map((id) => ({ id, value: 0.5, slot: 0 })),
              }, 0);
            }, (600 + 700 * i) / SPEED)); // game time: ~0.6 s, 1.3 s, 2 s after start
          }
          motionLive = true;
          break;
        }
        case "motion_stop": motionLive = false; motionOn++; break;
        case "ai": case "ai_image": case "bot_answer": {
          stats[m.type]++;
          if (typeof m.id !== "string" && typeof m.id !== "number") { pfail(`${m.type} request without an id`); break; }
          if (m.type === "ai" && typeof m.instruction !== "string") pfail("ai request needs instruction: string");
          if (m.type === "ai_image" && typeof m.hint !== "string") pfail("ai_image request needs hint: string");
          if (m.type === "bot_answer" && (typeof m.prompt !== "string" || !Array.isArray(m.humans))) pfail("bot_answer request needs prompt: string and humans: string[]");
          let reply;
          if (!aiOk) reply = { type: "ai_result", id: m.id, ok: false, error: "harness: AI unavailable" };
          else if (m.type === "ai_image") reply = { type: "ai_result", id: m.id, ok: true, url: TINY_PNG };
          else if (m.type === "bot_answer") reply = { type: "ai_result", id: m.id, ok: true, data: { text: "idk lol" } };
          else reply = { type: "ai_result", id: m.id, ok: true, data: m.schema ? fromSchema(m.schema) : "idk lol" };
          deliver(reply, rnd(300, 900) / SPEED * 4);
          break;
        }
      }
    }

    // ---------- the window ----------
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole: vc,
      url: "https://bundle.invalid/tv.html",
      beforeParse(w) {
        // Fast clock: timers fire SPEED times sooner and Date/performance run SPEED times faster.
        const RealDate = w.Date, t0 = RealDate.now(), p0 = w.performance.now();
        const warp = () => t0 + (RealDate.now() - t0) * SPEED;
        class WarpDate extends RealDate {
          constructor(...a) { if (a.length === 0) super(warp()); else super(...a); }
          static now() { return Math.floor(warp()); }
        }
        w.Date = WarpDate;
        const pnow = w.performance.now.bind(w.performance);
        try { Object.defineProperty(w.performance, "now", { value: () => p0 + (pnow() - p0) * SPEED, configurable: true }); } catch {}
        const st = w.setTimeout.bind(w), si = w.setInterval.bind(w);
        w.setTimeout = (fn, ms = 0, ...a) => st(fn, Math.max(0, (Number(ms) || 0) / SPEED), ...a);
        w.setInterval = (fn, ms = 0, ...a) => si(fn, Math.max(4, (Number(ms) || 0) / SPEED), ...a);
        // Host side of the bridge: the game posts to window.parent (=== window in jsdom).
        w.postMessage = (msg) => onGameMessage(msg);
        // Canvas: jsdom has none; hand back a no-op 2D context so drawing code runs.
        const noop = () => {};
        const ctx = new Proxy({}, {
          get(t, k) {
            if (k in t) return t[k];
            if (k === "measureText") return (s) => ({ width: String(s).length * 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
            if (k === "getImageData" || k === "createImageData") return (x, y, ww = 1, hh = 1) => ({ width: ww, height: hh, data: new Uint8ClampedArray(Math.max(1, ww * hh * 4)) });
            if (k === "createLinearGradient" || k === "createRadialGradient" || k === "createPattern" || k === "createConicGradient") return () => ({ addColorStop: noop });
            if (k === "getTransform") return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
            if (k === "isPointInPath" || k === "isPointInStroke") return () => false;
            if (k === "getLineDash") return () => [];
            if (k === "canvas") return undefined;
            return noop;
          },
          set(t, k, v) { t[k] = v; return true; },
        });
        w.HTMLCanvasElement.prototype.getContext = function () { return ctx; };
        w.HTMLCanvasElement.prototype.toDataURL = () => TINY_PNG;
        w.HTMLMediaElement.prototype.play = () => Promise.resolve();
        w.HTMLMediaElement.prototype.pause = noop;
        w.addEventListener("unhandledrejection", (e) => errors.push("unhandled promise rejection: " + String(e?.reason?.stack ?? e?.reason).split("\n")[0]));
      },
    });
    window = dom.window;

    function finish(why) {
      if (finished) return;
      finished = true;
      for (const t of timers) clearTimeout(t);
      clearInterval(ticker);
      process.off("unhandledRejection", onRejection);
      const gameMs = (Date.now() - realStart) * SPEED;
      if (errors.length) for (const e of [...new Set(errors)].slice(0, 6)) pfail(`uncaught error: ${e}`);
      if (!stats.state) pfail("never posted a state message");
      if (!stats.screen) pfail("never posted a screen message");
      if (!firstInputAt) pfail("never showed an input screen (buttons/text/pad/custom) or started motion: players have nothing to do");
      const cycles = inputPhase ? (phaseEntries.get(inputPhase) ?? 0) : 0;
      const minAnswered = Math.min(...PLAYERS.map((p) => answered.get(p.id) ?? 0));
      const progressed = gotDone || cycles >= 3 || (cycles >= 2 && phase !== inputPhase) || minAnswered >= 2;
      if (firstInputAt && !progressed) pfail(`stalled: after ${Math.round(gameMs / 1000)} s of game time only ${minAnswered} answer(s) per player and phase "${inputPhase}" entered ${cycles} time(s); expected 2 rounds or a done`);
      if (firstInputAt && !gotDone && (afterInput.state === 0 && afterInput.screen === 0)) pfail("went silent after the last input: no state or screen followed it");
      if (lateJoined && !lateGotScreen) pwarn("a player who joined mid-game got no screen (send late joiners the current screen)");
      if (stats.say === 0) pwarn("never used say: the TV voice should announce rounds and results");
      try { window.close(); } catch {}
      done({ tag, why, pf, pw, stats, gameS: Math.round(gameMs / 1000), realS: ((Date.now() - realStart) / 1000).toFixed(1), cycles, inputPhase, minAnswered, gotDone });
    }

    // ---------- the session script ----------
    deliver({ type: "init", players: PLAYERS, code: "ABCD" }, 50);
    timers.push(setTimeout(() => {
      if (!stats.state || !stats.screen) { pfail(`no ${!stats.state ? "state" : "screen"} within 5 s of init`); finish("startup"); }
    }, 5000));
    const ticker = setInterval(() => {
      if (finished) return;
      const gameMs = (Date.now() - realStart) * SPEED;
      const cycles = inputPhase ? (phaseEntries.get(inputPhase) ?? 0) : 0;
      // A late joiner after the first round-ish, to check they get a screen.
      if (!lateJoined && cycles >= 2) { lateJoined = true; deliver({ type: "players", players: [...PLAYERS, LATE] }, 0); }
      if (cycles >= 3 && afterInput.state + afterInput.screen > 0) return finish("2 rounds");
      if (gameMs > BUDGET_MS) return finish("budget");
    }, 100);
  });
}

// ---------- run ----------
const passes = [];
if (!failures.length) {
  if (AI_MODE === "both" || AI_MODE === "ok") passes.push(await runPass(true));
  if (AI_MODE === "both" || AI_MODE === "fail") passes.push(await runPass(false));
}
for (const p of passes) {
  log(`pass ${p.tag}: ended by ${p.why} after ${p.gameS} s game time (${p.realS} s real); states ${p.stats.state}, screens ${p.stats.screen}, says ${p.stats.say}, inputs sent ${p.stats.inputs}, ai ${p.stats.ai}, ai_image ${p.stats.ai_image}, bot_answer ${p.stats.bot_answer}, motion_start ${p.stats.motion_start}; input phase "${p.inputPhase}" entered ${p.cycles}x; done ${p.gotDone}`);
  for (const f of p.pf) failures.push(`[${p.tag}] ${f}`);
  for (const w of p.pw) warn(`[${p.tag}] ${w}`);
}
for (const w of warnings) log(`warn: ${w}`);
if (failures.length) {
  log("SMOKE FAIL");
  for (const f of failures) log(`- ${f}`);
  process.exit(1);
}
log(`SMOKE PASS (${meta.title})`);
process.exit(0);
