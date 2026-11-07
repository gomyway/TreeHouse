import { createMotionSession } from "@kabletv/little-motion";
import { useLittleApp } from "@kabletv/little-react";
import { useEffect, useRef, useState } from "react";

// Camera check: how well does this television's motion tracking see 1–4 people?
// Runs one spatial multiplayer session over the moves a camera game would use and shows,
// per player slot (left to right), the slot state, every confirmed action with a counter,
// active held states and the current lean. Every edge is also logged as "[motion] …" so a
// developer can read the run from `little dev` output. Experimental: all built-in motion
// semantics are marked experimental by the SDK.

const ACTIONS = ["both-arms-raise", "arm-raise", "squat-rep", "swipe-left", "swipe-right", "swipe-up", "swipe-down"] as const;
const HELD = ["arms-spread", "arm-raised"] as const;
const CONTROLS = ["torso-lateral-lean"] as const;
const SLOT_COLORS = ["#ff7a59", "#4cc3ff", "#5fd38d", "#ffc145"];

interface SlotView {
  state: string;
  counts: Record<string, number>;
  last?: { label: string; at: number };
  held: string[];
  lean?: number;
}

const blankSlot = (): SlotView => ({ state: "vacant", counts: {}, held: [] });

export function CameraCheck() {
  const app = useLittleApp();
  const [status, setStatus] = useState<{ state: string; reason?: string; rate?: number }>({ state: "starting" });
  const [slots, setSlots] = useState<SlotView[]>([blankSlot(), blankSlot(), blankSlot(), blankSlot()]);
  const slotsRef = useRef(slots);
  const dirty = useRef(false);

  useEffect(() => {
    if (!app.can("sense.motion")) {
      setStatus({ state: "unavailable", reason: "sense.motion not granted on this host" });
      return;
    }
    const session = createMotionSession(app, {
      actions: ACTIONS,
      held: HELD,
      controls: CONTROLS,
      participants: { minimum: 1, maximum: 4, assignment: { mode: "spatial" } },
    });
    const log = (...a: unknown[]) => console.info("[motion]", ...a);
    log("requested", JSON.stringify(session.request));

    let lastState = "";
    const offStatus = session.onStatus((s) => {
      const roster = (s.participants ?? []).map((p) => `${p.slot}:${p.state}`).join(" ");
      const key = `${s.state}|${s.reason ?? ""}|${roster}`;
      if (key !== lastState) {
        lastState = key;
        log("status", s.state, s.reason ?? "", `rate=${s.cadence.negotiatedRateHz ?? "?"}`, roster);
        setStatus({ state: s.state, reason: s.reason, rate: s.cadence.negotiatedRateHz });
        const next = slotsRef.current.map((v) => ({ ...v }));
        for (const p of s.participants ?? []) if (next[p.slot]) next[p.slot].state = p.state;
        slotsRef.current = next;
        dirty.current = true;
      }
    });

    const offResult = session.onResult((r) => {
      const next = slotsRef.current.map((v) => ({ ...v, counts: { ...v.counts }, held: [] as string[] }));
      for (const e of r.actions) {
        if (e.phase !== "confirmed") continue;
        const slot = (e as { playerSlot?: number }).playerSlot ?? 0;
        const label = e.side ? `${e.actionId} (${e.side})` : e.actionId;
        if (!next[slot]) continue;
        next[slot].counts[label] = (next[slot].counts[label] ?? 0) + 1;
        next[slot].last = { label, at: Date.now() };
        log("action", `slot=${slot}`, label);
      }
      for (const h of r.held) {
        const slot = (h as { playerSlot?: number }).playerSlot ?? 0;
        if (next[slot] && h.phase === "active") next[slot].held.push(h.side ? `${h.actionId} (${h.side})` : h.actionId);
      }
      for (const c of r.controls) {
        const slot = (c as { playerSlot?: number }).playerSlot ?? 0;
        if (next[slot] && c.state === "active" && typeof c.value === "number") next[slot].lean = c.value;
        else if (next[slot]) next[slot].lean = undefined;
      }
      slotsRef.current = next;
      dirty.current = true;
    });

    // Results can arrive at the evidence rate; repaint at 8 Hz.
    const paint = window.setInterval(() => {
      if (!dirty.current) return;
      dirty.current = false;
      setSlots(slotsRef.current);
    }, 125);

    return () => {
      offStatus();
      offResult();
      clearInterval(paint);
      session.close();
      log("closed");
    };
  }, [app]);

  const summary = slots.map((s, i) => ({ slot: i, state: s.state, counts: s.counts, held: s.held, lean: s.lean == null ? null : +s.lean.toFixed(2) }));

  return (
    <main className="camcheck" data-little="region" data-little-label="Camera check">
      <div className="camcheck-head">
        <div>
          <div className="eyebrow">Camera check · experimental motion</div>
          <h1 className="prompt" style={{ fontSize: 56 }}>
            Stand in a row. Try: both arms up, one arm, squat, swipe, arms wide, lean.
          </h1>
        </div>
        <div
          className={`pill pill-${status.state === "ready" ? "open" : status.state === "unavailable" ? "offline" : "connecting"}`}
          data-little="readout"
          data-little-label="Motion status"
          data-little-data={JSON.stringify(status)}
        >
          <i /> {status.state}
          {status.reason ? ` · ${status.reason}` : ""}
          {status.rate ? ` · ${Math.round(status.rate)} Hz` : ""}
        </div>
      </div>
      <div className="camcheck-slots" data-little="readout" data-little-label="Motion per slot" data-little-data={JSON.stringify(summary)}>
        {slots.map((s, i) => {
          const fresh = s.last && Date.now() - s.last.at < 1500;
          return (
            <section key={i} className={`camslot camslot-${s.state}`} style={{ ["--c" as string]: SLOT_COLORS[i] }}>
              <div className="camslot-head">
                <b>Player {i + 1}</b>
                <span>{s.state}</span>
              </div>
              <div className={`camslot-last${fresh ? " fresh" : ""}`}>{s.last ? s.last.label : "—"}</div>
              <div className="camslot-held">{s.held.length ? s.held.join(", ") : "no hold"}</div>
              <div className="camslot-lean">
                <span style={{ left: `${50 + Math.max(-1, Math.min(1, s.lean ?? 0)) * 45}%`, opacity: s.lean == null ? 0.2 : 1 }} />
              </div>
              <ul className="camslot-counts">
                {Object.entries(s.counts).map(([k, n]) => (
                  <li key={k}>
                    <span>{k}</span>
                    <b>{n}</b>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </main>
  );
}
