/**
 * Typed fetch wrappers over the dashboard JSON API. The single place the SPA
 * talks to the server — components call these, never `fetch` directly. Repo
 * (`owner/name`) and session ids are URL-encoded here so a slash never splits a
 * path segment (the server `decodeURIComponent`s each).
 */

import type {
  AttachResult,
  GlobalBanner,
  NeedsYouItem,
  RepoDetail,
  RepoSummary,
  RunnerPanel,
  SessionEvent,
  SettingsWire,
} from "../wire.ts";

/** A non-2xx response, carrying the server's error detail when it sent one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** GET + parse JSON, throwing {@link ApiError} on a non-2xx. */
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new ApiError(res.status, await errorDetail(res));
  return (await res.json()) as T;
}

/** POST (optional JSON body) + parse JSON, throwing {@link ApiError} on a non-2xx. */
async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new ApiError(res.status, await errorDetail(res));
  return (await res.json()) as T;
}

/** Pull `{ error }` from a JSON error body, falling back to the status text. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // non-JSON body — fall through to the status text
  }
  return `${res.status} ${res.statusText}`;
}

const enc = encodeURIComponent;

export const api = {
  banner: () => getJson<GlobalBanner>("/api/banner"),
  repos: () => getJson<RepoSummary[]>("/api/repos"),
  repo: (repo: string) => getJson<RepoDetail>(`/api/repos/${enc(repo)}`),
  needsYou: () => getJson<NeedsYouItem[]>("/api/needs-you"),
  settings: () => getJson<SettingsWire>("/api/settings"),

  session: (session: string) => getJson<RunnerPanel>(`/api/sessions/${enc(session)}`),
  sessionEvents: (session: string) =>
    getJson<SessionEvent[]>(`/api/sessions/${enc(session)}/events`),
  /** The transcript path — the SPA links to it / streams it rather than parsing. */
  transcriptUrl: (session: string) => `/api/sessions/${enc(session)}/transcript`,

  attach: (session: string, mode: "watch" | "control") =>
    postJson<AttachResult>(`/api/sessions/${enc(session)}/attach`, { mode }),
  release: (session: string) => postJson<{ ok: true }>(`/api/sessions/${enc(session)}/release`),

  clearRateLimit: (adapter: string) =>
    postJson<{ ok: true }>(`/api/rate-limits/${enc(adapter)}/clear`),
  pauseRepo: (repo: string, untilMs?: number) =>
    postJson<{ ok: true }>(
      `/api/repos/${enc(repo)}/pause`,
      untilMs !== undefined ? { untilMs } : {},
    ),
  resumeRepo: (repo: string) => postJson<{ ok: true }>(`/api/repos/${enc(repo)}/resume`),
  runRecommender: (repo: string) =>
    fetch(`/api/repos/${enc(repo)}/run-recommender`, { method: "POST" }),
  updateGlobalConfig: (patch: { maxConcurrent?: number; defaultAdapter?: string }) =>
    postJson<SettingsWire>("/api/settings/global", patch),
};
