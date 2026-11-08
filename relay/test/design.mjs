// Design-rule checks in the smoke harness (SKILL.md "Game design rules (approved)"): mutations of the
// sample bundle trip each one. Needs jsdom from runner/node_modules (NODE_PATH is set here).
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-design-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0, bad = 0;
function run(name, { tv = TV, meta = META } = {}) {
  const dir = path.join(tmp, String(++n));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "tv.html"), tv);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, "lobby.html"), LOBBY);
  const r = spawnSync(process.execPath, [smoke, dir, "--ai", "ok"], { encoding: "utf8", timeout: 60_000,
    env: { ...process.env, NODE_PATH: path.join(relayDir, "runner/node_modules") } });
  return { name, out: r.stdout + r.stderr, pass: r.status === 0 };
}
function expect(res, pass, re, why, absent = false) {
  const hit = re.test(res.out);
  const ok = (pass === null || res.pass === pass) && (absent ? !hit : hit);
  if (!ok) { bad++; console.error(`FAIL ${res.name}: ${why}\n${res.out.split("\n").filter((l) => /gate|SMOKE|^- |warn/.test(l)).join("\n")}`); }
  else console.log(`ok   ${res.name}`);
}
const sub = (src, a, b) => { if (!src.includes(a)) throw new Error(`sample tv.html no longer contains ${a}`); return src.replace(a, b); };

// The sample passes; it is a run of A/B votes, so DP-17 warns.
const base = run("sample passes, DP-17 warns on its A/B run");
expect(base, true, /^gate: ok, \d+ warn\(s\), [\d.]+ ms$/m, "gate line");
expect(base, true, /warn: \[ai-ok\] 3 two-option button screens in a row to one player/, "binary run warns");
expect(run("three options do not warn", { tv: sub(TV, '{ id: "b", label: "B · " + r.b }]', '{ id: "b", label: "B · " + r.b }, { id: "c", label: "C · neither" }]') }),
  true, /two-option button screens in a row/, "3 options", true);

// DP-03: meta.engine.
const { engine, ...noEngine } = META;
expect(run("missing engine fails", { meta: noEngine }), false, /- meta\.engine must name the humour engine, one of H1\.\.H12/, "no engine");
expect(run("engine H13 fails", { meta: { ...META, engine: "H13" } }), false, /- meta\.engine must name the humour engine.*"H13"/, "H13");

// DP-13: an info screen held through a long results phase.
expect(run("info screen held 20 s in results fails", { tv: sub(TV, "RESULTS_MS = 5000", "RESULTS_MS = 20000") }),
  false, /sat on an info screen for \d+ s during "results".*\(DP-13\)/, "idle phone in a reveal");

// DP-02 and DP-05: a text version of the sample that dumps every answer at once, then one per beat.
const textual = (maxLength) => sub(sub(TV,
  'return { kind: "buttons", prompt: r.q, items: [{ id: "a", label: "A · " + r.a }, { id: "b", label: "B · " + r.b }] };',
  `return { kind: "text", prompt: r.q, maxLength: ${maxLength} };`),
  'const id = m.data && m.data.id;\n      if (phase !== "pick" || picks.has(m.player) || (id !== "a" && id !== "b")) return;',
  'const id = m.data && (m.data.id || m.data.text);\n      if (phase !== "pick" || picks.has(m.player) || !id) return;');
const dump = sub(textual(50), "render({ nA, nB, side, what, who });",
  'render({ nA, nB, side, what, who });\n  app.insertAdjacentHTML("beforeend", "<div>" + [...picks.values()].map(esc).join(" / ") + "</div>");');
expect(run("reveal dumping every entry at once fails", { tv: dump }), false, /- \[ai-ok\] reveal phase "results" shows \d entries in one go.*\(DP-02\)/, "single batch");
const staged = sub(textual(100), "render({ nA, nB, side, what, who });",
  'render({ nA, nB, side, what, who });\n  [...picks.values()].forEach((v, i) => later(800 * i, () => app.insertAdjacentHTML("beforeend", "<div>" + esc(v) + "</div>")));');
const st = run("reveal one entry per beat passes DP-02; maxLength 100 warns (DP-05)", { tv: staged });
expect(st, null, /DP-02/, "staged reveal", true);
expect(st, null, /warn: \[ai-ok\] text screen allows 100 characters.*\(DP-05/, "maxLength 100");

// Say cap exemption: quoted spoken content does not count.
const riddle = (text) => sub(TV, "function startRound(i) {", `function startRound(i) {\n  send({ type: "say", text: ${JSON.stringify(text)} });`);
expect(run("quoted riddle in a say line is exempt", { tv: riddle('Riddle time: "what has keys but cannot open a single lock at all" go.') }),
  true, /look ai-ok: longest say 10 words "Pick A or B/, "quoted content exempt");
expect(run("unquoted long say still fails", { tv: riddle("Riddle time: what has keys but cannot open a single lock at all, go.") }),
  false, /say line of 14 words/, "unquoted counts");

if (bad) { console.error(`${bad} design check(s) failed`); process.exit(1); }
console.log("design checks: all ok");
