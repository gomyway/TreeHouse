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

export function trackPeople(app: LittleApp, ev: PeopleEvents): { close(): void } {
  const numbers = new Map<string, number>(); // entity id -> n
  const lastSeen = new Map<string, number>();
  const arms = new Map<string, { left: ArmState; right: ArmState }>();
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
          people.push({ n, id: c.id, box: c.box, points: c.points, arms: { left: st.left.up, right: st.right.up } });
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
