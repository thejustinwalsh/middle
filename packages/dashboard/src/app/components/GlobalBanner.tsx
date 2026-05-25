/**
 * The top global banner: per-adapter rate-limit standing + GitHub quota. The
 * rate-limit cell is the surface the spec's "≤2s" requirement targets — its
 * data flows from the `/events/global` SSE channel (Phase #57).
 */
import type { GlobalBanner as GlobalBannerData } from "../../wire.ts";
import { rateLimitLabel, untilReset } from "../format.ts";

export function GlobalBanner({ banner, now }: { banner: GlobalBannerData; now?: number }) {
  return (
    <header className="banner">
      <span className="banner-title">⏵ middle</span>
      <span className="banner-limits">
        {banner.adapters.map((a) => {
          const reset = untilReset(a.resetAt, now);
          return (
            <span key={a.adapter} className={`limit limit-${a.status.toLowerCase()}`}>
              {a.adapter} {rateLimitLabel(a.status)}
              {reset ? ` ${reset}` : ""}
            </span>
          );
        })}
        <span className={`limit limit-${banner.github.status.toLowerCase()}`}>
          github {rateLimitLabel(banner.github.status)}
          {banner.github.remaining !== null && banner.github.limit !== null
            ? ` ${banner.github.remaining}/${banner.github.limit}`
            : ""}
        </span>
      </span>
    </header>
  );
}
