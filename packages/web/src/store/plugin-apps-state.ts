import { signal } from "@preact/signals";

/**
 * Key of the plugin app shown in place of the chat. A leaf module (no imports from the app
 * controller) so `openSession` can return to the chat without an import cycle.
 */
export const activeAppKey = signal<string | undefined>(undefined);
/**
 * Session the open app runs in (set while an app is shown): the stream also watches it so the
 * approvals of its actions reach this tab even when the open chat is another session.
 */
export const activeAppSession = signal<string | undefined>(undefined);
/**
 * The plugin creator page is shown in place of the chat (like an app). Its page lives in a lazy
 * chunk; only these signals are in the initial bundle.
 */
export const creatorOpen = signal(false);
/** Session of the creator project on screen: the stream also watches it (feed and approvals). */
export const creatorSession = signal<string | undefined>(undefined);
/** Listeners of every batch of stream frames (the creator page's own transcript). */
export const frameTaps = new Set<(frames: import("@alisio/sdk").ServerFrame[]) => void>();

/** Shows the plugin creator page in place of the chat (leaving any open app). */
export function openCreator(): void {
  activeAppKey.value = undefined;
  creatorOpen.value = true;
}
