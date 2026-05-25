/**
 * The Settings view: edit global config (max concurrent, default adapter) and
 * per-repo config (auto-dispatch pause/resume), plus manual rate-limit override
 * buttons per adapter. Every change goes through the API and the parent refetches
 * `/api/settings`, so the UI always reflects persisted state.
 */
import { useEffect, useState } from "react";
import type { GlobalBanner, SettingsWire } from "../../wire.ts";

export function Settings({
  settings,
  banner,
  onSaveGlobal,
  onPauseRepo,
  onResumeRepo,
  onClearRateLimit,
}: {
  settings: SettingsWire;
  banner: GlobalBanner | null;
  onSaveGlobal: (patch: { maxConcurrent?: number; defaultAdapter?: string }) => void;
  onPauseRepo: (repo: string) => void;
  onResumeRepo: (repo: string) => void;
  onClearRateLimit: (adapter: string) => void;
}) {
  const [maxConcurrent, setMaxConcurrent] = useState(String(settings.global.maxConcurrent));
  const [defaultAdapter, setDefaultAdapter] = useState(settings.global.defaultAdapter);

  // The parent refetches `/api/settings` after every save (and on each poll
  // tick), so reflect the persisted values back into the inputs — otherwise an
  // invalid draft the server stripped would linger in the form.
  useEffect(() => {
    setMaxConcurrent(String(settings.global.maxConcurrent));
    setDefaultAdapter(settings.global.defaultAdapter);
  }, [settings.global.maxConcurrent, settings.global.defaultAdapter]);

  function saveGlobal() {
    const n = Number(maxConcurrent);
    onSaveGlobal({
      maxConcurrent: Number.isInteger(n) && n >= 1 ? n : undefined,
      defaultAdapter: defaultAdapter.trim() || undefined,
    });
  }

  return (
    <section className="settings" aria-labelledby="settings-h">
      <h2 id="settings-h">SETTINGS</h2>

      <fieldset className="settings-global">
        <legend>Global</legend>
        <label>
          max concurrent
          <input
            type="number"
            min={1}
            value={maxConcurrent}
            onChange={(e) => setMaxConcurrent(e.target.value)}
          />
        </label>
        <label>
          default adapter
          <input
            type="text"
            value={defaultAdapter}
            onChange={(e) => setDefaultAdapter(e.target.value)}
          />
        </label>
        <button type="button" onClick={saveGlobal}>
          save
        </button>
      </fieldset>

      <fieldset className="settings-rate-limits">
        <legend>Rate limits</legend>
        {(banner?.adapters ?? []).map((a) => (
          <div key={a.adapter} className="rate-limit-row">
            <span className={`limit limit-${a.status.toLowerCase()}`}>
              {a.adapter}: {a.status}
            </span>
            <button
              type="button"
              onClick={() => onClearRateLimit(a.adapter)}
              disabled={a.status === "AVAILABLE"}
            >
              clear override
            </button>
          </div>
        ))}
      </fieldset>

      <fieldset className="settings-repos">
        <legend>Repos</legend>
        {settings.repos.length === 0 ? (
          <p className="empty">No repos tracked yet.</p>
        ) : (
          <ul>
            {settings.repos.map((r) => (
              <li key={r.repo} className="settings-repo-row">
                <span className="repo-name">{r.repo}</span>
                <span className={`pill auto ${r.auto ? "on" : "off"}`}>
                  auto {r.auto ? "✓" : "✗"}
                </span>
                {r.auto ? (
                  <button type="button" onClick={() => onPauseRepo(r.repo)}>
                    pause
                  </button>
                ) : (
                  <button type="button" onClick={() => onResumeRepo(r.repo)}>
                    resume
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </fieldset>
    </section>
  );
}
