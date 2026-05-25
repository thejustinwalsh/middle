/**
 * The dashboard JSON API — the spec's "Dashboard → API" route list, plus the
 * banner / needs-you / per-session-panel / settings reads the SPA needs. Every
 * handler delegates to the {@link DashboardDeps} seam, so the whole surface
 * unit-tests against an in-memory fake.
 *
 * `handleApi` returns a `Response` for any `/api/*` path and `undefined` for
 * anything else, so the server can fall through to the SPA. Repo and session
 * path params are **URL-encoded** by callers (a repo is `owner/name` — the slash
 * must not split into two segments), so each segment is `decodeURIComponent`-ed.
 */

import type { DashboardDeps } from "./deps.ts";

/** JSON 404 with a stable shape. */
function notFound(detail: string): Response {
  return Response.json({ error: detail }, { status: 404 });
}

/** JSON 400 with a stable shape. */
function badRequest(detail: string): Response {
  return Response.json({ error: detail }, { status: 400 });
}

/** Parse a JSON body, tolerating an empty/garbled one (→ `{}`). */
async function readJson(req: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return {};
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

/**
 * Route an `/api/*` request. Returns `undefined` when the path is not under
 * `/api/` so the caller serves the SPA instead. Unknown `/api/*` paths and
 * method mismatches resolve to a JSON 404 (they are API misses, not SPA routes).
 */
export async function handleApi(req: Request, deps: DashboardDeps): Promise<Response | undefined> {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments[0] !== "api") return undefined;

  const method = req.method;
  // segments[0] is "api"; decode the rest (repo = owner/name arrives encoded).
  const rest = segments.slice(1).map((s) => decodeURIComponent(s));
  const [resource, ...tail] = rest;

  if (resource === "banner" && tail.length === 0 && method === "GET") {
    return Response.json(await deps.banner());
  }

  if (resource === "needs-you" && tail.length === 0 && method === "GET") {
    return Response.json(await deps.needsYou());
  }

  if (resource === "settings") {
    return handleSettings(req, deps, tail, method);
  }

  if (resource === "rate-limits") {
    // POST /api/rate-limits/:adapter/clear
    if (tail.length === 2 && tail[1] === "clear" && method === "POST") {
      await deps.clearRateLimit(tail[0]!);
      return Response.json({ ok: true });
    }
    return notFound(`no such rate-limits route: ${url.pathname}`);
  }

  if (resource === "repos") {
    return handleRepos(req, deps, tail, method);
  }

  if (resource === "sessions") {
    return handleSessions(req, deps, tail, method);
  }

  return notFound(`no such API route: ${url.pathname}`);
}

/** `/api/settings` (GET) + `/api/settings/global` (POST). */
async function handleSettings(
  req: Request,
  deps: DashboardDeps,
  tail: string[],
  method: string,
): Promise<Response> {
  if (tail.length === 0 && method === "GET") {
    return Response.json(await deps.getSettings());
  }
  if (tail.length === 1 && tail[0] === "global" && method === "POST") {
    const body = await readJson(req);
    const patch: { maxConcurrent?: number; defaultAdapter?: string } = {};
    if (typeof body.maxConcurrent === "number" && Number.isInteger(body.maxConcurrent)) {
      if (body.maxConcurrent < 1) return badRequest("maxConcurrent must be an integer >= 1");
      patch.maxConcurrent = body.maxConcurrent;
    } else if (body.maxConcurrent !== undefined) {
      return badRequest("maxConcurrent must be an integer");
    }
    if (typeof body.defaultAdapter === "string" && body.defaultAdapter.trim() !== "") {
      patch.defaultAdapter = body.defaultAdapter;
    } else if (body.defaultAdapter !== undefined) {
      return badRequest("defaultAdapter must be a non-empty string");
    }
    await deps.updateGlobalConfig(patch);
    return Response.json(await deps.getSettings());
  }
  return notFound("no such settings route");
}

/** `/api/repos`, `/api/repos/:repo`, and the per-repo action routes. */
async function handleRepos(
  req: Request,
  deps: DashboardDeps,
  tail: string[],
  method: string,
): Promise<Response> {
  if (tail.length === 0 && method === "GET") {
    return Response.json(await deps.listRepos());
  }
  const repo = tail[0];
  if (repo === undefined || repo === "") return badRequest("repo path segment is required");

  // GET /api/repos/:repo
  if (tail.length === 1 && method === "GET") {
    const detail = await deps.getRepo(repo);
    return detail ? Response.json(detail) : notFound(`unknown repo: ${repo}`);
  }

  if (tail.length === 2 && method === "POST") {
    const action = tail[1];
    if (action === "pause") {
      const body = await readJson(req);
      const until =
        typeof body.untilMs === "number" && Number.isInteger(body.untilMs)
          ? body.untilMs
          : undefined;
      await deps.pauseRepo(repo, until);
      return Response.json({ ok: true });
    }
    if (action === "resume") {
      await deps.resumeRepo(repo);
      return Response.json({ ok: true });
    }
    if (action === "run-recommender") {
      if (!deps.runRecommender) return notFound("recommender trigger not wired");
      const result = await deps.runRecommender(repo);
      return new Response(result.body, { status: result.status });
    }
    if (action === "dispatch") {
      // Manual dispatch flows through the dispatcher's own /control/dispatch; the
      // dashboard surfaces it but does not own the engine. Wired when the daemon
      // hosts these routes; standalone → not available.
      return notFound("manual dispatch not available in this dashboard mode");
    }
  }
  return notFound(`no such repo route: /${tail.join("/")}`);
}

/** `/api/sessions/:session/{,events,transcript,attach,release}`. */
async function handleSessions(
  req: Request,
  deps: DashboardDeps,
  tail: string[],
  method: string,
): Promise<Response> {
  const session = tail[0];
  if (session === undefined || session === "")
    return badRequest("session path segment is required");

  // GET /api/sessions/:session — the Inspector panel.
  if (tail.length === 1 && method === "GET") {
    const panel = await deps.getRunnerPanel(session);
    return panel ? Response.json(panel) : notFound(`unknown session: ${session}`);
  }

  if (tail.length === 2) {
    const action = tail[1];
    if (action === "events" && method === "GET") {
      const limitParam = new URL(req.url).searchParams.get("limit");
      const limit = limitParam !== null ? Number(limitParam) : undefined;
      // Reject not just non-integers but unsafe ones — `Number.isInteger(1e20)`
      // is true, yet it would reach SQLite's LIMIT as garbage. A safe integer
      // ≥ 1 is the contract.
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
        return badRequest("limit must be a positive integer");
      }
      const events = await deps.getSessionEvents(session, limit);
      return events ? Response.json(events) : notFound(`unknown session: ${session}`);
    }
    if (action === "transcript" && method === "GET") {
      const read = await deps.getTranscript(session);
      if (!read) return notFound(`no transcript for session: ${session}`);
      return new Response(read.stream, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-cache",
          "x-transcript-path": read.path,
        },
      });
    }
    if (action === "attach" && method === "POST") {
      const body = await readJson(req);
      const mode = body.mode;
      if (mode !== "watch" && mode !== "control") {
        return badRequest('mode must be "watch" or "control"');
      }
      const result = await deps.attach(session, mode);
      return result ? Response.json(result) : notFound(`unknown session: ${session}`);
    }
    if (action === "release" && method === "POST") {
      const ok = await deps.release(session);
      return ok ? Response.json({ ok: true }) : notFound(`unknown session: ${session}`);
    }
  }
  return notFound(`no such session route: /${tail.join("/")}`);
}
