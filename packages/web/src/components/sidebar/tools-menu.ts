/**
 * Entries of the sidebar's "Settings & tools" menu, in order. A new entry is one line: icon,
 * label and one-line description keys, and the signal that opens its window.
 */
import type { Signal } from "@preact/signals";
import type { MessageKey } from "../../i18n/en.ts";
import { agentsOpen, settingsOpen, skillBuilderOpen } from "../../store/app.ts";

export interface ToolEntry {
  id: string;
  /** An `IconName` (kept a string so this module stays free of `.tsx` imports for tests). */
  icon: string;
  label: MessageKey;
  hint: MessageKey;
  open: Signal<boolean>;
}

export const TOOLS: ToolEntry[] = [
  {
    id: "agents",
    icon: "users",
    label: "sidebar.agents",
    hint: "sidebar.agentsHint",
    open: agentsOpen,
  },
  {
    id: "skillBuilder",
    icon: "sparkle",
    label: "sidebar.skillBuilder",
    hint: "sidebar.skillBuilderHint",
    open: skillBuilderOpen,
  },
  {
    id: "settings",
    icon: "settings",
    label: "sidebar.settings",
    hint: "sidebar.settingsHint",
    open: settingsOpen,
  },
];

/** Opens the window of the entry `id` (unknown ids do nothing). */
export function openTool(id: string): void {
  const tool = TOOLS.find((entry) => entry.id === id);
  if (tool) tool.open.value = true;
}
