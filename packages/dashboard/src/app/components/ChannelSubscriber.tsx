/**
 * A render-less SSE subscriber. Mounting it opens an `EventSource` to `url` and
 * routes each named event to `handlers`; unmounting closes it. App renders one
 * per live channel (the global banner, each expanded repo, the open Inspector
 * session), so a channel's subscription lifecycle follows the UI that needs it.
 */
import { type SseHandlers, useEventStream } from "../useSse.ts";

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
