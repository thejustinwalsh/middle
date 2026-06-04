import { type SseHandlers, useEventStream } from "../useSse.ts";

/**
 * A render-less SSE subscriber (returns `null`). Mounting it opens an
 * `EventSource` to `url` and routes each named event to `handlers`; unmounting
 * closes it. `url === null` subscribes to nothing. App renders one per live
 * channel (the global banner, each expanded repo, the open Inspector session),
 * so a channel's subscription lifecycle follows the UI that needs it.
 */
export function ChannelSubscriber({
  url,
  handlers,
}: {
  url: string | null;
  handlers: SseHandlers;
}) {
  useEventStream(url, handlers);
  return null;
}
