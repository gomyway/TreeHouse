import { COCO, type ClipFrame, type Moment } from "../game/memories";

// Dev preview data for the recap (open the TV app with ?recapdemo): a synthetic 2.5 s clip of
// two stick figures, one raising both arms while the other leans, plus a few text moments.

function figure(cx: number, armsUp: number, lean: number): number[] {
  const P: Record<string, [number, number]> = {
    nose: [cx + lean * 0.05, 0.2], left_eye: [cx - 0.01, 0.19], right_eye: [cx + 0.01, 0.19], left_ear: [cx - 0.02, 0.2], right_ear: [cx + 0.02, 0.2],
    left_shoulder: [cx - 0.06 + lean * 0.04, 0.3], right_shoulder: [cx + 0.06 + lean * 0.04, 0.3],
    left_elbow: [cx - 0.1 + lean * 0.03, 0.3 + 0.08 * (1 - armsUp) - 0.1 * armsUp], right_elbow: [cx + 0.1 + lean * 0.03, 0.3 + 0.08 * (1 - armsUp) - 0.1 * armsUp],
    left_wrist: [cx - 0.11, 0.3 + 0.16 * (1 - armsUp) - 0.22 * armsUp], right_wrist: [cx + 0.11, 0.3 + 0.16 * (1 - armsUp) - 0.22 * armsUp],
    left_hip: [cx - 0.045, 0.52], right_hip: [cx + 0.045, 0.52], left_knee: [cx - 0.05, 0.67], right_knee: [cx + 0.05, 0.67],
    left_ankle: [cx - 0.05, 0.82], right_ankle: [cx + 0.05, 0.82],
  };
  return COCO.flatMap((k) => P[k]);
}

const clip: ClipFrame[] = Array.from({ length: 25 }, (_, i) => {
  const k = Math.min(1, Math.max(0, (i - 6) / 8));
  return { t: -2500 + i * 100, people: [{ n: 1, pts: figure(0.35, k, 0) }, { n: 2, pts: figure(0.65, 0, Math.sin(i / 4)) }] };
});

const now = Date.now();
export const DEMO_MOMENTS: Moment[] = [
  { id: "d1", at: now, game: "Little Says", kind: "fail", title: "Gotcha, Leo!", caption: 'Moved on "both arms up" without Little says', players: ["Leo"], clip },
  { id: "d2", at: now, game: "Who's the Bot?", kind: "bot", title: "The bot fooled everyone", caption: '"chen after gym" was written by a bot (Sam).' },
  { id: "d3", at: now, game: "Who's the Bot?", kind: "funny", title: '"the couch wins"', caption: "Funniest answer to: A new rule for this living room", players: ["Nelson"] },
  { id: "d4", at: now, game: "Little Says", kind: "win", title: "Nelson wins Little Says", caption: "1400 points, still standing", players: ["Nelson"] },
];
export const DEMO_CREDITS: Moment[] = [
  { id: "a1", at: now, game: "Little Says", kind: "award", title: "Little Says Champion", players: ["Nelson"] },
  { id: "a2", at: now, game: "Little Says", kind: "award", title: "Most Easily Tricked", players: ["Leo"] },
  { id: "a3", at: now, game: "Who's the Bot?", kind: "award", title: "The Most Robotic Human", players: ["Leo"] },
];
export const DEMO_SCORES = { Nelson: 1400, Leo: 900, Ana: 600 };
