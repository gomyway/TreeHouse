import { RELAY_HTTP } from "../config";
import type { GameMeta } from "./catalog";

// Authoring manager on the relay Worker (relay/README.md): POST /author → 202 { jobId },
// then poll GET /author/:jobId every 2 s until done (carries id + meta) or error.
// A real game takes 1–3 minutes to write; we give up after 4.

export type AuthorProgress = { status: string; elapsedMs: number };

export async function authorGame(
  prompt: string,
  onProgress: (p: AuthorProgress) => void,
  signal?: AbortSignal,
): Promise<GameMeta> {
  const started = Date.now();
  const res = await fetch(`${RELAY_HTTP}/author`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
    signal,
  });
  const first = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok && res.status !== 202) throw new Error(String(first.error ?? `author failed (${res.status})`));

  // A synchronous answer (older Worker or ?wait=1) already carries the game.
  if (first.id && first.meta) return { ...(first.meta as GameMeta), id: String(first.id), source: "relay" };

  const jobId = String(first.jobId ?? "");
  if (!jobId) throw new Error("author returned no job id");

  while (Date.now() - started < 4 * 60_000) {
    if (signal?.aborted) throw new Error("cancelled");
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetch(`${RELAY_HTTP}/author/${encodeURIComponent(jobId)}`, { cache: "no-store", signal });
    const job = (await poll.json().catch(() => ({}))) as Record<string, unknown>;
    const status = String(job.status ?? "running");
    onProgress({ status, elapsedMs: Date.now() - started });
    if (status === "done" && job.id) return { ...((job.meta as GameMeta) ?? {}), id: String(job.id), source: "relay" };
    if (status === "error" || status === "failed") throw new Error(String(job.error ?? "the game could not be written"));
  }
  throw new Error("writing the game took longer than 4 minutes");
}
