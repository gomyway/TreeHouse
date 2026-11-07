// Turns pi's `--mode json` event stream (one JSON object per line) into short log lines and a
// running tally the runner reports in its progress notes.
export function createPiTracker() {
  const tally = { tools: 0, turns: 0, smoke: null, lastText: "", stopReason: null, error: null };
  let buf = "";
  const running = new Map(); // toolCallId -> command text
  const clip = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
  function event(j) {
    const out = [];
    if (j.type === "turn_start") tally.turns++;
    if (j.type === "tool_execution_start") {
      tally.tools++;
      const a = j.args ?? {};
      const what = a.command ?? a.path ?? JSON.stringify(a);
      running.set(j.toolCallId ?? "last", j.toolName === "bash" ? String(a.command ?? "") : "");
      out.push(`tool ${j.toolName} ${clip(what, 160)}`);
    }
    if (j.type === "tool_execution_end") {
      const text = (j.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const cmd = running.get(j.toolCallId ?? "last") ?? "";
      running.delete(j.toolCallId ?? "last");
      const m = /smoke/.test(cmd) ? text.match(/SMOKE (PASS|FAIL)/) : null; // only a harness run counts
      if (m) { tally.smoke = m[1]; out.push(`  smoke ${m[1]}${m[1] === "FAIL" ? ": " + clip(text.split("\n").filter((l) => l.startsWith("- ")).slice(0, 3).join(" "), 240) : ""}`); }
      else if (j.isError) out.push(`  error: ${clip(text, 200)}`);
    }
    if (j.type === "message_end" && j.message?.role === "assistant") {
      const text = (j.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
      if (text.trim()) { tally.lastText = text.trim(); out.push(`agent: ${clip(text, 300)}`); }
      if (j.message.stopReason && j.message.stopReason !== "toolUse") {
        tally.stopReason = j.message.stopReason;
        if (j.message.errorMessage) { tally.error = j.message.errorMessage; out.push(`stop ${j.message.stopReason}: ${clip(j.message.errorMessage, 300)}`); }
      }
    }
    return out;
  }
  // Feed raw stdout chunks; returns log lines. Non-JSON lines pass through as-is.
  function feed(chunk) {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop();
    const out = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      let j;
      try { j = JSON.parse(l); } catch { out.push(l); continue; }
      out.push(...event(j));
    }
    return out;
  }
  return { feed, tally };
}
