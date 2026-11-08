import { useEffect, useId, useRef } from "react";
import type { Player } from "../room/model";
import type { GameMeta } from "../game/catalog";
import { seatFor, seatSrc, validSeats } from "../game/seats";
import { paletteFor } from "../game/theme";
import { Qr } from "./Qr";

export function StatusPill({ status }: { status: string }) {
  const label = { connecting: "Opening room…", open: "Room open", reconnecting: "Reconnecting…", offline: "Offline" }[status] ?? status;
  return (
    <div className={`pill pill-${status}`} data-little="readout" data-little-label="Room status" data-little-data={JSON.stringify({ status })}>
      <i /> {label}
    </div>
  );
}

export function Lobby({
  code,
  joinUrl,
  players,
  status,
  games,
  focus,
  onPick,
}: {
  code: string | null;
  joinUrl: string | null;
  players: Player[];
  status: string;
  games: GameMeta[];
  focus: number;
  onPick: (g: GameMeta) => void;
}) {
  const shortUrl = joinUrl?.replace(/^https?:\/\//, "").replace(/\/?\?c=.*$/, "");
  // One focus system: the browser's own focus follows our remote focus index, so the TV never
  // shows two highlighted tiles (its native ring on one, ours on another).
  const tiles = useRef<(HTMLLIElement | null)[]>([]);
  useEffect(() => {
    tiles.current[focus]?.focus({ preventScroll: true });
  }, [focus, games.length]);

  // Preview the focused game: its palette washes over the lobby (the app's own tokens are
  // re-pointed at the game's on :root, with CSS transitions), its hook shows large, and the room is
  // drawn in its seats. Leaving the lobby restores the app palette.
  const shown = games;
  const fg = shown.length ? shown[Math.min(focus, shown.length - 1)] : undefined;
  const seats = validSeats(fg?.seats);
  useEffect(() => {
    if (!fg) return;
    const p = paletteFor(fg.palette);
    const root = document.documentElement.style;
    const vars: Record<string, string> = {
      "--bg": p.bg, "--bg-2": p.bg, "--card": p.surface, "--ink": p.ink, "--ink-2": p.ink, "--ink-3": p.muted,
      "--accent": p.accent, "--leaf": p.accent, "--line": `color-mix(in srgb, ${p.muted} 35%, transparent)`,
    };
    for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
    return () => {
      for (const k of Object.keys(vars)) root.removeProperty(k);
    };
  }, [fg?.id, fg?.palette]);
  return (
    <main className="lobby" data-little="region" data-little-label="Lobby">
      <div className="lobby-left">
        <section
          className="join card"
          data-little="readout"
          data-little-label="How to join"
          data-little-data={JSON.stringify({ code, joinUrl, players: players.length })}
        >
          {joinUrl && code ? (
            <>
              <Qr value={joinUrl} size={300} />
              <div className="join-text">
                <div className="eyebrow">Grab your phone</div>
                <div className="join-line">
                  Scan, or go to <b>{shortUrl}</b>
                </div>
                <div className="eyebrow">and enter</div>
                <div className="code" aria-label={`Room code ${code.split("").join(" ")}`}>
                  {code.split("").map((ch, i) => (
                    <span key={i}>{ch}</span>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="join-wait">{status === "offline" ? "Can't reach the room server." : "Opening a room…"}</div>
          )}
        </section>

        <section className="games card" data-little="region" data-little-label="Games">
          <div className="eyebrow">Games · {games.length}</div>
          {games.length ? (
            <div className="game-browser">
              <div className="roller">
                <ul className="roller-list" style={{ ["--f" as string]: Math.min(focus, games.length - 1) }}>
                  {games.map((g, i) => (
                    <li
                      key={g.id}
                      ref={(el) => {
                        tiles.current[i] = el;
                      }}
                      tabIndex={i === focus ? 0 : -1}
                      className={`game-tile${i === focus ? " focused" : ""}`}
                      style={{ ["--d" as string]: Math.min(3, Math.abs(i - focus)) }}
                      data-little="item"
                      data-little-id={g.id}
                      data-little-action="start_game"
                      data-little-label={g.title}
                      data-little-order={i + 1}
                      data-little-data={JSON.stringify({ players: `${g.minPlayers ?? 1}-${g.maxPlayers ?? 12}` })}
                      onClick={() => onPick(g)}
                    >
                      <i className="dot" style={{ background: paletteFor(g.palette).accent }} />
                      <b>{g.title}</b>
                    </li>
                  ))}
                </ul>
              </div>
              {fg ? (
                <div
                  className="game-detail"
                  key={fg.id}
                  data-little="readout"
                  data-little-label="Focused game"
                  data-little-data={JSON.stringify({ title: fg.title, hook: fg.hook ?? null, description: fg.description })}
                >
                  <div className="detail-title">{fg.title}</div>
                  {fg.hook ? <div className="game-hook">{fg.hook}</div> : null}
                  <p className="detail-desc">{fg.description}</p>
                  <div className="detail-chips">
                    <span>
                      {fg.minPlayers ?? 1}–{fg.maxPlayers ?? 12} players
                    </span>
                    <span>{fg.phonesRequired === false ? "Camera game" : "Phones"}</span>
                    {fg.palette ? <span>{fg.palette}</span> : null}
                  </div>
                  <div className="detail-go">Press OK to play</div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="empty small">Loading games…</div>
          )}
        </section>
      </div>

      <section className="players card" data-little="region" data-little-label="Players">
        <div className="players-head">
          <span className="eyebrow">In the room</span>
          <span className="count" data-little="readout" data-little-label="Player count" data-little-data={JSON.stringify({ value: players.length })}>
            {players.length}
          </span>
        </div>
        <Couch players={players} seats={seats} gameKey={fg?.id ?? ""} />
        <div className="hint">Say “play Who’s the Bot” or “make a game where…”</div>
      </section>
    </main>
  );
}

// An oversized round armchair (a low drum base, a thick puffy seat cushion with piping, rounded
// arms wrapping the sides); the players sit where its throw pillows would, fanned along the back.
// Drawn in currentColor so it takes the focused game's accent. Volume comes from black/white
// gradient overlays (highlights on top, occlusion where parts meet), not from fixed colours.
function CloudCouch() {
  const u = useId().replace(/:/g, "");
  const id = (n: string) => `${u}-${n}`;
  const url = (n: string) => `url(#${id(n)})`;
  const BACK = "M76 190 C60 14, 540 14, 524 190 Z";
  const WALL = "M128 192 C116 76, 484 76, 472 192 Z";
  const BASE = "M84 206 L84 240 A216 34 0 0 0 516 240 L516 206 Z";
  const SEAT = "M106 208 Q102 164 300 160 Q498 164 494 208 Q492 240 300 242 Q108 240 106 208 Z";
  return (
    <svg className="couch-art" viewBox="0 0 600 300" aria-hidden="true">
      <defs>
        <radialGradient id={id("floor")} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#000" stopOpacity=".55" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
        {/* the back: lit along its top rim, shadowed deep in the bowl */}
        <linearGradient id={id("back")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".26" />
          <stop offset=".25" stopColor="#fff" stopOpacity=".06" />
          <stop offset=".7" stopColor="#000" stopOpacity=".34" />
          <stop offset="1" stopColor="#000" stopOpacity=".45" />
        </linearGradient>
        {/* puffy parts: a soft highlight up and left, darker toward the edges */}
        <radialGradient id={id("puff")} cx="42%" cy="30%" r="75%">
          <stop offset="0" stopColor="#fff" stopOpacity=".34" />
          <stop offset=".45" stopColor="#fff" stopOpacity=".05" />
          <stop offset="1" stopColor="#000" stopOpacity=".32" />
        </radialGradient>
        <linearGradient id={id("base")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity=".42" />
          <stop offset=".3" stopColor="#000" stopOpacity=".14" />
          <stop offset="1" stopColor="#000" stopOpacity=".4" />
        </linearGradient>
        <radialGradient id={id("tuck")} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#000" stopOpacity=".5" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
        <pattern id={id("boucle")} width="8" height="8" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1.3" fill="#fff" opacity=".12" />
          <circle cx="6" cy="5.5" r="1.1" fill="#000" opacity=".1" />
        </pattern>
      </defs>
      <ellipse cx="300" cy="284" rx="280" ry="18" fill={url("floor")} />
      {/* wooden feet */}
      {[132, 468].map((x) => (
        <path key={x} d={`M${x - 11} 262 L${x + 11} 262 L${x + 7} 288 L${x - 7} 288 Z`} fill="#3b2a1e" />
      ))}
      {/* back */}
      <path d={BACK} fill="currentColor" />
      <path d={BACK} fill={url("back")} />
      <path d="M86 150 C76 42, 524 42, 514 150" stroke="#fff" strokeOpacity=".24" strokeWidth="6" fill="none" strokeLinecap="round" />
      {/* the inner wall of the back, where people lean: set in, in shadow */}
      <path d={WALL} fill="currentColor" />
      <path d={WALL} fill="#000" opacity=".26" />
      <path d={WALL} fill={url("back")} opacity=".7" />
      <path d="M128 192 C116 76, 484 76, 472 192" stroke="#000" strokeOpacity=".3" strokeWidth="3" fill="none" />
      {/* base drum */}
      <path d={BASE} fill="currentColor" />
      <path d={BASE} fill={url("base")} />
      <path d="M84 240 A216 34 0 0 0 516 240" stroke="#000" strokeOpacity=".3" strokeWidth="4" fill="none" />
      {/* occlusion where the cushion tucks into the arms */}
      <ellipse cx="140" cy="204" rx="56" ry="40" fill={url("tuck")} />
      <ellipse cx="460" cy="204" rx="56" ry="40" fill={url("tuck")} />
      {/* the puffy seat cushion, piping, and its shadow on the base */}
      <path d="M116 238 Q300 262 484 238" stroke="#000" strokeOpacity=".35" strokeWidth="10" fill="none" strokeLinecap="round" />
      <path d={SEAT} fill="currentColor" />
      <path d={SEAT} fill={url("puff")} />
      <path d="M110 212 Q300 234 490 212" stroke="#fff" strokeOpacity=".3" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M112 215 Q300 237 488 215" stroke="#000" strokeOpacity=".18" strokeWidth="2" fill="none" strokeLinecap="round" />
      {/* rolled arms, in front of the cushion ends, rising above the seat */}
      {[78, 522].map((cx) => (
        <g key={cx}>
          <ellipse cx={cx} cy="176" rx="58" ry="78" fill="currentColor" />
          <ellipse cx={cx} cy="176" rx="58" ry="78" fill={url("puff")} />
          <ellipse cx={cx} cy="176" rx="58" ry="78" fill={url("boucle")} />
          <path d={cx < 300 ? "M126 132 Q142 176 128 226" : "M474 132 Q458 176 472 226"} stroke="#000" strokeOpacity=".28" strokeWidth="4" fill="none" strokeLinecap="round" />
          <ellipse cx={cx - (cx < 300 ? 10 : -10)} cy="128" rx="26" ry="18" fill="#fff" opacity=".16" />
        </g>
      ))}
      <path d={BACK} fill={url("boucle")} />
      <path d={WALL} fill={url("boucle")} />
      <path d={SEAT} fill={url("boucle")} />
      <path d={BASE} fill={url("boucle")} />
    </svg>
  );
}

/** An empty seat: a throw pillow (pinched corners, puffed middle) with "Join!" on it. */
function Pillow() {
  const u = useId().replace(/:/g, "");
  return (
    <span className="pillow">
      <svg viewBox="0 0 100 92" aria-hidden="true">
        <defs>
          <radialGradient id={`${u}-p`} cx="45%" cy="38%" r="70%">
            <stop offset="0" stopColor="#fff" stopOpacity=".45" />
            <stop offset=".5" stopColor="#fff" stopOpacity=".08" />
            <stop offset="1" stopColor="#000" stopOpacity=".3" />
          </radialGradient>
        </defs>
        <path d="M8 8 Q50 16 92 8 Q84 46 92 84 Q50 76 8 84 Q16 46 8 8 Z" fill="currentColor" />
        <path d="M8 8 Q50 16 92 8 Q84 46 92 84 Q50 76 8 84 Q16 46 8 8 Z" fill={`url(#${u}-p)`} />
        <path d="M16 15 Q50 22 84 15 Q77 46 84 77 Q50 70 16 77 Q23 46 16 15 Z" fill="none" stroke="#000" strokeOpacity=".16" strokeWidth="1.5" strokeDasharray="3 3" />
      </svg>
      <b>Join!</b>
    </span>
  );
}

/** Pillow spots: seats rest on the back of the cushion between the arms, fanned like the
 *  armchair's throw pillows (the middle sits highest, the ends lean out). In % of the couch box. */
function sag(n: number, i: number) {
  const pos = i % 4;
  const off = pos - (n - 1) / 2; // -1.5 .. 1.5
  const t = off / 3; // -0.5 .. 0.5
  return {
    left: `${50 + off * 14.5}%`,
    top: `${44 + 18 * t * t}%`,
    rotate: `${(t * 22).toFixed(1)}deg`,
  };
}

/** The room as a couch: round seats on the cushions, empty ones inviting people to join. */
function Couch({ players, seats, gameKey }: { players: Player[]; seats: ReturnType<typeof validSeats>; gameKey: string }) {
  const MAX = 16; // the relay room cap
  const shown = players.slice(0, MAX);
  const slots = Math.min(MAX, Math.max(4, shown.length + (shown.length < MAX ? 1 : 0)));
  // One couch seats four; a fifth player brings out a second couch.
  const rows = Array.from({ length: Math.ceil(slots / 4) }, (_, r) => Math.min(4, slots - r * 4));
  let k = 0;
  return (
    <div className={`couch couches-${rows.length}`}>
      {rows.map((n, r) => (
        <div key={r} className="sofa">
          <ul className="couch-row">
            {Array.from({ length: n }, () => {
              const i = k++;
              const p = shown[i];
              const arc = sag(n, i);
              if (!p) {
                return (
                  <li key={`empty-${i}`} className="seat-slot empty" style={arc}>
                    <Pillow />
                  </li>
                );
              }
              const seat = seatFor(p, seats);
              return (
                <li
                  key={p.id}
                  className="seat-slot"
                  data-little="item"
                  data-little-id={p.id}
                  data-little-label={p.name}
                  data-little-order={i + 1}
                  style={{ ["--c" as string]: p.color, ...arc }}
                >
                  <span className="ring">
                    {seat ? (
                      <img key={`${gameKey}-${seat.name}`} src={seatSrc(seat, p.color)} alt={seat.name} title={seat.name} />
                    ) : (
                      <b>{p.name.slice(0, 1).toUpperCase()}</b>
                    )}
                  </span>
                  <span className="seat-name">{p.name}</span>
                </li>
              );
            })}
          </ul>
          <CloudCouch />
        </div>
      ))}
      {players.length > MAX ? <div className="couch-more">+{players.length - MAX} more on the floor</div> : null}
    </div>
  );
}
