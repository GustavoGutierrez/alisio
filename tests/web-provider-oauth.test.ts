/**
 * Web side of provider sign-in (specs/025 phase 3, OA-AC-32, 33, 51, 60, 63): the four flow
 * methods of the API client, the sign-in controller (start, 1 000 ms polling, prompts, cancel,
 * `not_found` after a host restart), the URL policy, the presentational view (walked as a VNode
 * tree: the web tests have no DOM) and the EN/ES strings.
 */
import type {
  CredentialStatus,
  ProviderAuthFlowView,
  ProviderAuthMethodInfo,
  ProviderProfileInfo,
  ProviderTypeInfo,
} from "@alisio/sdk";
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { en } from "../packages/web/src/i18n/en.ts";
import { es } from "../packages/web/src/i18n/es.ts";
import { loadLocale, locale } from "../packages/web/src/i18n/index.ts";
import { ApiClient, ApiRequestError } from "../packages/web/src/net/api.ts";
import {
  createSignInController,
  credentialRows,
  initialSignIn,
  isOpenableUrl,
  openExternal,
  type SignInApi,
  type SignInState,
  signInStatus,
} from "../packages/web/src/store/provider-signin.ts";

type ComponentChildren = unknown;
interface VNode<P = Record<string, unknown>> {
  type: unknown;
  props: P;
}

// The view is JSX (the web package compiles it); it is loaded by path so the root typecheck, which
// has no JSX setting, does not resolve it.
const VIEW_PATH = "../packages/web/src/components/settings/ProviderSignIn.tsx";
let SignInView: (props: Record<string, unknown>) => ComponentChildren;
beforeAll(async () => {
  SignInView = ((await import(/* @vite-ignore */ VIEW_PATH)) as { SignInView: typeof SignInView })
    .SignInView;
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("API client: sign-in flow methods", () => {
  it("starts, polls, answers and cancels a flow on the documented routes", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = new ApiClient({
      fetch: async (url, init) => {
        calls.push({
          url,
          method: String(init.method),
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return json(200, { flowId: "f 1", status: "running", steps: [] });
      },
    });
    await client.startProviderAuth("my profile", "device", "ws1");
    await client.providerAuthFlow("my profile", "f 1", 3);
    await client.providerAuthInput("my profile", "f 1", "p1", "value");
    await client.cancelProviderAuth("my profile", "f 1");
    expect(calls).toEqual([
      {
        url: "/api/providers/my%20profile/auth/device/start",
        method: "POST",
        body: { workspace: "ws1" },
      },
      { url: "/api/providers/my%20profile/auth/flows/f%201?after=3", method: "GET" },
      {
        url: "/api/providers/my%20profile/auth/flows/f%201/input",
        method: "POST",
        body: { promptId: "p1", value: "value" },
      },
      { url: "/api/providers/my%20profile/auth/flows/f%201", method: "DELETE", body: {} },
    ]);
  });
});

const view = (over: Partial<ProviderAuthFlowView> = {}): ProviderAuthFlowView => ({
  status: "running",
  steps: [],
  ...over,
});

type Mocked = { [K in keyof SignInApi]: Mock<SignInApi[K]> };

function fakeApi(over: Partial<Mocked> = {}): Mocked {
  return {
    startProviderAuth: vi.fn<SignInApi["startProviderAuth"]>(async () => ({ flowId: "flow-1" })),
    providerAuthFlow: vi.fn<SignInApi["providerAuthFlow"]>(async () => view()),
    providerAuthInput: vi.fn<SignInApi["providerAuthInput"]>(async () => view()),
    cancelProviderAuth: vi.fn<SignInApi["cancelProviderAuth"]>(async () =>
      view({ status: "cancelled" }),
    ),
    ...over,
  };
}

const official: ProviderAuthMethodInfo = {
  id: "browser",
  label: "Provider account",
  kind: "oauth",
};
const unofficial: ProviderAuthMethodInfo = {
  id: "unofficial-login",
  label: "Shared login",
  kind: "oauth",
  unofficial: true,
};

function harness(api: Mocked) {
  const states: SignInState[] = [];
  const finished: string[] = [];
  const controller = createSignInController({
    api,
    profile: "fake",
    workspace: "ws1",
    onState: (state) => states.push(state),
    onFinished: (status) => finished.push(status),
  });
  return { controller, states, finished, last: () => states[states.length - 1] as SignInState };
}

describe("sign-in controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the flow, polls every 1000 ms with the last step number and stops when it ends", async () => {
    const api = fakeApi();
    api.providerAuthFlow
      .mockResolvedValueOnce(
        view({
          steps: [
            {
              n: 1,
              type: "device_code",
              userCode: "ABCD-1234",
              verificationUri: "https://auth.example.test/device",
              expiresInSeconds: 600,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(view({ steps: [{ n: 2, type: "progress", message: "Waiting" }] }))
      .mockResolvedValue(view({ status: "succeeded", credential: { configured: true } }));
    const { controller, states, finished, last } = harness(api);

    await controller.begin(official);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.startProviderAuth).toHaveBeenCalledWith("fake", "browser", "ws1");
    expect(api.providerAuthFlow).toHaveBeenLastCalledWith("fake", "flow-1", 0);
    expect(last().phase).toBe("running");
    expect(last().steps.map((s) => s.type)).toEqual(["device_code"]);

    await vi.advanceTimersByTimeAsync(999);
    expect(api.providerAuthFlow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.providerAuthFlow).toHaveBeenLastCalledWith("fake", "flow-1", 1);
    expect(last().steps.map((s) => s.n)).toEqual([1, 2]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(api.providerAuthFlow).toHaveBeenCalledTimes(3);
    expect(finished).toEqual(["succeeded"]);
    expect(last().phase).toBe("idle");
    // Polling is over: no more requests after the flow ended.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.providerAuthFlow).toHaveBeenCalledTimes(3);
    expect(states.length).toBeGreaterThan(2);
  });

  it("does not repeat steps the server sends again", async () => {
    const api = fakeApi();
    const step = { n: 1, type: "progress" as const, message: "Working" };
    api.providerAuthFlow.mockResolvedValue(view({ steps: [step] }));
    const { controller, last } = harness(api);
    await controller.begin(official);
    await vi.advanceTimersByTimeAsync(2500);
    expect(last().steps).toHaveLength(1);
    controller.dispose();
  });

  it("shows the pending prompt, sends the answer once and clears it", async () => {
    const api = fakeApi();
    api.providerAuthFlow.mockResolvedValue(
      view({
        status: "awaiting_input",
        prompt: { id: "p1", message: "Paste the code", secret: true },
      }),
    );
    const { controller, last } = harness(api);
    await controller.begin(official);
    await vi.advanceTimersByTimeAsync(0);
    expect(last().prompt).toEqual({ id: "p1", message: "Paste the code", secret: true });

    api.providerAuthFlow.mockResolvedValue(view());
    await controller.submit("the-answer");
    expect(api.providerAuthInput).toHaveBeenCalledWith("fake", "flow-1", "p1", "the-answer");
    expect(last().prompt).toBeUndefined();
    controller.dispose();
  });

  it("stops polling and says the sign-in was interrupted when the flow is not found (OA-AC-60)", async () => {
    const api = fakeApi();
    api.providerAuthFlow
      .mockResolvedValueOnce(view())
      .mockRejectedValue(new ApiRequestError(404, "not_found", "Sign-in flow not found"));
    const { controller, last } = harness(api);
    await controller.begin(official);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(last().phase).toBe("interrupted");
    const polls = api.providerAuthFlow.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.providerAuthFlow).toHaveBeenCalledTimes(polls);

    // "Start again" begins a brand new flow.
    api.providerAuthFlow.mockResolvedValue(view());
    await controller.begin(official);
    expect(api.startProviderAuth).toHaveBeenCalledTimes(2);
    expect(last().phase).toBe("running");
    controller.dispose();
  });

  it("keeps polling through one network blip but gives up after repeated failures", async () => {
    const api = fakeApi();
    api.providerAuthFlow
      .mockRejectedValueOnce(new ApiRequestError(0, "network", "offline"))
      .mockResolvedValue(view());
    const { controller, last } = harness(api);
    await controller.begin(official);
    await vi.advanceTimersByTimeAsync(1000);
    expect(last().phase).toBe("running");
    controller.dispose();

    const broken = fakeApi();
    broken.providerAuthFlow.mockRejectedValue(new ApiRequestError(0, "network", "offline"));
    const second = harness(broken);
    await second.controller.begin(official);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(second.last().phase).toBe("failed");
    expect(second.last().failure?.code).toBe("network");
  });

  it("asks for an explicit confirmation before starting an unofficial method (OA-AC-33)", async () => {
    const api = fakeApi();
    const { controller, last, finished } = harness(api);
    await controller.begin(unofficial);
    expect(last().phase).toBe("confirm");
    expect(last().method).toEqual(unofficial);
    expect(api.startProviderAuth).not.toHaveBeenCalled();

    // Dismissing the notice never starts anything.
    controller.dismiss();
    expect(last().phase).toBe("idle");
    expect(api.startProviderAuth).not.toHaveBeenCalled();

    await controller.begin(unofficial);
    await controller.confirm();
    expect(api.startProviderAuth).toHaveBeenCalledWith("fake", "unofficial-login", "ws1");
    expect(finished).toEqual([]);
    controller.dispose();
  });

  it("confirm without a pending unofficial method starts nothing", async () => {
    const api = fakeApi();
    const { controller } = harness(api);
    await controller.confirm();
    expect(api.startProviderAuth).not.toHaveBeenCalled();
  });

  it("cancels the flow with DELETE, stops polling and refreshes the page", async () => {
    const api = fakeApi();
    const { controller, last, finished } = harness(api);
    await controller.begin(official);
    await vi.advanceTimersByTimeAsync(0);
    await controller.cancel();
    expect(api.cancelProviderAuth).toHaveBeenCalledWith("fake", "flow-1");
    expect(last().phase).toBe("idle");
    expect(finished).toEqual(["cancelled"]);
    const polls = api.providerAuthFlow.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.providerAuthFlow).toHaveBeenCalledTimes(polls);
  });

  it("reloads the profile after any terminal state, because a late cancel may still have saved the session", async () => {
    for (const status of ["failed", "expired", "cancelled"] as const) {
      const api = fakeApi();
      api.providerAuthFlow.mockResolvedValue(
        view({
          status,
          error: { code: status === "failed" ? "auth_failed" : status, message: "x" },
        }),
      );
      const { controller, finished } = harness(api);
      await controller.begin(official);
      await vi.advanceTimersByTimeAsync(0);
      expect(finished).toEqual([status]);
    }
  });

  it("surfaces a failed start without polling", async () => {
    const api = fakeApi({
      startProviderAuth: vi.fn<SignInApi["startProviderAuth"]>(async () => {
        throw new ApiRequestError(409, "validation_failed", "Too many sign-ins");
      }),
    });
    const { controller, last } = harness(api);
    await controller.begin(official);
    expect(last().phase).toBe("failed");
    expect(last().failure).toEqual({ code: "start", message: "Too many sign-ins" });
    expect(api.providerAuthFlow).not.toHaveBeenCalled();
  });

  it("maps a failed flow to its error code and keeps the message as plain data", async () => {
    const api = fakeApi();
    api.providerAuthFlow.mockResolvedValue(
      view({ status: "failed", error: { code: "unsafe_url", message: "bad link" } }),
    );
    const { controller, last } = harness(api);
    await controller.begin(official);
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe("failed");
    expect(last().failure).toEqual({ code: "unsafe_url", message: "bad link" });
  });

  it("a poll that answers after dispose changes nothing", async () => {
    const api = fakeApi();
    let release: (v: ProviderAuthFlowView) => void = () => undefined;
    api.providerAuthFlow.mockImplementation(
      () => new Promise<ProviderAuthFlowView>((resolve) => (release = resolve)),
    );
    const { controller, states } = harness(api);
    void controller.begin(official);
    await vi.advanceTimersByTimeAsync(0);
    const seen = states.length;
    controller.dispose();
    release(view({ status: "succeeded" }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(states.length).toBe(seen);
    expect(api.providerAuthFlow).toHaveBeenCalledTimes(1);
  });
});

describe("URL policy (OA-AC-51)", () => {
  it("accepts https and loopback http only", () => {
    expect(isOpenableUrl("https://auth.example.test/authorize?x=1")).toBe(true);
    expect(isOpenableUrl("http://127.0.0.1:1455/callback")).toBe(true);
    expect(isOpenableUrl("http://localhost:8080/x")).toBe(true);
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>1</script>",
      "http://auth.example.test/x",
      "http://127.0.0.1.evil.test/x",
      "https://user:pass@auth.example.test/x",
      "file:///etc/passwd",
      "//auth.example.test/x",
      "not a url",
      "",
    ])
      expect(isOpenableUrl(bad), bad).toBe(false);
  });

  it("opens with noopener,noreferrer in a new tab and never navigates", () => {
    const open = vi.fn(() => null);
    expect(openExternal("https://auth.example.test/authorize", open)).toBe(true);
    expect(open).toHaveBeenCalledWith(
      "https://auth.example.test/authorize",
      "_blank",
      "noopener,noreferrer",
    );
    expect(openExternal("javascript:alert(1)", open)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("profile card helpers", () => {
  const type = (over: Partial<ProviderTypeInfo> = {}): ProviderTypeInfo => ({
    id: "fake",
    name: "Fake",
    fields: [],
    ...over,
  });
  const profile = (credentials: ProviderProfileInfo["credentials"]): ProviderProfileInfo => ({
    name: "fake",
    provider: "fake",
    model: "m",
    values: {},
    active: false,
    credentials,
  });

  it("shows no credential row for a sign-in-only provider (OA-AC-32)", () => {
    const signInOnly = type({ auth: [official] });
    expect(
      credentialRows(profile({ oauth: { configured: false, kind: "oauth" } }), signInOnly),
    ).toEqual([]);
  });

  it("keeps the key rows of a provider that needs a secret and never shows the sign-in entry as one", () => {
    const keyed = type({
      auth: [official],
      fields: [{ key: "apiKey", label: "API key", kind: "secret", required: true }],
    });
    const rows = credentialRows(
      profile({ apiKey: { configured: false }, oauth: { configured: false, kind: "oauth" } }),
      keyed,
    );
    expect(rows.map(([field]) => field)).toEqual(["apiKey"]);
    // A provider without sign-in is unchanged.
    expect(credentialRows(profile({ apiKey: { configured: true } }), type())).toHaveLength(1);
  });

  it("classifies the stored session", () => {
    const s = (c: CredentialStatus | undefined) => signInStatus(c);
    expect(s(undefined)).toBe("none");
    expect(s({ configured: false, kind: "oauth" })).toBe("none");
    expect(s({ configured: true, kind: "oauth", state: "ok" })).toBe("ok");
    expect(s({ configured: true, kind: "oauth", state: "needs_sign_in" })).toBe("needs_sign_in");
  });
});

/** Every VNode of a tree (function components are called: the view has no hooks). */
function nodes(node: ComponentChildren, out: VNode[] = []): VNode[] {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) nodes(child, out);
    return out;
  }
  const vnode = node as VNode<{ children?: ComponentChildren }>;
  if (typeof vnode.type === "function") {
    nodes((vnode.type as (p: unknown) => ComponentChildren)(vnode.props), out);
    return out;
  }
  out.push(vnode as VNode);
  nodes(vnode.props?.children, out);
  return out;
}
function textOf(node: ComponentChildren): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const vnode = node as VNode<{ children?: ComponentChildren }>;
  if (typeof vnode.type === "function")
    return textOf((vnode.type as (p: unknown) => ComponentChildren)(vnode.props));
  return textOf(vnode.props?.children);
}
const byRole = (tree: ComponentChildren, role: string) =>
  nodes(tree).filter((n) => n.props?.["data-role"] === role);

const noop = () => undefined;
const handlers = (over: Record<string, unknown> = {}) => ({
  onBegin: noop,
  onConfirm: noop,
  onDismiss: noop,
  onCancel: noop,
  onSubmit: noop,
  onOpen: noop,
  onCopy: noop,
  onSignOut: noop,
  ...over,
});
const state = (over: Partial<SignInState> = {}): SignInState => ({ ...initialSignIn, ...over });
const render = (props: {
  methods?: ProviderAuthMethodInfo[];
  status?: CredentialStatus;
  state?: SignInState;
  handlers?: Record<string, unknown>;
}) =>
  SignInView({
    profile: "fake",
    methods: props.methods ?? [official],
    status: props.status,
    state: props.state ?? state(),
    handlers: props.handlers ?? handlers(),
  });

describe("sign-in view", () => {
  afterEach(() => {
    locale.value = "en";
  });

  it("offers one button per method with its label and description, and nothing about a key (OA-AC-32)", () => {
    const tree = render({
      methods: [
        { ...official, description: "Opens your account page" },
        { id: "second", label: "Second way", kind: "oauth" },
      ],
    });
    const buttons = byRole(tree, "method");
    expect(buttons.map((b) => textOf(b))).toEqual(["Provider account", "Second way"]);
    expect(textOf(tree)).toContain("Opens your account page");
    expect(textOf(tree)).toContain("Not signed in");
  });

  it("an expired session says so and offers 'Sign in again' (OA-AC-32)", () => {
    const tree = render({ status: { configured: true, kind: "oauth", state: "needs_sign_in" } });
    expect(textOf(tree)).toContain("Session expired");
    expect(textOf(byRole(tree, "method")[0])).toBe("Sign in again");
    // The expired session is still stored: it can be closed.
    expect(byRole(tree, "signout")).toHaveLength(1);
  });

  it("a signed-in provider offers to sign out", () => {
    const onSignOut = vi.fn();
    const tree = render({
      status: { configured: true, kind: "oauth", state: "ok" },
      handlers: handlers({ onSignOut }),
    });
    expect(textOf(tree)).toContain("Signed in");
    const out = byRole(tree, "signout")[0] as VNode<{ onClick: () => void }>;
    out.props.onClick();
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("marks an unofficial method and requires the explicit confirmation before starting (OA-AC-33)", () => {
    const onBegin = vi.fn();
    const idle = render({ methods: [unofficial], handlers: handlers({ onBegin }) });
    expect(textOf(byRole(idle, "method")[0])).toBe("Shared login (unofficial)");
    (byRole(idle, "method")[0] as VNode<{ onClick: () => void }>).props.onClick();
    expect(onBegin).toHaveBeenCalledWith(unofficial);

    const onConfirm = vi.fn();
    const confirming = render({
      methods: [unofficial],
      state: state({ phase: "confirm", method: unofficial }),
      handlers: handlers({ onConfirm }),
    });
    expect(textOf(byRole(confirming, "risk")[0])).toBe(en["models.signIn.riskNotice"]);
    const accept = byRole(confirming, "confirm")[0] as VNode<{ onClick: () => void }>;
    expect(textOf(accept)).toBe("I understand the risk");
    accept.props.onClick();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // While the notice is open the method buttons are gone: nothing starts without the click.
    expect(byRole(confirming, "method")).toHaveLength(0);
  });

  const running = (over: Partial<SignInState> = {}) =>
    state({
      phase: "running",
      method: official,
      flowId: "f",
      steps: [
        {
          n: 1,
          type: "device_code",
          userCode: "ABCD-1234",
          verificationUri: "https://auth.example.test/device",
          expiresInSeconds: 600,
        },
        { n: 2, type: "progress", message: "Waiting for approval" },
      ],
      ...over,
    });

  it("shows the device code, its address with a copy button, progress and Cancel while the flow runs (OA-AC-32)", () => {
    const onCopy = vi.fn();
    const onCancel = vi.fn();
    const tree = render({ state: running(), handlers: handlers({ onCopy, onCancel }) });
    const text = textOf(tree);
    expect(text).toContain("ABCD-1234");
    expect(text).toContain("https://auth.example.test/device");
    expect(text).toContain("Waiting for approval");
    const copies = byRole(tree, "copy") as Array<VNode<{ onClick: () => void }>>;
    for (const c of copies) c.props.onClick();
    expect(onCopy.mock.calls.map((c) => c[0])).toEqual([
      "ABCD-1234",
      "https://auth.example.test/device",
    ]);
    (byRole(tree, "cancel")[0] as VNode<{ onClick: () => void }>).props.onClick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    // While a flow runs there are no method buttons to start a second one.
    expect(byRole(tree, "method")).toHaveLength(0);
  });

  it("labels the pending prompt with the plugin's message, masks a secret and sends the answer (OA-AC-63)", () => {
    const onSubmit = vi.fn();
    const tree = render({
      state: running({
        prompt: { id: "p1", message: "Paste the redirected address", secret: true },
      }),
      handlers: handlers({ onSubmit }),
    });
    const input = byRole(tree, "prompt-input")[0] as VNode<Record<string, unknown>>;
    expect(input.props.type).toBe("password");
    const label = byRole(tree, "prompt-label")[0] as VNode;
    expect(textOf(label)).toBe("Paste the redirected address");
    expect(textOf(byRole(tree, "prompt-submit")[0])).toBe("Send");
    // The answer is read from the form on submit.
    const form = byRole(tree, "prompt")[0] as VNode<{ onSubmit: (e: unknown) => void }>;
    const reset = vi.fn();
    form.props.onSubmit({
      preventDefault: noop,
      currentTarget: { elements: { namedItem: () => ({ value: "  the answer " }) }, reset },
    });
    expect(onSubmit).toHaveBeenCalledWith("the answer");
    expect(reset).toHaveBeenCalled();

    const plain = render({
      state: running({ prompt: { id: "p2", message: "Name?", secret: false, placeholder: "x" } }),
    });
    expect((byRole(plain, "prompt-input")[0] as VNode<Record<string, unknown>>).props.type).toBe(
      "text",
    );
  });

  it("adds no provider-specific text of its own around a prompt (OA-AC-63)", () => {
    const tree = render({
      state: running({ steps: [], prompt: { id: "p1", message: "PLUGIN-MESSAGE" } }),
    });
    const text = textOf(tree);
    const host = text.replace("PLUGIN-MESSAGE", "").replace(/\s+/g, " ").trim();
    expect(host).not.toMatch(
      /openai|chatgpt|codex|ssh|another (computer|machine)|other (computer|machine)/i,
    );
    for (const locale of [en, es])
      for (const [key, value] of Object.entries(locale))
        if (key.startsWith("models.signIn."))
          expect(value, key).not.toMatch(/openai|chatgpt|codex|\bssh\b/i);
  });

  it("opens an authorization link only through the handler, with a button and never a link element (OA-AC-51)", () => {
    const onOpen = vi.fn();
    const tree = render({
      state: running({
        steps: [
          {
            n: 1,
            type: "auth_url",
            url: "https://auth.example.test/authorize?state=abc",
            instructions: "Open this in your browser.",
          },
        ],
      }),
      handlers: handlers({ onOpen }),
    });
    expect(nodes(tree).filter((n) => n.type === "a")).toHaveLength(0);
    const open = byRole(tree, "open")[0] as VNode<{ onClick: () => void }>;
    open.props.onClick();
    expect(onOpen).toHaveBeenCalledWith("https://auth.example.test/authorize?state=abc");
    expect(textOf(tree)).toContain("Open this in your browser.");
  });

  it("never offers to open, copy or show a link that is not https or loopback, even in a tampered view (OA-AC-51)", () => {
    const tree = render({
      state: running({
        steps: [
          { n: 1, type: "auth_url", url: "javascript:alert(document.cookie)" },
          {
            n: 2,
            type: "device_code",
            userCode: "ZZZZ",
            verificationUri: "javascript:alert(1)",
            verificationUriComplete: "data:text/html,x",
            expiresInSeconds: 60,
          },
        ],
      }),
    });
    expect(byRole(tree, "open")).toHaveLength(0);
    expect(nodes(tree).filter((n) => n.type === "a")).toHaveLength(0);
    expect(textOf(tree)).not.toContain("javascript:");
    expect(textOf(tree)).not.toContain("data:text");
    expect(textOf(tree)).toContain(en["models.signIn.linkBlocked"]);
    // The code itself is still shown: it is not a link.
    expect(textOf(tree)).toContain("ZZZZ");
  });

  it("renders plugin text only as text, never as markup (security condition b)", () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const tree = render({
      methods: [{ id: "m", label: evil, description: evil, kind: "oauth" }],
      state: state(),
    });
    const running2 = render({
      methods: [{ id: "m", label: evil, kind: "oauth" }],
      state: running({
        steps: [{ n: 1, type: "auth_url", url: "https://auth.example.test/a", instructions: evil }],
        prompt: { id: "p", message: evil },
      }),
    });
    for (const t of [tree, running2]) {
      for (const n of nodes(t)) {
        expect(n.props?.dangerouslySetInnerHTML).toBeUndefined();
        expect(["img", "script"]).not.toContain(n.type);
      }
      expect(textOf(t)).toContain(evil);
    }
  });

  it("shows 'Sign-in interrupted, start again' with a restart button, in English and Spanish (OA-AC-60)", async () => {
    const onBegin = vi.fn();
    const interrupted = state({ phase: "interrupted", method: official });
    const tree = render({ state: interrupted, handlers: handlers({ onBegin }) });
    expect(textOf(tree)).toContain("Sign-in interrupted, start again");
    const restart = byRole(tree, "restart")[0] as VNode<{ onClick: () => void }>;
    restart.props.onClick();
    expect(onBegin).toHaveBeenCalledWith(official);
    await loadLocale("es");
    locale.value = "es";
    const spanish = render({ state: interrupted });
    expect(textOf(spanish)).toContain("Inicio de sesión interrumpido, empieza de nuevo");
  });

  it("shows the failure by its code without trusting the message as markup", () => {
    const tree = render({
      state: state({ phase: "failed", method: official, failure: { code: "expired" } }),
    });
    expect(textOf(tree)).toContain(en["models.signIn.expiredFlow"]);
    const failed = render({
      state: state({
        phase: "failed",
        method: official,
        failure: { code: "auth_failed", message: "denied" },
      }),
    });
    expect(textOf(failed)).toContain("denied");
    expect(byRole(failed, "restart")).toHaveLength(1);
  });
});

describe("sign-in strings (OA-AC-33, 63)", () => {
  const signIn = (dict: Record<string, string>) =>
    Object.keys(dict)
      .filter((key) => key.startsWith("models.signIn."))
      .sort();
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it("has the same keys and placeholders in English and Spanish", () => {
    expect(signIn(es)).toEqual(signIn(en));
    expect(signIn(en).length).toBeGreaterThan(10);
    for (const key of signIn(en))
      expect(placeholders((es as Record<string, string>)[key] as string), key).toEqual(
        placeholders((en as Record<string, string>)[key] as string),
      );
  });

  it("carries the fixed generic risk notice and the 'unofficial' tag in both languages", () => {
    expect(en["models.signIn.unofficialTag"]).toBe("unofficial");
    expect(es["models.signIn.unofficialTag"]).toBe("no oficial");
    expect(es["models.signIn.riskConfirm"]).toBe("Entiendo el riesgo");
    expect(en["models.signIn.riskNotice"]).toMatch(/not officially authorized/i);
    expect(es["models.signIn.riskNotice"]).toMatch(/no ha autorizado oficialmente/i);
    expect(es["models.signIn.send"]).toBe("Enviar");
    expect(es["models.signIn.cancel"]).toBe("Cancelar");
  });
});
