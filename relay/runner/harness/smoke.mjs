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
// Participation: every joined player (the 4th, late joiner too) must get at least one actionable
// screen (buttons/text/pad/custom) and the pass must send at least 2; both are warnings only when
// meta.phonesRequired is false. Phone buttons that offer invented characters instead of players warn.
// A custom screen whose html never mentions postMessage is display-only (a seat card): it is neither
// counted as an action nor answered.
//
// Look and voice (SKILL.md "Look and voice rules"), read from tv.html's CSS (<style> blocks, style="..."
// attributes anywhere in the file, SVG fill/stroke/stop-color attributes) and from the say lines:
//   FAIL  a colour within ~24 RGB of the purple default family (#b98cff #f6f3ff #ffd23f #3ddc84 #5fe0c0,
//         3/4/8-digit hex, rgb() and hsl() included); WARN above 6 distinct non-greyscale colours.
//   FAIL  font-weight >= 600 / bold / bolder (CSS, inline styles, font shorthand, .style.fontWeight);
//         WARN when <h1>-<h6>, <b>, <strong>, <th> are used without a font-weight <= 500 rule for them;
//         WARN above 3 distinct font-size values (var() resolved through :root custom properties;
//         rules and elements whose class contains "ring", the countdown ring, are ignored).
//   WARN  border-radius >= 50px (99px/999px pills) outside a "ring" selector/element.
//   FAIL  more than 2 emoji in the raw file. Heuristic: every grapheme with an emoji-presentation code
//         point or U+FE0F anywhere in tv.html counts (markup, CSS, JS strings, comments); nothing is
//         subtracted, since player-typed text arrives at runtime and is never in the file. Text glyphs
//         such as ● ▲ ★ ✓ × are not emoji. 2 allows one decorative glyph pair.
//   FAIL  a say line above 12 words (player names not counted); WARN on 2+ exclamation marks or stacked !? in one line.
//   FAIL  meta.palette not one of Noir, Broadcast, Paper, Arcade, Campfire, Lagoon; WARN when absent.
// Roster seats (SKILL.md "Roster seats"):
//   FAIL  meta.seats missing, under 6 or over 12 entries, or an entry whose svg has no <svg> root, viewBox or
//         currentColor, or has a <text> element, an emoji, a <script>/on* handler or an external href/url()
//         (the host renders each as an <img> data: URL with currentColor baked to the player's colour);
//         WARN on a viewBox other than 0 0 48 48 and on <style>/class in a seat svg; WARN when meta.hook is missing.
//   FAIL  under 80% of the distinct TV states (one per distinct state message, phase + summary, sampled
//         right after it) hold a [data-player] seat for every joined player.
//   FAIL  a player whose phone sent an answer (buttons/text/custom) never had a seat with
//         data-state="answered" (a MutationObserver watches the whole pass, so a brief state counts).
//   WARN  no custom phone screen carried one of the seat icons (the phone header may reuse it).
// A "look:" line prints the static checks once (palette, colours, font sizes, max weight, emoji, seats,
// hook); each pass then prints "look <pass>:" with its longest say and its seats result.
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
// A custom screen that never posts is display-only (e.g. a seat card), like info.
const isActionable = (s) => INPUT_KINDS.has(s?.kind) && !(s.kind === "custom" && typeof s.html === "string" && !/postMessage/.test(s.html));
const GAME_TYPES = new Set(["screen", "ask", "play", "say", "state", "done", "ai", "ai_image", "bot_answer", "motion_start", "motion_stop", "moment"]);

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

// ---------- look checks (SKILL.md "Look and voice rules") ----------
// Kept apart from `failures` so a look failure still lets the play-through run (it measures say lines).
const PALETTES = ["Noir", "Broadcast", "Paper", "Arcade", "Campfire", "Lagoon"];
const lookFails = [], lookWarns = [];
const look = analyzeLook(html ?? "", meta);
function analyzeLook(src, meta) {
  const lf = (s) => { if (!lookFails.includes(s)) lookFails.push(s); };
  const lw = (s) => { if (!lookWarns.includes(s)) lookWarns.push(s); };
  const out = { palette: "none", colours: 0, sizes: [], maxWeight: 400, emoji: 0, seats: 0, seatIcons: [], hook: false };
  if (meta && typeof meta === "object") {
    if (meta.palette === undefined) lw(`meta.palette is missing: pick one of ${PALETTES.join(", ")} and use its four tokens`);
    else if (!PALETTES.some((p) => p.toLowerCase() === String(meta.palette).toLowerCase())) lf(`meta.palette ${JSON.stringify(meta.palette)} is not one of ${PALETTES.join(", ")}`);
    else out.palette = meta.palette;
    // Roster seats: the game's icon set, exported for the host's picker.
    const seats = meta.seats;
    if (!Array.isArray(seats)) lf('meta.seats is missing: export the 6 to 12 seat icons as [{ "name", "svg" }] (see "Roster seats")');
    else {
      out.seats = seats.length;
      if (seats.length < 6) lf(`meta.seats has ${seats.length} variant(s): draw 6 to 12 seat icons from the game's world`);
      if (seats.length > 12) lf(`meta.seats has ${seats.length} variants: 6 to 12 (the host draws at most 12)`);
      seats.forEach((e, i) => {
        const svg = typeof e?.svg === "string" ? e.svg : "", label = `meta.seats[${i}]${typeof e?.name === "string" ? ` (${e.name})` : ""}`;
        if (typeof e?.name !== "string" || !e.name.trim()) lf(`meta.seats[${i}] needs a name`);
        if (!/^<svg[\s>]/i.test(svg.trim())) { lf(`${label} svg must have an <svg> root (the host renders it as an <img> data: URL)`); return; }
        const vb = svg.match(/\bviewBox\s*=\s*["']([^"']*)["']/i);
        if (!vb) lf(`${label} svg has no viewBox (use viewBox="0 0 48 48")`);
        else if (vb[1].trim().split(/[\s,]+/).join(" ") !== "0 0 48 48") lw(`${label} svg viewBox is "${vb[1]}"; use "0 0 48 48"`);
        if (/<script\b|\son[a-z]+\s*=/i.test(svg)) lf(`${label} svg has a <script> or an on* handler: seat icons are static paths`);
        const ext = [...svg.matchAll(/\b(?:xlink:)?href\s*=\s*["']([^"']*)["']|url\(\s*["']?([^)"']*)/gi)].map((m) => (m[1] ?? m[2] ?? "").trim()).filter((v) => !v.startsWith("#"));
        if (ext.length || /@import\b/i.test(svg)) lf(`${label} svg references something outside itself (${(ext[0] ?? "@import").slice(0, 60)}): seats must be self-contained`);
        if (/<style\b|\bclass\s*=/i.test(svg)) lw(`${label} svg uses <style> or class: the host draws it as an <img> without page CSS, so put fill/stroke on the elements`);
        if (!/currentColor/i.test(svg)) lf(`${label} svg does not use currentColor (single colour, the palette drives it)`);
        if (/<text\b/i.test(svg)) lf(`${label} svg has a <text> element: icons only, the name goes beside it`);
        if (/\p{Emoji_Presentation}|\uFE0F/u.test(svg)) lf(`${label} svg contains an emoji: draw the icon with paths`);
        out.seatIcons.push(svg, ...[...svg.matchAll(/\bd\s*=\s*"([^"]{8,})"/g)].map((m) => m[1]));
      });
    }
    out.hook = typeof meta.hook === "string" && !!meta.hook.trim();
    if (!out.hook) lw("meta.hook is missing: one sentence naming the game's world");
  }
  if (!src) return out;
  const isRing = (s) => /ring/i.test(s);
  // Rules from <style> blocks (innermost {...} only, so @media bodies still yield their rules).
  const rules = [];
  for (const m of src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = m[1].replace(/\/\*[\s\S]*?\*\//g, "");
    for (const r of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) rules.push({ sel: r[1].trim(), body: r[2], ring: isRing(r[1]) });
  }
  // style="..." attributes anywhere (static markup and JS template strings); ring = the element's class says so.
  for (const m of src.matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const start = src.lastIndexOf("<", m.index), tag = src.slice(start, src.indexOf(">", m.index + m[0].length) + 1);
    const cls = (tag.match(/\bclass\s*=\s*["']([^"']*)/i) ?? [])[1] ?? "";
    rules.push({ sel: "inline", body: m[1] ?? m[2], ring: isRing(cls) });
  }
  const decls = [];
  for (const r of rules) for (const d of r.body.split(";")) {
    const i = d.indexOf(":"); if (i < 0) continue;
    decls.push({ sel: r.sel, ring: r.ring, prop: d.slice(0, i).trim().toLowerCase(), value: d.slice(i + 1).trim() });
  }
  const vars = new Map(decls.filter((d) => d.prop.startsWith("--")).map((d) => [d.prop, d.value]));
  const resolve = (v, n = 0) => n > 4 ? v : v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, k, fb) => vars.has(k) ? resolve(vars.get(k), n + 1) : (fb ?? k));

  // Colours.
  const FORBIDDEN = ["b98cff", "f6f3ff", "ffd23f", "3ddc84", "5fe0c0"].map((h) => [h, [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))]);
  const hsl2rgb = (h, s, l) => { s /= 100; l /= 100; const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    return [0, 8, 4].map((n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))); };
  const colours = (v) => {
    const out = [];
    for (const m of v.matchAll(/#([0-9a-f]{3,8})\b/gi)) {
      let h = m[1].toLowerCase();
      if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join("");
      else if (h.length === 6 || h.length === 8) h = h.slice(0, 6); else continue;
      out.push({ tok: m[0], rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) });
    }
    for (const m of v.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/gi)) out.push({ tok: m[0] + ")", rgb: [m[1], m[2], m[3]].map(Number) });
    for (const m of v.matchAll(/hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/gi)) out.push({ tok: m[0] + ")", rgb: hsl2rgb(+m[1], +m[2], +m[3]) });
    return out;
  };
  const chroma = (c) => Math.max(...c) - Math.min(...c);
  const hex = (c) => "#" + c.map((x) => x.toString(16).padStart(2, "0")).join("");
  const found = [...decls.flatMap((d) => colours(d.value)),
    ...[...src.matchAll(/\b(?:fill|stroke|stop-color|color)\s*=\s*["']([^"']*)["']/gi)].flatMap((m) => colours(m[1]))];
  const tints = new Set();
  for (const c of found) {
    if (chroma(c.rgb) > 8) for (const [h, f] of FORBIDDEN) if (Math.hypot(...c.rgb.map((x, i) => x - f[i])) <= 24) lf(`forbidden default-palette colour ${c.tok} (the #${h} family): use the chosen palette's tokens`);
    if (chroma(c.rgb) > 16) tints.add(hex(c.rgb));
  }
  out.colours = tints.size;
  if (tints.size > 6) lw(`${tints.size} distinct non-grey colours in CSS (${[...tints].slice(0, 8).join(" ")}): one palette is 4 tokens, one accent`);
  for (const t of ["--bg", "--ink", "--muted", "--accent"]) if (!vars.has(t)) { lw("the palette tokens --bg, --ink, --muted, --accent are not all defined at :root"); break; }

  // Weights.
  const weightOf = (v) => { v = v.toLowerCase(); if (/\bbolder\b/.test(v)) return 900; if (/\bbold\b/.test(v)) return 700;
    const n = v.match(/(?:^|\s)([1-9]00)(?=\s|$)/); return n ? +n[1] : null; };
  const heavy = new Set();
  for (const d of decls) {
    const w = d.prop === "font-weight" ? weightOf(resolve(d.value)) ?? 400 : d.prop === "font" ? weightOf(resolve(d.value)) : null;
    if (w === null) continue;
    out.maxWeight = Math.max(out.maxWeight, w);
    if (w >= 600) heavy.add(`${d.sel.slice(0, 40)} { ${d.prop}: ${d.value} }`);
  }
  for (const m of src.matchAll(/\.style\.fontWeight\s*=\s*["'`]([^"'`]+)/g)) {
    const w = weightOf(m[1]); if (w !== null) { out.maxWeight = Math.max(out.maxWeight, w); if (w >= 600) heavy.add(`.style.fontWeight = "${m[1]}"`); }
  }
  if (heavy.size) lf(`font-weight above 500: ${[...heavy].slice(0, 4).join("; ")} (no bold: hierarchy from size, caps and colour)`);
  const boldTags = new Set([...src.matchAll(/<(h[1-6]|b|strong|th)[\s>]/gi)].map((m) => m[1].toLowerCase()));
  for (const t of boldTags) {
    const re = new RegExp(`(^|[\\s,>+~(])(${t}|\\*)(?![\\w-])`, "i");
    const reset = rules.some((r) => r.sel !== "inline" && re.test(r.sel) && /font-weight\s*:\s*(normal|lighter|[1-5]00)\b/i.test(r.body));
    if (!reset) lw(`<${t}> is bold by default: set font-weight: 500 (or 400) on it in CSS`);
  }

  // Font sizes.
  const sizes = new Set();
  for (const d of decls) {
    if (d.ring) continue;
    let v = null;
    if (d.prop === "font-size") v = resolve(d.value).trim();
    else if (d.prop === "font") v = (resolve(d.value).match(/(\d*\.?\d+(?:vh|vw|vmin|vmax|px|rem|em|%|pt))/) ?? [])[1] ?? null;
    if (!v || /^(inherit|initial|unset|revert)$/i.test(v)) continue;
    sizes.add(v.replace(/\s+/g, " "));
    const vh = v.match(/^(\d*\.?\d+)vh$/); if (vh && +vh[1] < 2.4) lw(`font-size ${v} is below the 2.4vh floor`);
  }
  out.sizes = [...sizes];
  if (sizes.size > 3) lw(`${sizes.size} distinct font sizes (${[...sizes].slice(0, 8).join(", ")}): use exactly three, var(--display), var(--body), var(--tiny)`);
  if (!["--display", "--body", "--tiny"].every((k) => vars.has(k))) lw("the type scale --display, --body, --tiny is not all defined at :root");

  // Radii.
  const pills = new Set();
  for (const d of decls) {
    if (d.ring || !/^border(-[a-z]+)*-radius$/.test(d.prop)) continue;
    for (const m of resolve(d.value).matchAll(/(\d*\.?\d+)px/g)) if (+m[1] >= 50) pills.add(`${d.sel.slice(0, 40)} { ${d.prop}: ${d.value} }`);
  }
  if (pills.size) lw(`pill radius: ${[...pills].slice(0, 4).join("; ")} (radii 0 to 1.2vh; only the countdown ring is round)`);

  // Emoji (see the header for the heuristic).
  const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
  const emo = [];
  for (const { segment } of seg.segment(src)) if (/\p{Emoji_Presentation}|️/u.test(segment) && !/^[\d#*]$/.test(segment)) emo.push(segment);
  out.emoji = emo.length;
  if (emo.length > 2) lf(`${emo.length} emoji in tv.html (${[...new Set(emo)].slice(0, 10).join(" ")}): no emoji as UI, use text glyphs or inline SVG (2 allowed)`);
  return out;
}
// Player names are not counted: the design rules require naming the players, and a list of them
// grows with the room (2 to 12), so the 12-word budget is for everything else.
const NAMES = new Set([...PLAYERS, LATE].map((p) => p.name.toLowerCase()));
const sayVerdict = (texts, pfail, pwarn) => {
  let longest = { n: 0, text: "" };
  for (const t of texts) {
    const n = t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w) && !NAMES.has(w.replace(/('s)?[^\p{L}\p{N}]*$/u, "").replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase())).length;
    if (n > longest.n) longest = { n, text: t };
    if (n > 12) pfail(`say line of ${n} words, player names not counted (max 12): "${t.slice(0, 120)}"`);
    if ((t.match(/!/g) ?? []).length >= 2) pwarn(`say line with ${(t.match(/!/g) ?? []).length} exclamation marks (max 1): "${t.slice(0, 120)}"`);
    else if (/[!?]{2,}/.test(t)) pwarn(`say line with stacked punctuation: "${t.slice(0, 120)}"`);
  }
  return longest;
};

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
    // Participation: actionable screens (buttons/text/pad/custom) each player received, directly or via "*".
    const actionable = new Map([...PLAYERS, LATE].map((p) => [p.id, 0]));
    let actionableTotal = 0, namedActionable = 0;
    const npcNames = new Set(); // button labels that read like character names but are no player's name
    const NAME_RES = [...PLAYERS, LATE].map((p) => new RegExp(`\\b${p.name}\\b`, "i"));
    const realStart = Date.now();
    const timers = [];
    const says = [];                        // every say text, for the voice cadence check
    // Roster seats: one sample of the TV per distinct state message, answered seats seen, phone icon use.
    const seatStates = new Map();           // "phase|summary" -> every joined player had a [data-player] seat
    const answeredIds = new Set(), answeredSeen = new Set();
    let lateIn = false, seatOnPhone = false;

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
      if (!isActionable(screen)) return;
      if (!firstInputAt) {
        // The round's phase: whatever state the game posts in the same turn as this screen.
        firstInputAt = Date.now();
        timers.push(setTimeout(() => { inputPhase = phase; }, 20));
      }
      const send = (data, delay) => {
        timers.push(setTimeout(() => {
          if (finished || seenScreen.get(pid) !== key) return; // screen replaced before we answered
          stats.inputs++; answered.set(pid, (answered.get(pid) ?? 0) + 1); answeredIds.add(pid);
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
            const key = m.phase + "|" + m.summary;
            if (!seatStates.has(key)) { seatStates.set(key, false); timers.push(setTimeout(() => sampleSeats(key), 0)); } // after the game's render
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
          if (m.screen.kind === "custom" && typeof m.screen.html === "string" && look.seatIcons.some((x) => m.screen.html.includes(x))) seatOnPhone = true;
          if (isActionable(m.screen)) {
            actionableTotal++;
            for (const pid of targets) if (actionable.has(pid)) actionable.set(pid, actionable.get(pid) + 1);
            const s = m.screen;
            const words = [s.prompt, s.label, s.placeholder, ...(Array.isArray(s.items) ? s.items.map((i) => i?.label) : []),
              typeof s.html === "string" ? s.html.replace(/<script[\s\S]*?<\/script>|<[^>]+>/gi, " ") : ""].filter((x) => typeof x === "string").join(" ");
            if (NAME_RES.some((re) => re.test(words))) namedActionable++;
            if (s.kind === "buttons" && Array.isArray(s.items)) {
              const labels = s.items.map((i) => String(i?.label ?? "").replace(/[^\p{L}\s'-]/gu, " ").replace(/\s+/g, " ").trim());
              const looksNamed = labels.filter((l) => /^\p{Lu}\p{Ll}+( \p{Lu}\p{Ll}+){1,2}$/u.test(l) && !NAME_RES.some((re) => re.test(l)));
              if (looksNamed.length >= 2 && !labels.some((l) => NAME_RES.some((re) => re.test(l)))) for (const l of looksNamed) npcNames.add(l);
            }
          }
          for (const pid of targets) if (PLAYERS.some((p) => p.id === pid) || pid === LATE.id) answerScreen(pid, m.screen);
          break;
        }
        case "moment": stats.moment = (stats.moment || 0) + 1; if (typeof m.title !== "string") pfail("moment.title must be a string"); break;
        case "say": stats.say++; if (typeof m.text !== "string") pfail("say.text must be a string"); else says.push(m.text); break;
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

    // Roster seats. Joined players right now; a seat counts when its data-player is one of their ids.
    const joinedNow = () => [...PLAYERS, ...(lateIn ? [LATE] : [])];
    function sampleSeats(key) {
      if (finished) return;
      const ids = new Set([...window.document.querySelectorAll("[data-player]")].map((e) => e.getAttribute("data-player")));
      seatStates.set(key, joinedNow().every((p) => ids.has(p.id)));
    }
    const noteAnswered = (el) => {
      if (el?.nodeType !== 1) return;
      for (const e of [el, ...el.querySelectorAll("[data-player][data-state]")])
        if (e.getAttribute("data-state") === "answered" && e.hasAttribute("data-player")) answeredSeen.add(e.getAttribute("data-player"));
    };
    try {
      new window.MutationObserver((records) => { for (const r of records) r.type === "attributes" ? noteAnswered(r.target) : r.addedNodes.forEach(noteAnswered); })
        .observe(window.document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state", "data-player"] });
    } catch (e) { pwarn(`harness: could not watch seat states (${e.message})`); }

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
      // Participation: every joined player (the late joiner too) must get something to do.
      const phonesOptional = meta?.phonesRequired === false;
      const joined = [...PLAYERS, ...(lateJoined ? [LATE] : [])];
      const leftOut = joined.filter((p) => !actionable.get(p.id));
      if (leftOut.length) {
        const s = `players left out: ${leftOut.map((p) => p.name).join(", ")} never got an actionable screen (buttons/text/pad/custom); every joined player needs something to do every round`;
        phonesOptional ? pwarn(s + " (meta.phonesRequired is false, so only a warning)") : pfail(s);
      }
      if (actionableTotal < 2) {
        const s = `only ${actionableTotal} actionable screen(s) sent over the whole pass; players need a fresh action every round`;
        phonesOptional ? pwarn(s) : pfail(s);
      }
      const longestSay = sayVerdict(says, pfail, pwarn);
      // Roster seats.
      const sampled = [...seatStates.values()], seated = sampled.filter(Boolean).length;
      const seatPct = sampled.length ? Math.round((100 * seated) / sampled.length) : 0;
      if (sampled.length && seated / sampled.length < 0.8)
        pfail(`look: seats on ${seated} of ${sampled.length} distinct TV states (${seatPct}%): every screen state keeps a [data-player] seat for every joined player (80% needed)`);
      const unseen = [...PLAYERS, LATE].filter((p) => answeredIds.has(p.id) && !answeredSeen.has(p.id));
      if (unseen.length) pfail(`look: seat data-state never became "answered" for ${unseen.map((p) => p.name).join(", ")} after they answered`);
      if (!seatOnPhone && look.seats) pwarn("look: no phone screen shows the player's seat icon (send it in the first screen as custom html)");
      const seatLine = `seats: ${look.seats} variants, ${seatPct}% of states, answered-state ${unseen.length ? "missing for " + unseen.map((p) => p.name).join(", ") : "ok"}`;
      if (npcNames.size) pwarn(`phones vote on named characters who are not players (${[...npcNames].slice(0, 4).join(", ")}): never invent NPC suspects or contestants, the room is the cast`);
      try { window.close(); } catch {}
      const participation = joined.map((p) => `${p.name} ${actionable.get(p.id)}`).join(", ") + `; ${actionableTotal} actionable screens, ${namedActionable} naming a player`;
      done({ tag, why, pf, pw, stats, participation, longestSay, seatLine, gameS: Math.round(gameMs / 1000), realS: ((Date.now() - realStart) / 1000).toFixed(1), cycles, inputPhase, minAnswered, gotDone });
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
      if (!lateJoined && cycles >= 2) { lateJoined = true; deliver({ type: "players", players: [...PLAYERS, LATE] }, 0); timers.push(setTimeout(() => { lateIn = true; }, 0)); }
      if (cycles >= 3 && afterInput.state + afterInput.screen > 0) return finish("2 rounds");
      if (gameMs > BUDGET_MS) return finish("budget");
    }, 100);
  });
}

// ---------- run ----------
const passes = [];
if (html) log(`look: palette ${look.palette}, ${look.colours} non-grey colours, ${look.sizes.length} font sizes (${look.sizes.join(" ") || "none"}), max weight ${look.maxWeight}, emoji ${look.emoji}, ${look.seats} seat variants, hook ${look.hook ? "yes" : "missing"}`);
if (!failures.length) {
  if (AI_MODE === "both" || AI_MODE === "ok") passes.push(await runPass(true));
  if (AI_MODE === "both" || AI_MODE === "fail") passes.push(await runPass(false));
}
for (const p of passes) {
  log(`pass ${p.tag}: ended by ${p.why} after ${p.gameS} s game time (${p.realS} s real); states ${p.stats.state}, screens ${p.stats.screen}, says ${p.stats.say}, inputs sent ${p.stats.inputs}, ai ${p.stats.ai}, ai_image ${p.stats.ai_image}, bot_answer ${p.stats.bot_answer}, motion_start ${p.stats.motion_start}; input phase "${p.inputPhase}" entered ${p.cycles}x; done ${p.gotDone}`);
  log(`  participation ${p.tag}: ${p.participation}`);
  log(`  look ${p.tag}: longest say ${p.longestSay.n} words${p.longestSay.text ? ` "${p.longestSay.text.slice(0, 80)}"` : ""}; ${p.seatLine}`);
  for (const f of p.pf) failures.push(`[${p.tag}] ${f}`);
  for (const w of p.pw) warn(`[${p.tag}] ${w}`);
}
for (const f of lookFails) failures.push(`look: ${f}`);
for (const w of lookWarns) warn(`look: ${w}`);
for (const w of warnings) log(`warn: ${w}`);
if (failures.length) {
  log("SMOKE FAIL");
  for (const f of failures) log(`- ${f}`);
  process.exit(1);
}
log(`SMOKE PASS (${meta.title})`);
process.exit(0);
