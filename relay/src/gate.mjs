// Static pre-save gate for a game bundle: regex over meta.json, tv.html and lobby.html, no DOM, a few
// milliseconds per bundle. Pure functions and no Node-only imports, so the Worker (PUT /games/:id,
// POST /author/:jobId/complete), scripts/publish-games.mjs and runner/harness/smoke.mjs all import it
// and report the same messages. The jsdom play-through in the harness stays authoritative for
// anything built at runtime (say lines after interpolation, seats per state, reveal beats).
//
//   staticGate({ html, meta, lobby }) → { ok, fails: [{ code, msg }], warns: [{ code, msg }], ms }
//
// Checks (research/quality-review.md "The static pre-save gate"; SKILL.md "Look and voice rules",
// "Game design rules (approved)"):
//   S1 palette in the kit (absent: warn)        S11 more than 2 emoji (tv.html, lobby.html, meta)
//   S2 meta.hook >= 5 words (absent: warn)      S12 pill radius (warn)
//   S3 meta.seats 6-12, each svg well formed    S13 say literal over 12 words (quoted player text and
//   S4 min/max players (narrow range: warn)         names exempt); stacked ! (warn)
//   S5 meta.phases used in tv.html (warn)       S14 data-player seats, "answered", "thinking"
//   S6 meta.engine H1..H12 (absent: warn)       S15 bridge posts state, screen, done (unknown type: warn)
//   S7 :root palette tokens match meta.palette  S16 at least one moment and one award
//   S8 --display/--body/--tiny sizes            S17 self-contained: no network, storage or external refs
//   S9 forbidden purple-family colours          S18 text maxLength > 80 (warn, DP-05)
//   S10 font-weight >= 600                      S19 pad input (warn, DP-16)   S20 bare premise copy (warn)
//   L0 lobby.html missing (warn: hand-built bundles may ship without one; the harness fails it)
//   L1 lobby posts only lobby_ready  L2 lobby silent and self-contained  L3 lobby idle motion
//   L4 lobby hooks (data-status, data-player, data-slot)  L5 lobby title treatment hint (warn)
// Bundles that predate a rule keep publishing: LEGACY lists the checks downgraded to warn for them.

export const PALETTES = {
  Noir: ["#0e0e10", "#e8e0cf", "#6e7480", "#e5322d"],
  Broadcast: ["#0b1630", "#ffffff", "#8b97ab", "#ffb000"],
  Paper: ["#f2ece0", "#16161a", "#77736b", "#2747d6"],
  Arcade: ["#08090b", "#ffffff", "#7c8088", "#00e5ff"],
  Campfire: ["#22170f", "#f5ead6", "#b08a4a", "#ff6a1f"],
  Lagoon: ["#08343a", "#efe2c4", "#7f9a9c", "#ff6f5e"],
};
export const ENGINES = Array.from({ length: 12 }, (_, i) => `H${i + 1}`);
export const ENGINE_RE = /^H([1-9]|1[0-2])$/;
const FORBIDDEN = ["#b98cff", "#f6f3ff", "#ffd23f", "#3ddc84", "#5fe0c0"];
const GAME_TYPES = new Set(["screen", "ask", "play", "say", "state", "done", "ai", "ai_image", "bot_answer", "motion_start", "motion_stop", "moment", "recall"]);
const INBOUND = new Set(["init", "players", "input", "sensor", "voice", "ai_result", "motion", "motion_status", "said", "lobby", "recalled",
  "object", "string", "array", "integer", "boolean", "number", "button", "text", "pad", "custom", "lobby_ready"]);
const TEXT_GLYPHS = new Set([..."●▲★✓×♥•·→←↑↓"]);
// Hand-built bundles written before the look rules (fix nothing in them; the harness still fails them).
export const LEGACY = {
  "whodunnit-in-the-room": ["S1", "S2", "S3", "S8", "S9", "S10", "S11", "S13", "S14"],
};

const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
const rgb = (h) => {
  h = h.replace("#", "");
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const near = (a, b, d = 24) => a.every((x, i) => Math.abs(x - b[i]) <= d);
const toHex = (c) => "#" + c.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");
const cssOf = (src) => [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n") + "\n" +
  [...src.matchAll(/style="([^"]*)"/gi)].map((m) => m[1]).join("\n");
const rootVars = (css) => {
  const m = css.match(/:root\s*\{([^}]*)\}/);
  return m ? Object.fromEntries([...m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)].map((x) => [x[1], x[2].trim()])) : {};
};
function emojiCount(src) {
  let n = 0;
  for (const m of src.matchAll(/\p{Extended_Pictographic}️?|️/gu)) {
    const c = m[0].replace("️", "");
    if (TEXT_GLYPHS.has(c)) continue;
    if (/\p{Emoji_Presentation}/u.test(m[0]) || m[0].includes("️")) n++;
  }
  return n;
}
// Colours written in the file: hex and rgb()/rgba().
function colours(src) {
  const out = [];
  for (const m of src.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) out.push({ raw: m[0], c: rgb(m[0]) });
  for (const m of src.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) { const c = [+m[1], +m[2], +m[3]]; out.push({ raw: m[0] + ")", c }); }
  return out;
}

// Say literals: send({ type: "say", text: <literal> }) and say(<literal>).
const LIT = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\`(?:[^\`\\]|\\.)*\`)`;
const SAY_RES = [new RegExp(String.raw`type:\s*["']say["']\s*,\s*text:\s*` + LIT, "g"), new RegExp(String.raw`\bsay\(\s*` + LIT, "g")];
export function sayLiterals(html) {
  const out = [];
  for (const re of SAY_RES) for (const m of html.matchAll(re)) out.push(m[1].slice(1, -1));
  return out;
}
// Words that count toward the 12-word cap. Exempt: quoted text ("…", \"…\", “…”: a player's answer, a
// riddle, a fact read out in its own beat), placeholders holding names or player text; any other ${} is 1.
const PLAYER_TEXT = /name|nameOf|\band\(|text|answer|entry|lie|guess|quote|riddle|fact|line|caption|prompt|word/i;
export function sayWords(line) {
  let s = line.replace(/\\(["'])/g, "$1");
  s = s.replace(/"[^"]*"|“[^”]*”/g, " ");
  s = s.replace(/\$\{([^{}]|\{[^}]*\})*\}/g, (m) => (PLAYER_TEXT.test(m) ? " " : " X "));
  return s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export function staticGate({ html, meta, lobby } = {}) {
  const t0 = now();
  const fails = [], warns = [];
  const legacy = new Set((meta && typeof meta === "object" && LEGACY[meta.id]) || []);
  const F = (code, msg) => (legacy.has(code) ? warns.push({ code, msg: `${msg} (legacy bundle: warn only)` }) : fails.push({ code, msg }));
  const W = (code, msg) => warns.push({ code, msg });
  html = typeof html === "string" ? html : "";
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) { F("S0", "meta must be an object"); meta = {}; }
  if (!html.trim()) F("S0", "tv.html is empty");
  const css = cssOf(html);

  // ---- meta ----
  const pal = meta.palette;
  if (pal === undefined) W("S1", `meta.palette is missing: pick one of ${Object.keys(PALETTES).join(", ")}`);
  else if (!PALETTES[pal]) F("S1", `meta.palette ${JSON.stringify(pal)} is not one of ${Object.keys(PALETTES).join(", ")}`);
  if (meta.hook === undefined) W("S2", "meta.hook is missing: one sentence naming the game's world");
  else if (typeof meta.hook !== "string" || meta.hook.trim().split(/\s+/).length < 5 || meta.hook === meta.description) F("S2", "meta.hook must be one sentence of 5 or more words, not the description");
  const seats = meta.seats;
  if (!Array.isArray(seats) || seats.length < 6 || seats.length > 12) F("S3", `meta.seats needs 6 to 12 entries (got ${Array.isArray(seats) ? seats.length : "none"})`);
  else for (const [i, s] of seats.entries()) {
    const v = s && typeof s.svg === "string" ? s.svg : "";
    if (!(v.trimStart().startsWith("<svg") && v.includes("viewBox") && v.includes("currentColor")) ||
      /<text|<script|\son\w+=|<style|class=|href="http|url\((?!#)/i.test(v) || emojiCount(v)) {
      F("S3", `meta.seats[${i}] (${s?.name ?? "?"}) svg must be an <svg> root with viewBox and currentColor, no text, script, style, class, emoji or external refs`);
      break;
    }
  }
  const mn = meta.minPlayers, mx = meta.maxPlayers;
  if (!(Number.isInteger(mn) && Number.isInteger(mx) && mn >= 1 && mn <= mx)) F("S4", `meta.minPlayers/maxPlayers must be integers with 1 <= min <= max (got ${mn}/${mx})`);
  else if (mn > 3 || mx < 8) W("S4", `player range ${mn}-${mx} is narrower than 3-8`);
  else if (mx > 12 && meta.phonesRequired !== false) W("S4", `maxPlayers ${mx} > 12: the design rules are tested at 12`);
  const phases = Array.isArray(meta.phases) ? meta.phases : [];
  const unused = phases.filter((p) => !html.includes(`"${p}"`) && !html.includes(`'${p}'`) && !html.includes("`" + p + "`"));
  if (!phases.length) F("S5", "meta.phases is empty");
  else if (unused.length) W("S5", `meta.phases never set in tv.html: ${unused.join(", ")}`);
  if (meta.engine === undefined) W("S6", "meta.engine is missing: name the humour engine, H1..H12 (SKILL.md \"Game design rules\")");
  else if (typeof meta.engine !== "string" || !ENGINE_RE.test(meta.engine)) F("S6", `meta.engine ${JSON.stringify(meta.engine)} must be one of H1..H12`);
  if (emojiCount(JSON.stringify(meta)) > 2) F("S11", "more than 2 emoji in meta.json");

  // ---- tv.html look ----
  const root = rootVars(css);
  if (PALETTES[pal]) {
    const want = { "--bg": 0, "--ink": 1, "--muted": 2, "--accent": 3 };
    const bad = Object.entries(want).filter(([k, i]) => (root[k] ?? "").toLowerCase() !== PALETTES[pal][i]).map(([k]) => k);
    if (bad.length) F("S7", `:root ${bad.join(", ")} must equal the ${pal} kit (${PALETTES[pal].join(" ")})`);
  }
  for (const [k, min] of [["--display", 10], ["--body", 4], ["--tiny", 2.4]]) {
    const m = (root[k] ?? "").match(/^([\d.]+)vh$/);
    if (!m || +m[1] < min) F("S8", `:root ${k} missing or under ${min}vh (got ${root[k] ?? "none"})`);
  }
  const raw = new Set([...css.matchAll(/font-size\s*:\s*([^;"}]+)/g)].map((m) => m[1].trim()).filter((v) => !v.startsWith("var(")));
  if (raw.size) W("S8", `${raw.size} font-size value(s) not via var(--display|--body|--tiny): ${[...raw].slice(0, 6).join(", ")}`);
  lookColours(html, pal, "tv.html", F, W);
  lookWeights(html, css, "tv.html", F, W);
  const emo = emojiCount(html);
  if (emo > 2) F("S11", `${emo} emoji in tv.html: no emoji as UI (2 allowed)`);
  if (/border-radius\s*:\s*(?:(?:[5-9]\d|\d{3,})px|50%)/.test(css.replace(/[^{}]*ring[^{}]*\{[^}]*\}/gi, ""))) W("S12", "pill radius (>= 50px or 50%) outside the countdown ring");

  // ---- voice ----
  const lines = sayLiterals(html);
  const long = lines.map((l) => [sayWords(l), l]).filter(([n]) => n > 12).sort((a, b) => b[0] - a[0]);
  if (long.length) F("S13", `${long.length} say line(s) over 12 words (names and quoted player text not counted), longest ${long[0][0]}: "${long[0][1].slice(0, 90)}"`);
  const bang = lines.filter((l) => (l.match(/!/g) ?? []).length >= 2 || /[!?]{2}/.test(l));
  if (bang.length) W("S13", `stacked exclamation in ${bang.length} say line(s): "${bang[0].slice(0, 60)}"`);

  // ---- seats and bridge ----
  if (!/data-player|dataset\.player/.test(html)) F("S14", "no data-player seat in tv.html");
  if (!html.includes("answered")) F("S14", 'no data-state "answered" in tv.html');
  if (!html.includes("thinking")) F("S14", 'no data-state "thinking" in tv.html');
  if (!/kind:\s*["']custom["']/.test(html)) W("S14", "no custom phone screen (seat card)");
  const types = new Set([...html.matchAll(/\btype:\s*["'](\w+)["']/g)].map((m) => m[1]));
  const unknown = [...types].filter((t) => !GAME_TYPES.has(t) && !INBOUND.has(t));
  if (unknown.length) W("S15", `unknown postMessage types: ${unknown.join(", ")}`);
  for (const t of ["state", "screen", "done"]) if (!types.has(t)) F("S15", `never posts { type: "${t}" }`);
  if (!/type:\s*["']moment["']/.test(html)) F("S16", 'never sends a { type: "moment" }');
  if (!/kind:\s*["']award["']/.test(html)) F("S16", 'never sends a kind: "award" moment');
  const ext = selfContained(html);
  if (ext.length) F("S17", `external refs, network or storage in tv.html: ${ext.join(", ")}`);

  // ---- design rules (hints) ----
  const textScreens = [...html.matchAll(/kind:\s*["']text["']([^}]*)/g)];
  const loose = textScreens.filter((m) => { const x = m[1].match(/maxLength:\s*(\d+)/); return !x || +x[1] > 80; });
  if (loose.length) W("S18", `${loose.length} text screen(s) without maxLength <= 80 (DP-05: 40 to 60 characters; default is 140)`);
  if (/kind:\s*["']pad["']/.test(html)) W("S19", "pad input present: it must not feed scores (DP-16)");
  if (/>\s*Round \$\{[^}]*\}\s*</.test(html) || /`Round \$\{[^}]*\}\.`/.test(html)) W("S20", "bare 'Round N' label or line: name the premise");
  if (/["'`](Vote now|Vote for the funniest|Funniest)/.test(html)) W("S20", "bare funniest-vote copy (DP-15: the mechanism makes the joke)");

  // ---- lobby card ----
  if (typeof lobby !== "string" || !lobby.trim()) W("L0", "lobby.html missing (hand-built bundles may skip it; the harness fails it for authored games)");
  else {
    const lcss = cssOf(lobby);
    if (!lobby.includes("lobby_ready")) F("L1", "lobby.html never posts { type: \"lobby_ready\" }");
    const posted = [...lobby.matchAll(/postMessage\(\s*\{\s*type:\s*["'](\w+)["']/g)].map((m) => m[1]).filter((t) => t !== "lobby_ready");
    if (posted.length) F("L1", `lobby.html posts ${posted.join(", ")}: the card posts only lobby_ready`);
    if (/<audio\b|new Audio\(|type:\s*["']say["']/.test(lobby)) F("L2", "lobby.html plays audio or says something: the card is silent");
    const lext = selfContained(lobby);
    if (lext.length) F("L2", `external refs, network or storage in lobby.html: ${lext.join(", ")}`);
    if (!lcss.includes("@keyframes") || !/animation(-name)?\s*:\s*(?!none)[\w-]/.test(lcss)) F("L3", "lobby.html has no idle motion (@keyframes and an animation)");
    if (!/data-status/.test(lobby)) F("L4", "lobby.html has no [data-status] line");
    if (!/data-player|dataset\.player/.test(lobby)) F("L4", "lobby.html has no data-player seats");
    if (!/data-slot|dataset\.slot/.test(lobby)) F("L4", "lobby.html has no data-slot empty join slots");
    if (!/<svg[^>]*>\s*<title>|aria-label/.test(lobby) && !/font-size\s*:\s*(1[2-9]|[2-9]\d)(\.\d+)?vh/.test(lcss)) W("L5", "lobby.html: no SVG <title>/aria-label or 12vh+ text for the title treatment");
    const lroot = rootVars(lcss);
    const lm = (lroot["--display"] ?? "").match(/^([\d.]+)vh$/);
    if (!(lm && +lm[1] >= 14) && !/(1[4-9]|[2-9]\d)(\.\d+)?vh/.test(lcss)) F("S8", "lobby.html: nothing sized 14vh or more for the room code (--display >= 14vh)");
    lookColours(lobby, pal, "lobby.html", F, W);
    lookWeights(lobby, lcss, "lobby.html", F, W);
    const le = emojiCount(lobby);
    if (le > 2) F("S11", `${le} emoji in lobby.html (2 allowed)`);
  }
  const ms = Math.round((now() - t0) * 100) / 100;
  return { ok: fails.length === 0, fails, warns, ms };
}

function selfContained(src) {
  const re = /<script\b[^>]*\bsrc\s*=|<[a-z][^>]*?\s(?:xlink:)?(?:src|href)\s*=\s*["']?(?:https?:)?\/\/|@import\b|url\(\s*["']?(?:https?:)?\/\/|\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|EventSource|localStorage|sessionStorage|document\.cookie|\bimport\s*\(/gi;
  return [...new Set([...src.matchAll(re)].map((m) => m[0].slice(0, 40)))];
}
function lookColours(src, pal, file, F, W) {
  const kit = new Set(Object.values(PALETTES).flat());
  const isWhiteBlack = (h) => /^#(000|fff)(000|fff)?$/i.test(h);
  const forb = new Set(), stray = new Set();
  for (const { raw, c } of colours(src)) {
    const hex = toHex(c);
    if (kit.has(hex) || isWhiteBlack(hex)) continue;
    if (FORBIDDEN.some((f) => near(c, rgb(f)))) forb.add(raw);
    if (new Set(c).size > 1 && !(PALETTES[pal] ?? []).includes(hex)) stray.add(hex);
  }
  if (forb.size) F("S9", `forbidden purple-family colour(s) in ${file}: ${[...forb].slice(0, 6).join(", ")}`);
  if (stray.size > 6) W("S9", `${stray.size} non-grey colours outside the palette in ${file}`);
}
function lookWeights(src, css, file, F, W) {
  const heavy = /font-weight\s*:\s*(?:[6-9]00|bold|bolder)\b|fontWeight\s*=\s*["']?(?:[6-9]00|bold)|\bfont\s*:\s*(?:[^;"}]*\s)?(?:bold|bolder|[6-9]00)\s/i;
  if (heavy.test(css) || heavy.test(src)) F("S10", `font-weight 600 or more in ${file}: no bold (500 max)`);
  if (/<(h[1-6]|b|strong|th)\b/i.test(src) && !/(h[1-6]|\bb\b|strong|th)[^{]*\{[^}]*font-weight\s*:\s*[1-5]00/.test(css)) W("S10", `${file} uses bold-by-default tags without a font-weight <= 500 rule`);
}
