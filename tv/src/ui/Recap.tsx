import { useEffect, useMemo, useRef, useState } from "react";
import { COCO, type ClipFrame, type Moment } from "../game/memories";

// End-of-game recap: the best moments replay one by one (camera moments as looping stick
// figures, the rest as big title cards) beside the final leaderboard. Also used for "show our
// best moments" from the lobby, with the all-time memory book.

const SLIDE_MS = 4800;
const FIG_COLORS = ["#ff7a59", "#4cc3ff"];
const BONES: [string, string][] = [
  ["left_shoulder", "right_shoulder"], ["left_shoulder", "left_elbow"], ["left_elbow", "left_wrist"], ["right_shoulder", "right_elbow"],
  ["right_elbow", "right_wrist"], ["left_shoulder", "left_hip"], ["right_shoulder", "right_hip"], ["left_hip", "right_hip"],
  ["left_hip", "left_knee"], ["left_knee", "left_ankle"], ["right_hip", "right_knee"], ["right_knee", "right_ankle"],
];
const idx = Object.fromEntries(COCO.map((k, i) => [k, i])) as Record<string, number>;
const KIND_ICON: Record<string, string> = { win: "🏆", funny: "😂", fail: "💥", clutch: "🔥", bot: "🤖" };

export function Recap({
  heading,
  moments,
  scores,
  credits,
  onFinished,
}: {
  heading: string;
  moments: Moment[];
  scores?: Record<string, number>;
  /** award moments: "Starring … as <title>" in a closing credits roll */
  credits?: Moment[];
  onFinished?: () => void;
}) {
  const [i, setI] = useState(0);
  const [rolling, setRolling] = useState(false);
  const cast = (credits ?? []).flatMap((c) => (c.players ?? []).map((p) => ({ name: p, role: c.title })));
  const finished = useRef(onFinished);
  finished.current = onFinished;

  useEffect(() => {
    if (!moments.length) {
      const t = window.setTimeout(() => finished.current?.(), 3000);
      return () => clearTimeout(t);
    }
    if (rolling) {
      const t = window.setTimeout(() => finished.current?.(), 3000 + cast.length * 1200);
      return () => clearTimeout(t);
    }
    const t = window.setTimeout(() => {
      if (i + 1 < moments.length) setI(i + 1);
      else if (cast.length) setRolling(true);
      else finished.current?.();
    }, SLIDE_MS);
    return () => clearTimeout(t);
  }, [i, moments.length, rolling, cast.length]);

  const m = moments[i];
  const ranked = useMemo(() => Object.entries(scores ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8), [scores]);

  return (
    <main
      className="recap"
      data-little="region"
      data-little-label="Best moments"
      data-little-data={JSON.stringify({ showing: m ? m.title : null, of: moments.length, index: i + 1 })}
    >
      <section className="recap-reel">
        <div className="eyebrow">{heading}</div>
        {rolling ? (
          <div className="credits" data-little="readout" data-little-label="Credits" data-little-data={JSON.stringify(cast)}>
            <div className="credits-roll" style={{ animationDuration: `${3000 + cast.length * 1200}ms` }}>
              <div className="credits-title">Starring</div>
              {cast.map((c, k) => (
                <div key={k} className="credits-line">
                  <b>{c.name}</b>
                  <span>as {c.role}</span>
                </div>
              ))}
              <div className="credits-title small">Hosted by Little · Treehouse</div>
            </div>
          </div>
        ) : m ? (
          <div className="recap-card" key={m.id}>
            {m.clip?.length ? <ClipPlayer clip={m.clip} /> : <div className="recap-icon">{KIND_ICON[m.kind ?? ""] ?? "✨"}</div>}
            <div className="recap-text">
              <div className="recap-game">{m.game}</div>
              <h2>{m.title}</h2>
              {m.caption ? <p>{m.caption}</p> : null}
              {m.players?.length ? <div className="recap-players">{m.players.join(" · ")}</div> : null}
            </div>
          </div>
        ) : (
          <div className="recap-empty">No moments yet. Play a game and they'll show up here.</div>
        )}
        <div className="recap-dots">
          {moments.map((x, k) => (
            <i key={x.id} className={k === i ? "on" : k < i ? "done" : ""} />
          ))}
        </div>
      </section>
      {ranked.length ? (
        <section className="recap-board" data-little="readout" data-little-label="Final scores" data-little-data={JSON.stringify(Object.fromEntries(ranked))}>
          <div className="eyebrow">Leaderboard</div>
          <ol>
            {ranked.map(([name, pts], k) => (
              <li key={name} className={k === 0 ? "first" : ""}>
                <span className="rk">{k + 1}</span>
                <span className="nm">{name}</span>
                <span className="pt">{pts}</span>
              </li>
            ))}
          </ol>
          <div className="recap-saved">Saved to this TV's memories</div>
        </section>
      ) : null}
    </main>
  );
}

/** Loops a skeleton clip as stick figures, framed to fit everyone in it. */
function ClipPlayer({ clip }: { clip: ClipFrame[] }) {
  const [k, setK] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const span = Math.max(400, clip[clip.length - 1].t - clip[0].t);
    const tick = (now: number) => {
      const t = clip[0].t + (((now - start) * 0.8) % (span + 500)); // slight slow-mo, short hold at the end
      let j = 0;
      while (j + 1 < clip.length && clip[j + 1].t <= t) j++;
      setK(j);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clip]);

  // Frame: bounding box of every visible point across the clip.
  const box = useMemo(() => {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const f of clip) for (const p of f.people) for (let j = 0; j < p.pts.length; j += 2) {
      const x = p.pts[j], y = p.pts[j + 1];
      if (x < 0) continue;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    const w = Math.max(x1 - x0, 0.05), h = Math.max(y1 - y0, 0.05);
    return { x0: x0 - w * 0.1, y0: y0 - h * 0.08, w: w * 1.2, h: h * 1.16 };
  }, [clip]);

  const W = 560, H = 560;
  const s = Math.min(W / box.w, H / box.h);
  const X = (x: number) => (x - box.x0) * s + (W - box.w * s) / 2;
  const Y = (y: number) => (y - box.y0) * s + (H - box.h * s) / 2;
  const f = clip[Math.min(k, clip.length - 1)];

  return (
    <svg className="recap-clip" viewBox={`0 0 ${W} ${H}`}>
      {f.people.map((p) => {
        const c = FIG_COLORS[(p.n - 1) % FIG_COLORS.length];
        const pt = (name: string) => {
          const j = idx[name] * 2;
          return p.pts[j] >= 0 ? ([p.pts[j], p.pts[j + 1]] as const) : null;
        };
        const nose = pt("nose");
        return (
          <g key={p.n}>
            {BONES.map(([a, b]) => {
              const pa = pt(a), pb = pt(b);
              return pa && pb ? <line key={a + b} x1={X(pa[0])} y1={Y(pa[1])} x2={X(pb[0])} y2={Y(pb[1])} stroke={c} strokeWidth={12} strokeLinecap="round" /> : null;
            })}
            {nose ? <circle cx={X(nose[0])} cy={Y(nose[1])} r={28} fill="none" stroke={c} strokeWidth={9} /> : null}
          </g>
        );
      })}
    </svg>
  );
}
