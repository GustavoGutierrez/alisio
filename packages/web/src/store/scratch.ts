/**
 * The Scratch tab of the dock (Forja spec §11.2): the open session's scratchpad listing, the file
 * on view and the "Empty" action with its outcomes. Read only apart from emptying; there is no
 * way to edit a file here. The module is its own chunk (the tab loads it on first use).
 */
import type { ScratchListing } from "@alisio/sdk";
import { signal } from "@preact/signals";
import { ApiRequestError } from "../net/api.ts";
import { api } from "./app.ts";

export type ScratchNotice =
  | { kind: "cleared"; removed: number; freedBytes: number }
  | { kind: "runsActive" }
  | { kind: "readOnly" }
  | { kind: "failed"; message: string };

export interface ScratchState {
  sessionId: string;
  status: "idle" | "loading" | "ready" | "error";
  listing?: ScratchListing;
  error?: string;
  /** The file on view (a name from the listing). */
  selected?: string;
  clearing: boolean;
  notice?: ScratchNotice;
}

const idle = (): ScratchState => ({ sessionId: "", status: "idle", clearing: false });
export const scratchState = signal<ScratchState>(idle());

export const resetScratch = (): void => {
  scratchState.value = idle();
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Loads (or reloads) the listing of a session; an answer for a session left meanwhile is dropped. */
export async function loadScratch(sessionId: string): Promise<void> {
  const sameSession = scratchState.value.sessionId === sessionId;
  scratchState.value = {
    ...(sameSession ? scratchState.value : idle()),
    sessionId,
    status: "loading",
  };
  try {
    const listing = await api.scratch(sessionId);
    if (scratchState.value.sessionId !== sessionId) return;
    const { selected } = scratchState.value;
    const { selected: _dropped, error: _error, ...rest } = scratchState.value;
    scratchState.value = {
      ...rest,
      status: "ready",
      listing,
      ...(selected && listing.files.some((file) => file.name === selected) ? { selected } : {}),
    };
  } catch (error) {
    if (scratchState.value.sessionId !== sessionId) return;
    const { listing: _listing, selected: _selected, ...rest } = scratchState.value;
    scratchState.value = { ...rest, status: "error", error: messageOf(error) };
  }
}

/** Shows a file of the listing (names the listing does not have are ignored). */
export function selectScratchFile(name: string | undefined): void {
  const state = scratchState.value;
  if (name !== undefined && !state.listing?.files.some((file) => file.name === name)) return;
  const { selected: _selected, ...rest } = state;
  scratchState.value = name === undefined ? rest : { ...rest, selected: name };
}

/** Empties the scratchpad; the listing only changes when the server did it. */
export async function clearScratch(sessionId: string): Promise<void> {
  if (scratchState.value.sessionId !== sessionId) return;
  const { notice: _notice, ...before } = scratchState.value;
  scratchState.value = { ...before, clearing: true };
  try {
    const result = await api.clearScratch(sessionId);
    if (scratchState.value.sessionId !== sessionId) return;
    const { selected: _selected, ...rest } = scratchState.value;
    scratchState.value = {
      ...rest,
      clearing: false,
      ...(rest.listing ? { listing: { ...rest.listing, files: [], usedBytes: 0 } } : {}),
      notice: { kind: "cleared", removed: result.removed, freedBytes: result.freedBytes },
    };
  } catch (error) {
    if (scratchState.value.sessionId !== sessionId) return;
    const notice: ScratchNotice =
      error instanceof ApiRequestError && error.code === "runs_active"
        ? { kind: "runsActive" }
        : error instanceof ApiRequestError && error.status === 403
          ? { kind: "readOnly" }
          : { kind: "failed", message: messageOf(error) };
    scratchState.value = { ...scratchState.value, clearing: false, notice };
  }
}
