import type { LittleApp, MotionFrame } from "@kabletv/little-sdk";

// One raw sense.motion stream → "who is in front of the TV" for camera games.
//
// Why not createMotionSession: on the real TV its built-in recognisers missed most both-arm
// raises and every squat, its aggregate status kept pausing, and a second stream beside it
// crashed the provider ("invalid-provider-packet"). So camera games use this single stream:
//   - filter phantoms (low confidence, small/partial bodies, too few clear landmarks),
//   - keep the two biggest real people, each with a stable number 1..2 (mirror order on entry),
//   - detect arm raises from the skeleton (wrist clearly above shoulder, with hysteresis),
//   - report figures (mirrored, for drawing) and action edges in the bridge's motion format.

export interface Person {
  /** stable number 1..MAX while the person stays tracked */
  n: number;
  id: string;
  /** box in mirrored image coordinates 0..1 (as if the TV were a mirror) */
  box: { x: number; y: number; w: number; h: number };
  /** COCO-17 landmark name -> [x, y, confidence], mirrored x; missing points omitted */
  points: Record<string, [number, number, number]>;
  arms: { left: boolean; right: boolean };
  /** current held poses: arm-left, arm-right, arms-up, arms-out, hands-on-head, lean-left,
   *  lean-right, squat (jump is an edge only) */
  poses: string[];
}

export interface PeopleEvents {
  onPeople(people: Person[]): void;
  /** edges: arm-raise with side, both-arms-raise; slot = n - 1 */
  onActions(actions: { id: string; side?: "left" | "right"; slot: number }[]): void;
  onStatus(state: string, reason?: string): void;
}

const MAX = 2;
const MIN_CONF = 0.45; // entity confidence
const MIN_BOX_H = 0.22; // of image height: smaller is background or partial
const MIN_POINTS = 9; // landmarks with confidence >= POINT_CONF
const POINT_CONF = 0.35;
const LOST_MS = 1500; // free a number after this long unseen
const BOTH_WINDOW_MS = 600;

type ArmState = { up: boolean; upAt: number };
type BodyState = {
  baseY: number | null; // standing shoulder height (EMA while neutral)
  torso: number; // shoulder→hip length, EMA
  prevY: number | null;
  airborne: boolean;
  poses: Set<string>;
  pending: Map<string, number>; // pose -> frames seen (debounce)
};

export function trackPeople(app: LittleApp, ev: PeopleEvents): { close(): void } {
  const numbers = new Map<string, number>(); // entity id -> n
  const lastSeen = new Map<string, number>();
  const arms = new Map<string, { left: ArmState; right: ArmState }>();
  const bodies = new Map<string, BodyState>();
  let lastEmit = 0;

  const sub = app.sense.motion(
    {
      onStatus: (s) => ev.onStatus(s.state, s.reason),
      onFrame: (f: MotionFrame) => {
        const now = Date.now();
        const candidates = f.entities
          .map((e) => {
            const box = e.imageBox?.value;
            const pose = e.channels.find((c) => c.channelId === "body.pose-2d")?.bodyPose2d;
            if (!box || !pose || e.state === "missing" || e.confidence < MIN_CONF || box.height < MIN_BOX_H) return null;
            const points: Person["points"] = {};
            let clear = 0;
            for (const l of pose.landmarks) {
              if (!l.position) continue;
              points[l.name] = [1 - l.position.x, l.position.y, l.confidence];
              if (l.confidence >= POINT_CONF) clear++;
            }
            if (clear < MIN_POINTS) return null;
            return { id: e.id, box: { x: 1 - box.x - box.width, y: box.y, w: box.width, h: box.height }, points };
          })
          .filter((c): c is NonNullable<typeof c> => c !== null)
          .sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)
          .slice(0, MAX);

        for (const c of candidates) lastSeen.set(c.id, now);
        for (const [id, t] of lastSeen) {
          if (now - t > LOST_MS) {
            lastSeen.delete(id);
            numbers.delete(id);
            arms.delete(id);
            bodies.delete(id);
          }
        }
        // New people take the lowest free number, left to right in the mirror.
        const fresh = candidates.filter((c) => !numbers.has(c.id)).sort((a, b) => a.box.x - b.box.x);
        for (const c of fresh) {
          const used = new Set(numbers.values());
          for (let n = 1; n <= MAX; n++) if (!used.has(n)) { numbers.set(c.id, n); break; }
        }

        const actions: { id: string; side?: "left" | "right"; slot: number }[] = [];
        const people: Person[] = [];
        for (const c of candidates) {
          const n = numbers.get(c.id);
          if (!n) continue;
          const st = arms.get(c.id) ?? { left: { up: false, upAt: 0 }, right: { up: false, upAt: 0 } };
          arms.set(c.id, st);
          for (const side of ["left", "right"] as const) {
            const next = armUp(c.points, side, st[side].up);
            if (next === null) continue;
            if (next && !st[side].up) {
              st[side] = { up: true, upAt: now };
              actions.push({ id: "arm-raise", side, slot: n - 1 });
              const other = st[side === "left" ? "right" : "left"];
              if (other.up && now - other.upAt <= BOTH_WINDOW_MS) actions.push({ id: "both-arms-raise", slot: n - 1 });
            } else if (!next && st[side].up) st[side] = { up: false, upAt: 0 };
          }
          const body = bodies.get(c.id) ?? { baseY: null, torso: 0.25, prevY: null, airborne: false, poses: new Set<string>(), pending: new Map() };
          bodies.set(c.id, body);
          const seen = bodyPoses(c.points, body, st.left.up, st.right.up);
          // Debounce: a pose counts after 2 consecutive frames; report entering edges.
          for (const pose of seen.held) {
            const k = (body.pending.get(pose) ?? 0) + 1;
            body.pending.set(pose, k);
            if (k === 2 && !body.poses.has(pose)) {
              body.poses.add(pose);
              if (pose !== "arm-left" && pose !== "arm-right" && pose !== "arms-up") actions.push({ id: pose, slot: n - 1 });
            }
          }
          for (const pose of [...body.pending.keys()]) if (!seen.held.has(pose)) { body.pending.delete(pose); body.poses.delete(pose); }
          if (seen.jump) actions.push({ id: "jump", slot: n - 1 });
          people.push({ n, id: c.id, box: c.box, points: c.points, arms: { left: st.left.up, right: st.right.up }, poses: [...body.poses] });
        }
        if (actions.length) ev.onActions(actions);
        if (now - lastEmit >= 90) {
          lastEmit = now;
          ev.onPeople(people.sort((a, b) => a.n - b.n));
        }
      },
    },
    { maximumEntities: 4, rateHz: 15 },
  );
  return { close: () => sub.close() };
}

/** true/false when the arm is clearly up/down, null when the points are too unsure to tell. */
function armUp(p: Person["points"], side: "left" | "right", wasUp: boolean): boolean | null {
  const sh = p[`${side}_shoulder`], wr = p[`${side}_wrist`];
  if (!sh || !wr || sh[2] < POINT_CONF || wr[2] < POINT_CONF) return null;
  const hip = p[`${side}_hip`];
  const torso = hip && hip[2] >= POINT_CONF ? Math.abs(hip[1] - sh[1]) : 0.25;
  // y grows downward. Up: wrist well above the shoulder. Down again only once it drops back near
  // shoulder height, so a held arm doesn't flicker.
  const lift = (sh[1] - wr[1]) / Math.max(torso, 0.05);
  return wasUp ? lift > 0.1 : lift > 0.35;
}

/**
 * Whole-body poses from one frame (mirrored coordinates: x grows to the person's own right as
 * seen in a mirror, y grows downward). Everything is scaled by the torso length so distance to
 * the camera doesn't matter. Baselines only learn while the person is standing neutral.
 */
function bodyPoses(p: Person["points"], b: BodyState, leftUp: boolean, rightUp: boolean): { held: Set<string>; jump: boolean } {
  const held = new Set<string>();
  const ok = (k: string) => p[k] && p[k][2] >= POINT_CONF;
  if (leftUp) held.add("arm-left");
  if (rightUp) held.add("arm-right");
  if (!ok("left_shoulder") || !ok("right_shoulder")) return { held, jump: false };
  const ls = p.left_shoulder, rs = p.right_shoulder;
  const shY = (ls[1] + rs[1]) / 2, shX = (ls[0] + rs[0]) / 2;
  const shW = Math.max(Math.abs(ls[0] - rs[0]), 0.02);
  if (ok("left_hip") && ok("right_hip")) {
    const t = Math.abs((p.left_hip[1] + p.right_hip[1]) / 2 - shY);
    if (t > 0.05) b.torso = b.torso * 0.9 + t * 0.1;
  }
  const T = Math.max(b.torso, 0.08);

  const lw = ok("left_wrist") ? p.left_wrist : null, rw = ok("right_wrist") ? p.right_wrist : null;
  const nose = ok("nose") ? p.nose : null;
  if (lw && rw) {
    // Arms up: both wrists well above the head.
    if (nose && lw[1] < nose[1] - 0.25 * T && rw[1] < nose[1] - 0.25 * T) held.add("arms-up");
    // Arms out: both wrists near shoulder height and far outside the shoulders.
    const nearShoulder = (w: number[]) => Math.abs(w[1] - shY) < 0.35 * T;
    const outside = Math.min(lw[0], rw[0]) < Math.min(ls[0], rs[0]) - 0.9 * shW && Math.max(lw[0], rw[0]) > Math.max(ls[0], rs[0]) + 0.9 * shW;
    if (nearShoulder(lw) && nearShoulder(rw) && outside) held.add("arms-out");
    // Hands on head: both wrists between shoulder and just above the nose, close to the head.
    if (nose) {
      const onHead = (w: number[]) => w[1] < shY - 0.15 * T && w[1] > nose[1] - 0.45 * T && Math.abs(w[0] - nose[0]) < 1.1 * shW;
      if (onHead(lw) && onHead(rw)) held.add("hands-on-head");
    }
  }
  // Lean: shoulders shifted sideways over the hips (own side, thanks to mirrored x).
  if (ok("left_hip") && ok("right_hip")) {
    const hipX = (p.left_hip[0] + p.right_hip[0]) / 2;
    const dx = (shX - hipX) / T;
    if (dx < -0.3) held.add("lean-left");
    else if (dx > 0.3) held.add("lean-right");
  }
  // Squat and jump against the standing baseline.
  let jump = false;
  if (b.baseY === null) b.baseY = shY;
  const dy = (shY - b.baseY) / T; // + is lower
  if (dy > 0.45) held.add("squat");
  if (!b.airborne && dy < -0.25 && b.prevY !== null && b.prevY - shY > 0.06 * T) { b.airborne = true; jump = true; }
  else if (b.airborne && dy > -0.08) b.airborne = false;
  const neutral = held.size === 0 && !b.airborne;
  if (neutral) b.baseY = b.baseY * 0.92 + shY * 0.08;
  b.prevY = shY;
  return { held, jump };
}
