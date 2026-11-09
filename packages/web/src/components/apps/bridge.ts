/**
 * The host side of the plugin app message protocol, free of DOM types so it is testable in Node.
 * The frame talks over a transferred `MessagePort`: `request` in, `response`/`locale`/`visibility`
 * out. Errors are codes only (never inputs or secrets); at most 8 requests run per frame.
 */
import { PLUGIN_APP_LIMITS, type PluginAppErrorCode, type PluginAppHostMessage } from "@alisio/sdk";
import { ApiRequestError } from "../../net/api.ts";

export interface PortLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
  start?(): void;
}

export type RunAppAction = (
  action: string,
  input: unknown,
  options: { idempotencyKey?: string; signal: AbortSignal },
) => Promise<unknown>;

export interface AppBridge {
  setLocale(locale: string): void;
  setVisible(visible: boolean): void;
  close(): void;
}

const ACTION = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_ID = 128;

/** Maps a failed request to the code the frame receives. */
export function appErrorCode(error: unknown): PluginAppErrorCode {
  if (!(error instanceof ApiRequestError)) return "failed";
  switch (error.code) {
    case "not_found":
      return "not_found";
    case "validation_failed":
      return "invalid_input";
    case "app_action_denied":
      return "not_permitted";
    case "app_action_timeout":
      return "timeout";
    case "payload_too_large":
    case "app_result_too_large":
      return "too_large";
    case "unauthorized":
      return "unauthorized";
    case "network":
      return "network";
    default:
      return "failed";
  }
}

/** The effect a `not_permitted` answer names (`details.effect` of `app_action_denied`), if any. */
export function appErrorEffect(error: unknown): "write" | "process" | undefined {
  if (!(error instanceof ApiRequestError) || error.code !== "app_action_denied") return undefined;
  const effect = (error.details as { effect?: unknown } | undefined)?.effect;
  return effect === "write" || effect === "process" ? effect : undefined;
}

export function createAppBridge(options: {
  port: PortLike;
  run: RunAppAction;
  /** Called when a request answers `not_found` (the app or its plugin is gone). */
  onNotFound?: () => void;
  maxInFlight?: number;
}): AppBridge {
  const { port } = options;
  const limit = options.maxInFlight ?? PLUGIN_APP_LIMITS.inFlight;
  const inflight = new Set<AbortController>();
  let closed = false;
  const send = (message: PluginAppHostMessage) => {
    if (closed) return;
    try {
      port.postMessage(message);
    } catch {
      /* The port or the payload is unusable: nothing more can be said to the frame. */
    }
  };
  port.onmessage = (event) => {
    const message = event.data as Record<string, unknown> | null;
    if (!message || typeof message !== "object" || message.type !== "request") return;
    const id = message.id;
    if (typeof id !== "string" || !id || id.length > MAX_ID) return;
    if (typeof message.action !== "string" || !ACTION.test(message.action)) {
      send({ type: "response", id, error: "invalid_input" });
      return;
    }
    if (inflight.size >= limit) {
      send({ type: "response", id, error: "too_many_requests" });
      return;
    }
    const controller = new AbortController();
    inflight.add(controller);
    const key = message.idempotencyKey;
    void options
      .run(message.action, message.input ?? {}, {
        signal: controller.signal,
        ...(typeof key === "string" && key && key.length <= 128 ? { idempotencyKey: key } : {}),
      })
      .then(
        (result) => {
          // A result the port cannot clone must not leave the request unanswered.
          if (closed) return;
          try {
            port.postMessage({ type: "response", id, result } satisfies PluginAppHostMessage);
          } catch {
            send({ type: "response", id, error: "failed" });
          }
        },
        (error) => {
          const code = appErrorCode(error);
          if (code === "not_found") options.onNotFound?.();
          const effect = code === "not_permitted" ? appErrorEffect(error) : undefined;
          send({ type: "response", id, error: code, ...(effect ? { effect } : {}) });
        },
      )
      .finally(() => inflight.delete(controller));
  };
  port.start?.();
  return {
    setLocale: (locale) => send({ type: "locale", locale }),
    setVisible: (visible) => send({ type: "visibility", visible }),
    close() {
      closed = true;
      for (const controller of inflight) controller.abort();
      inflight.clear();
      port.onmessage = null;
      port.close();
    },
  };
}
