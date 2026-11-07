// Pure deadline logic of the phone shell (../../phone/shell.js), no browser. Run: node test/phone.mjs
import assert from "node:assert/strict";
const { remaining, secondsLabel, expiryInput } = await import("../../phone/shell.js");

assert.equal(remaining(10_000, 4_000), 6_000);
assert.equal(remaining(10_000, 10_000), 0);
assert.equal(remaining(10_000, 12_500), 0, "past deadlines clamp to 0");

assert.equal(secondsLabel(5_000), "5");
assert.equal(secondsLabel(4_001), "5", "rounds up so 0 shows only at the deadline");
assert.equal(secondsLabel(1), "1");
assert.equal(secondsLabel(0), "0");

const text = { kind: "text", prompt: "?", maxLength: 5 };
assert.deepEqual(expiryInput(text, "  hello world "), { kind: "text", text: "hello" }, "trims and honours maxLength");
assert.deepEqual(expiryInput(text, "   "), { kind: "text", text: "", late: true });
assert.deepEqual(expiryInput(text, undefined), { kind: "text", text: "", late: true });
assert.equal(expiryInput({ kind: "buttons", items: [] }, ""), null, "buttons send nothing");
assert.equal(expiryInput({ kind: "info", title: "x" }, ""), null);
assert.equal(expiryInput({ kind: "pad" }, ""), null);

console.log("phone deadline logic: ok (13 assertions)");
