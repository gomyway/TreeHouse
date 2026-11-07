// Look and voice checks in the smoke harness (runner/harness/smoke.mjs, SKILL.md "Look and voice
// rules"): the repo's sample bundle passes clean, and small mutations of it trip each check.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-look-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0, bad = 0;
function run(name, { tv = TV, meta = META } = {}) {
  const dir = path.join(tmp, String(++n));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "tv.html"), tv);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
  const r = spawnSync(process.execPath, [smoke, dir, "--ai", "ok"], { encoding: "utf8", timeout: 60_000,
    env: { ...process.env, NODE_PATH: path.join(relayDir, "runner/node_modules") } });
  return { name, out: r.stdout + r.stderr, pass: r.status === 0 };
}
function expect(res, pass, re, why) {
  const ok = res.pass === pass && (!re || re.test(res.out));
  if (!ok) { bad++; console.error(`FAIL ${res.name}: ${why}\n${res.out.split("\n").filter((l) => /look|SMOKE|^- |warn/.test(l)).join("\n")}`); }
  else console.log(`ok   ${res.name}`);
}
const css = (extra) => TV.replace("</style>", extra + "\n</style>");
const lines = (out) => out.split("\n");
// A say line at every round start (the harness stops after 2 rounds, before the final say).
const say = (text) => TV.replace("function startRound(i) {", `function startRound(i) {\n  send({ type: "say", text: ${JSON.stringify(text)} });`);

// The sample: PASS with no look warnings and a look line.
const base = run("sample passes clean");
expect(base, true, /look ai-ok: palette Broadcast, 3 non-grey colours, 3 font sizes .* max weight 500, emoji 0/, "expected PASS and a clean look line");
if (lines(base.out).some((l) => l.startsWith("warn: look"))) { bad++; console.error("FAIL sample has look warnings"); }

// Every palette in the kit passes the colour checks.
const KIT = {
  Noir: ["#0e0e10", "#e8e0cf", "#6e7480", "#e5322d"], Broadcast: ["#0b1630", "#ffffff", "#8b97ab", "#ffb000"],
  Paper: ["#f2ece0", "#16161a", "#77736b", "#2747d6"], Arcade: ["#08090b", "#ffffff", "#7c8088", "#00e5ff"],
  Campfire: ["#22170f", "#f5ead6", "#b08a4a", "#ff6a1f"], Lagoon: ["#08343a", "#efe2c4", "#7f9a9c", "#ff6f5e"],
};
for (const [name, [bg, ink, muted, accent]] of Object.entries(KIT)) {
  const tv = TV.replace(/--bg: #[0-9a-f]+; --ink: #[0-9a-f]+; --muted: #[0-9a-f]+; --accent: #[0-9a-f]+;/, `--bg: ${bg}; --ink: ${ink}; --muted: ${muted}; --accent: ${accent};`);
  if (tv === TV && name !== "Broadcast") { bad++; console.error("FAIL could not swap the sample's palette tokens"); break; }
  const r = run(`palette ${name} passes`, { tv, meta: { ...META, palette: name } });
  expect(r, true, new RegExp(`palette ${name}`), "a kit palette must pass");
  if (lines(r.out).some((l) => l.startsWith("warn: look"))) { bad++; console.error(`FAIL palette ${name} warns`); }
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
expect(run("names not counted", { tv: say("Ada, Bo, Cy and Dee's team: thank you all for playing tonight, really, truly.") }),
  true, /longest say 10 words/, "names excluded");
expect(run("double exclamation warns", { tv: say("Round on! Well played!") }), true, /warn: \[ai-ok\] say line with 2 exclamation marks/, "!!");
expect(run("unknown palette fails", { meta: { ...META, palette: "Purple" } }), false, /meta\.palette "Purple" is not one of/, "bad palette");
const { palette, ...noPalette } = META;
expect(run("missing palette warns", { meta: noPalette }), true, /warn: look: meta\.palette is missing/, "no palette");

if (bad) { console.error(`${bad} look check(s) failed`); process.exit(1); }
console.log("look checks: all ok");
