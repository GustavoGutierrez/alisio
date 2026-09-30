/**
 * Durable events of the open session, loaded through `GET /events` in pages and then
 * incrementally (`after=` the last id) whenever new events arrive. One feed filtered to the
 * stats types (always on, small) and one unfiltered for the Trajectory tab (loaded on demand).
 */
import type { RunEvent } from "@alisio/sdk";
import { signal } from "@preact/signals";
import { api, currentId } from "./app.ts";
import { appendEvents } from "./trajectory.ts";

export interface FeedState {
  sessionId: string;
  items: RunEvent[];
  loading: boolean;
  loaded: boolean;
  error?: string;
}

const empty = (sessionId: string): FeedState => ({
  sessionId,
  items: [],
  loading: false,
  loaded: false,
});

function createFeed(types?: string[]) {
  const state = signal<FeedState>(empty(""));
  let running: Promise<void> | undefined;
  let again = false;
  async function sync(): Promise<void> {
    const id = currentId.value;
    if (!id) return;
    if (state.value.sessionId !== id) state.value = empty(id);
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      state.value = { ...state.value, loading: true };
      try {
        let after = Number(state.value.items.at(-1)?.eventId ?? 0);
        for (;;) {
          const page = await api.events(id, after, 1000, types);
          if (state.value.sessionId !== id) return;
          state.value = { ...state.value, items: appendEvents(state.value.items, page.items) };
          if (!page.next) break;
          after = Number(page.next);
        }
        state.value = { sessionId: id, items: state.value.items, loading: false, loaded: true };
      } catch (error) {
        if (state.value.sessionId === id)
          state.value = {
            ...state.value,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          };
      }
    })().finally(() => {
      running = undefined;
      if (again) {
        again = false;
        void sync();
      }
    });
    return running;
  }
  return { state, sync };
}

export const statsFeed = createFeed(["run_started", "turn_completed", "tool_completed"]);
export const trajectoryFeed = createFeed();
