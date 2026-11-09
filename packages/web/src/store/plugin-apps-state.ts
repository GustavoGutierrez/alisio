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
