import { signal } from "@preact/signals";

/**
 * Key of the plugin app shown in place of the chat. A leaf module (no imports from the app
 * controller) so `openSession` can return to the chat without an import cycle.
 */
export const activeAppKey = signal<string | undefined>(undefined);
