// Look and voice checks in the smoke harness (runner/harness/smoke.mjs, SKILL.md "Look and voice
// rules", "Lobby card"): the repo's sample bundle (tv.html + lobby.html) passes clean, and small mutations
// of it trip each check.
// Needs jsdom from runner/node_modules (NODE_PATH is set here).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const relayDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const smoke = path.join(relayDir, "runner/harness/smoke.mjs");
const TV = fs.readFileSync(path.join(relayDir, "games/sample/tv.html"), "utf8");
const META = JSON.parse(fs.readFileSync(path.join(relayDir, "games/sample/meta.json"), "utf8"));
const LOBBY = fs.readFileSync(path.join(relayDir, "games/sample/lobby.html"), "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-look-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0, bad = 0;
function run(name, { tv = TV, meta = META, lobby = LOBBY, args = [] } = {}) {
  const dir = path.join(tmp, String(++n));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "tv.html"), tv);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
  if (lobby !== null) fs.writeFileSync(path.join(dir, "lobby.html"), lobby);
  const r = spawnSync(process.execPath, [smoke, dir, "--ai", "ok", ...args], { encoding: "utf8", timeout: 60_000,
    env: { ...process.env, NODE_PATH: path.join(relayDir, "runner/node_modules") } });
  return { name, out: r.stdout + r.stderr, pass: r.status === 0 };
}
function expect(res, pass, re, why) {
  const ok = res.pass === pass && (!re || re.test(res.out));
  if (!ok) { bad++; console.error(`FAIL ${res.name}: ${why}\n${res.out.split("\n").filter((l) => /look|lobby|SMOKE|^- |warn/.test(l)).join("\n")}`); }
  else console.log(`ok   ${res.name}`);
}
const css = (extra) => TV.replace("</style>", extra + "\n</style>");
const lines = (out) => out.split("\n");
// A say line at every round start (the harness stops after 2 rounds, before the final say).
const say = (text) => TV.replace("function startRound(i) {", `function startRound(i) {\n  send({ type: "say", text: ${JSON.stringify(text)} });`);

const lookWarn = (l) => /^warn: (\[[\w-]+\] )?(look|lobby)/.test(l);

// The sample: PASS with no look warnings, one static look line and one look line per pass.
const base = run("sample passes clean");
expect(base, true, /^look: palette Broadcast, 3 non-grey colours, 3 font sizes .* max weight 500, emoji 0, 10 seat variants, hook yes; lobby: ok$/m, "expected PASS and a clean look line");
expect(base, true, /^lobby card: 4 seats, 4 join slots, full room 16\/16, code 14vh, title svg, status "Everyone in\? Say start" → "Needs 1 more", lobby_ready 1; 3 non-grey colours, 3 font sizes/m, "expected a clean lobby card line");
expect(base, true, /look ai-ok: longest say \d+ words.*; seats: 10 variants, 100% of states, answered-state ok/, "expected the seats summary in the pass look line");
if (lines(base.out).filter((l) => /^\s*look\b/.test(l)).length !== 2) { bad++; console.error("FAIL expected exactly one static look line and one per pass"); }
if (lines(base.out).some(lookWarn)) { bad++; console.error("FAIL sample has look warnings"); }

// Every palette in the kit passes the colour checks.
const KIT = {
  Noir: ["#0e0e10", "#e8e0cf", "#6e7480", "#e5322d"], Broadcast: ["#0b1630", "#ffffff", "#8b97ab", "#ffb000"],
  Paper: ["#f2ece0", "#16161a", "#77736b", "#2747d6"], Arcade: ["#08090b", "#ffffff", "#7c8088", "#00e5ff"],
  Campfire: ["#22170f", "#f5ead6", "#b08a4a", "#ff6a1f"], Lagoon: ["#08343a", "#efe2c4", "#7f9a9c", "#ff6f5e"],
};
for (const [name, [bg, ink, muted, accent]] of Object.entries(KIT)) {
  // Global: the TV's :root and the phone seat card's :root carry the same four tokens.
  const tv = TV.replace(/--bg: #[0-9a-f]+; --ink: #[0-9a-f]+; --muted: #[0-9a-f]+; --accent: #[0-9a-f]+;/g, `--bg: ${bg}; --ink: ${ink}; --muted: ${muted}; --accent: ${accent};`);
  if (tv === TV && name !== "Broadcast") { bad++; console.error("FAIL could not swap the sample's palette tokens"); break; }
  const r = run(`palette ${name} passes`, { tv, meta: { ...META, palette: name } });
  expect(r, true, new RegExp(`palette ${name}`), "a kit palette must pass");
  if (lines(r.out).some(lookWarn)) { bad++; console.error(`FAIL palette ${name} warns`); }
}

expect(run("purple accent fails", { tv: TV.replace("--accent: #ffb000", "--accent: #B98CFF") }), false, /forbidden default-palette colour #B98CFF/, "purple accent");
expect(run("3-digit yellow inline fails", { tv: TV.replace('<div id="app">', '<div id="app" style="color:#fd3">') }), false, /forbidden default-palette colour #fd3/, "3-digit #fd3");
expect(run("near-neighbour mint fails", { tv: css(".x { background: rgb(64, 220, 130); }") }), false, /the #3ddc84 family/, "rgb() near #3ddc84");
expect(run("many colours warn", { tv: css(".x { color: #ff0000; border-color: #00ff00; background: #0000ff; outline-color: #ff00ff; }") }), true, /warn: look: 7 distinct non-grey colours/, "7 colours");
expect(run("bold fails", { tv: css(".x { font-weight: 700; }") }), false, /font-weight above 500: \.x/, "font-weight 700");
expect(run("font shorthand bold fails", { tv: css(".x { font: bold 5vh sans-serif; }") }), false, /font-weight above 500/, "font: bold");
expect(run("inline bold fails", { tv: TV.replace('<div id="app">', '<div id="app" style="font-weight:600">') }), false, /font-weight above 500: inline/, "inline 600");
expect(run("four sizes warn", { tv: css(".x { font-size: 7vh; }") }), true, /warn: look: 4 distinct font sizes/, "4th size");
expect(run("ring sizes ignored", { tv: css(".ring text { font-size: 7vh; } .ring { border-radius: 999px; }") }), true, /3 font sizes/, "ring ignored");
expect(run("pill warns", { tv: css(".chip { border-radius: 99px; }") }), true, /warn: look: pill radius: \.chip/, "pill");
expect(run("two emoji pass", { tv: TV.replace("<script>", "<script>\n// ✨\u{1F3B2}") }), true, /emoji 2/, "2 emoji allowed");
expect(run("three emoji fail", { tv: TV.replace("<script>", "<script>\n// ✨\u{1F3B2}\u{1F916}") }), false, /3 emoji in tv\.html/, "3 emoji");
expect(run("text glyphs are not emoji", { tv: TV.replace("<script>", "<script>\n// ● ▲ ★ ✓ × →") }), true, /emoji 0/, "glyphs");
expect(run("long say fails", { tv: say("Game over everyone, thank you so much for playing this lovely little game tonight.") }),
  false, /say line of 14 words/, "14-word say");
// Names come from the room at runtime (a literal name list would trip the static gate's S13).
expect(run("names not counted", { tv: TV.replace("function startRound(i) {", "function startRound(i) {\n  send({ type: \"say\", text: `${and(active().map((p) => p.name))}'s team: thank you all for playing tonight, really, truly, friends.` });") }),
  true, /longest say 11 words/, "names excluded");
expect(run("double exclamation warns", { tv: say("Round on! Well played!") }), true, /warn: \[ai-ok\] say line with 2 exclamation marks/, "!!");
expect(run("unknown palette fails", { meta: { ...META, palette: "Purple" } }), false, /meta\.palette "Purple" is not one of/, "bad palette");
const { palette, ...noPalette } = META;
expect(run("missing palette warns", { meta: noPalette }), true, /warn: look: meta\.palette is missing/, "no palette");

// Roster seats (SKILL.md "Roster seats").
const seatsMeta = (f) => ({ ...META, seats: f(META.seats.map((e) => ({ ...e }))) });
const drawSeats = (guard) => TV.replace("function drawSeats() {", `function drawSeats() {\n  ${guard}`);
expect(run("seats missing from a state fail", { tv: drawSeats('if (phase === "results") { for (const el of seatEls.values()) el.remove(); seatEls.clear(); return; }') }),
  false, /look: seats on \d+ of \d+ distinct TV states \(\d+%\)/, "results screens without seats");
expect(run("5 variants fail", { meta: seatsMeta((s) => s.slice(0, 5)) }), false, /meta\.seats has 5 variant/, "5 seat variants");
const { seats, ...noSeats } = META;
expect(run("missing seats fail", { meta: noSeats }), false, /meta\.seats is missing/, "no meta.seats");
expect(run("svg with text fails", { meta: seatsMeta((s) => (s[0].svg = s[0].svg.replace("</svg>", '<text x="4" y="40">M</text></svg>'), s)) }),
  false, /meta\.seats\[0\] \(Microphone\) svg has a <text> element/, "<text> in a seat svg");
expect(run("emoji in svg fails", { meta: seatsMeta((s) => (s[1].svg = s[1].svg.replace("</svg>", "<desc>\u{1F3A4}</desc></svg>"), s)) }),
  false, /meta\.seats\[1\] \(Buzzer\) svg contains an emoji/, "emoji in a seat svg");
expect(run("svg without currentColor fails", { meta: seatsMeta((s) => (s[2].svg = s[2].svg.replace('stroke="currentColor"', 'stroke="#ffffff"'), s)) }),
  false, /svg does not use currentColor/, "hard-coded colour");
expect(run("13 variants fail", { meta: seatsMeta((s) => [...s, ...s.slice(0, 3)]) }), false, /meta\.seats has 13 variants/, "over 12 seats");
expect(run("svg without an svg root fails", { meta: seatsMeta((s) => (s[3].svg = s[3].svg.replace(/^<svg[^>]*>|<\/svg>$/g, ""), s)) }),
  false, /meta\.seats\[3\] \(Trophy\) svg must have an <svg> root/, "bare paths");
expect(run("script in svg fails", { meta: seatsMeta((s) => (s[4].svg = s[4].svg.replace("</svg>", "<script>alert(1)</script></svg>"), s)) }),
  false, /\(Clapperboard\) svg has a <script>/, "<script> in a seat svg");
expect(run("external reference in svg fails", { meta: seatsMeta((s) => (s[5].svg = s[5].svg.replace("</svg>", '<image href="https://x.invalid/a.png"/></svg>'), s)) }),
  false, /\(Podium\) svg references something outside itself/, "external href");
expect(run("answered never set fails", { tv: TV.replace('? "answered" : "thinking"', '? "thinking" : "thinking"') }),
  false, /seat data-state never became "answered" for Ada, Bo, Cy/, "no answered state");
expect(run("6 variants and 80% pass", { tv: drawSeats('if (phase === "intro") return;'), meta: seatsMeta((s) => s.slice(0, 6)) }),
  true, /seats: 6 variants, (8\d|9\d)% of states, answered-state ok/, "6 variants, one state without seats");
const { hook, ...noHook } = META;
expect(run("missing hook warns", { meta: noHook }), true, /warn: look: meta\.hook is missing/, "no meta.hook");
expect(run("no seat icon on the phone warns", { tv: TV.replace("for (const p of active()) send({ type: \"screen\", to: p.id, screen: seatCard(p.id) });", "") }),
  true, /warn: \[ai-ok\] look: no phone screen shows the player's seat icon/, "no seat card");

// Lobby card (SKILL.md "Lobby card").
const lob = (a, b) => { if (!LOBBY.includes(a)) throw new Error(`sample lobby.html no longer contains ${a}`); return LOBBY.replace(a, b); };
const lobCss = (extra) => lob("</style>", extra + "\n</style>");
expect(run("missing lobby fails", { lobby: null }), false, /lobby\.html not found at .*: write the lobby card/, "no lobby.html");
const warnMissing = run("missing lobby warns with --lobby=warn", { lobby: null, args: ["--lobby=warn"] });
expect(warnMissing, true, /warn: lobby\.html not found/, "--lobby=warn");
expect(warnMissing, true, /hook yes; lobby: missing$/m, "summary says missing");
expect(run("lobby without player names fails", { lobby: lob('el.querySelector(".nm").textContent = short(name);', 'el.querySelector(".nm").textContent = "Player";') }),
  false, /- lobby: after the lobby message the card does not show Ada, Bo, Cy, Dee/, "names missing");
expect(run("lobby without the code fails", { lobby: lob('codeEl.textContent = typeof m.code === "string" && m.code ? m.code : "····";', 'codeEl.textContent = "····";') }),
  false, /does not show DEMO \(/, "code missing (the URL's ?c=DEMO does not count)");
expect(run("lobby without the join url fails", { lobby: lob('urlEl.textContent = typeof m.joinUrl === "string" && m.joinUrl ?', "urlEl.textContent = false ?") }),
  false, /does not show play\.example/, "join url missing");
expect(run("lobby without animation fails", { lobby: LOBBY.replace(/\s*animation[\w-]*:[^;]*;/g, "") }), false, /- lobby\.html has no idle motion/, "no animation");
expect(run("lobby with an external script fails", { lobby: lob("</body>", '<script src="https://cdn.example/x.js"></script>\n</body>') }),
  false, /- lobby\.html has a <script src=\.\.\.>/, "script src");
expect(run("lobby with an external font fails", { lobby: lobCss('@font-face { font-family: X; src: url("fonts/x.woff2"); }') }),
  false, /lobby\.html CSS loads an external resource: url\(fonts\/x\.woff2\)/, "font url");
expect(run("lobby with audio fails", { lobby: lob("</main>", '<audio src="data:audio/wav;base64,AAAA" autoplay></audio>\n</main>') }), false, /lobby\.html plays audio/, "audio tag");
expect(run("lobby posting say fails", { lobby: lob('if (m && m.type === "lobby") render(m);', 'if (m && m.type === "lobby") { render(m); window.parent.postMessage({ type: "say", text: "Welcome in" }, "*"); }') }),
  false, /- lobby: posted "say": the card posts only lobby_ready/, "extra postMessage type");
expect(run("lobby without lobby_ready fails", { lobby: lob('requestAnimationFrame(() => window.parent.postMessage({ type: "lobby_ready" }, "*"));', "") }),
  false, /never posted \{ type: "lobby_ready" \}/, "no lobby_ready");
expect(run("lobby status that never changes fails", { lobby: lob('statusEl.textContent = m.ready === true', 'statusEl.textContent = true') }),
  false, /- lobby: the \[data-status\] line did not change when ready went from true to false \(both "Everyone in\? Say start"\)/, "static status");
const noLogo = LOBBY.replace(/<svg class="logo"[\s\S]*?<\/svg>/, "");
if (noLogo === LOBBY) throw new Error("could not remove the sample's logo svg");
expect(run("lobby without a title treatment fails", { lobby: noLogo }),
  false, /- lobby: no title treatment: draw "Pick A or B" as art/, "no title art");
expect(run("lobby title as large text passes", { lobby: noLogo.replace('<p class="hook">', '<div style="font-size: var(--display)">Pick A or B</div>\n  <p class="hook">') }),
  true, /title text 14vh/, "text title at 14vh");
expect(run("lobby code under 14vh fails", { lobby: lob("--display: 14vh;", "--display: 10vh;") }), false, /the room code is drawn at 10vh; make it 14vh or more/, "small code");
expect(run("lobby code size from an id rule wins over a later class rule", { lobby: lobCss(".sign span { font-size: var(--tiny); }") }),
  true, /code 14vh/, "specificity");
expect(run("lobby without empty slots fails", { lobby: lob('...Array.from({ length: n - players.length }, slot)', "") }),
  false, /- lobby: 0 empty join slots for maxPlayers 8 and 4 players \(want 4/, "no join slots");
expect(run("lobby capped at 8 seats fails the full room", { lobby: lob("const MAX_SEATS = 16;", "const MAX_SEATS = 8;") }),
  false, /- lobby: with 16 players \(maxPlayers 16\) the card does not show [\w, ]*Marguerite/, "8-seat cap");
expect(run("maxPlayers 17 fails", { meta: { ...META, maxPlayers: 17 } }), false, /meta\.maxPlayers must be an integer with minPlayers <= maxPlayers <= 16 \(got 17\)/, "17 players");
expect(run("lobby without seats fails", { lobby: lob('el.className = "seat"; el.dataset.player = p.id;', 'el.className = "seat";') }),
  false, /- lobby: 0 of 4 players have a \[data-player="<id>"\] seat/, "no data-player");
const lobBold = run("lobby bold fails the look", { lobby: lobCss(".hook { font-weight: 700; }") });
expect(lobBold, false, /- lobby look: font-weight above 500: \.hook/, "lobby bold");
expect(lobBold, false, /hook yes; lobby: font-weight above 500/m, "summary carries the reason");
expect(run("lobby emoji fail the look", { lobby: lob("<script>", "<script>\n// \u{1F3B2}\u{1F916}\u{1F3A4}") }), false, /lobby look: 3 emoji in lobby\.html/, "lobby emoji");
expect(run("lobby fourth size warns", { lobby: lobCss(".x { font-size: 7vh; }") }), true, /warn: lobby look: 4 distinct font sizes/, "lobby 4 sizes");
expect(run("lobby purple fails the look", { lobby: lob("--accent: #ffb000", "--accent: #b98cff") }), false, /lobby look: forbidden default-palette colour #b98cff/, "lobby purple");

if (bad) { console.error(`${bad} look check(s) failed`); process.exit(1); }
console.log("look checks: all ok");
