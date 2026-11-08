/**
 * Web Settings: the model field of sign-in providers (hidden until signed in, the provider's
 * default model fills the profile, a dropdown after sign-in, a text input only as a fallback) and
 * the maximize toggle of the Settings dialog (state, persistence, accessible button).
 */
import type { CredentialStatus, ModelInfo } from "@alisio/sdk";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MAXIMIZED_PREF,
  readMaximized,
  toggleMaximized,
} from "../packages/web/src/components/settings/dialog-size.ts";
import {
  activationModelField,
  formModelField,
  pickModel,
} from "../packages/web/src/components/settings/model-field.ts";
import { en } from "../packages/web/src/i18n/en.ts";
import { es } from "../packages/web/src/i18n/es.ts";

const signedIn: CredentialStatus = { configured: true, kind: "oauth", state: "ok" };
const expired: CredentialStatus = { configured: true, kind: "oauth", state: "needs_sign_in" };
const notSignedIn: CredentialStatus = { configured: false, kind: "oauth" };
const list = (...ids: string[]): ModelInfo[] => ids.map((id) => ({ id }));

describe("profile form: model field", () => {
  it("keeps the required text input for providers without sign-in", () => {
    expect(formModelField({ signIn: false, model: "", defaultModel: "ignored" })).toEqual({
      show: true,
      value: "",
    });
    expect(formModelField({ signIn: false, model: "gpt-x" })).toEqual({
      show: true,
      value: "gpt-x",
    });
  });

  it("hides the field for sign-in providers and saves the provider's default model", () => {
    expect(formModelField({ signIn: true, model: "", defaultModel: "model-a" })).toEqual({
      show: false,
      value: "model-a",
    });
  });

  it("keeps the model a saved sign-in profile already has", () => {
    expect(formModelField({ signIn: true, model: "model-b", defaultModel: "model-a" })).toEqual({
      show: false,
      value: "model-b",
    });
  });

  it("falls back to the input when a sign-in provider has no default model (the save needs one)", () => {
    expect(formModelField({ signIn: true, model: "  " })).toEqual({ show: true, value: "" });
  });
});

describe("profile card: model selector", () => {
  it("is not offered for a sign-in provider until the user is signed in", () => {
    expect(activationModelField({ signIn: true, status: undefined, models: [] })).toBe("hidden");
    expect(activationModelField({ signIn: true, status: notSignedIn, models: [] })).toBe("hidden");
    expect(activationModelField({ signIn: true, status: expired, models: list("a") })).toBe(
      "hidden",
    );
  });

  it("is a dropdown once signed in and the account lists models", () => {
    expect(activationModelField({ signIn: true, status: signedIn, models: list("a", "b") })).toBe(
      "select",
    );
  });

  it("is a text input only when signed in but the provider did not list its models", () => {
    expect(activationModelField({ signIn: true, status: signedIn, models: [] })).toBe("input");
  });

  it("is unchanged for API key providers", () => {
    expect(activationModelField({ signIn: false, status: undefined, models: [] })).toBe("input");
    expect(activationModelField({ signIn: false, status: undefined, models: list("a") })).toBe(
      "select",
    );
  });
});

describe("pickModel", () => {
  it("keeps a non-empty current value", () => {
    expect(pickModel({ current: "b", defaultModel: "a", models: list("a", "b") })).toBe("b");
  });

  it("preselects the default model when the current value is empty and the list has it", () => {
    expect(pickModel({ current: " ", defaultModel: "a", models: list("b", "a") })).toBe("a");
  });

  it("uses the default model even without a list, and never invents one", () => {
    expect(pickModel({ current: "", defaultModel: "a", models: [] })).toBe("a");
    expect(pickModel({ current: "", models: list("b") })).toBe("");
  });
});

describe("settings dialog: maximize", () => {
  afterEach(() => vi.unstubAllGlobals());

  const storage = () => {
    const map = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    });
    return map;
  };

  it("starts restored and toggles, persisting each choice", () => {
    const map = storage();
    expect(readMaximized()).toBe(false);
    expect(toggleMaximized(false)).toBe(true);
    expect(map.get(MAXIMIZED_PREF)).toBe("1");
    expect(readMaximized()).toBe(true);
    expect(toggleMaximized(true)).toBe(false);
    expect(map.has(MAXIMIZED_PREF)).toBe(false);
    expect(readMaximized()).toBe(false);
  });

  it("works without storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readMaximized()).toBe(false);
    expect(toggleMaximized(false)).toBe(true);
  });
});

interface VNode {
  type: unknown;
  props: Record<string, unknown>;
}
let MaximizeToggle: (props: { maximized: boolean; onToggle: () => void }) => VNode;
beforeAll(async () => {
  const path = "../packages/web/src/components/settings/MaximizeToggle.tsx";
  MaximizeToggle = (
    (await import(/* @vite-ignore */ path)) as { MaximizeToggle: typeof MaximizeToggle }
  ).MaximizeToggle;
});

describe("MaximizeToggle", () => {
  it("is a pressed-state button whose label follows the state", () => {
    const toggle = vi.fn();
    const restored = MaximizeToggle({ maximized: false, onToggle: toggle });
    expect(restored.type).toBe("button");
    expect(restored.props.type).toBe("button");
    expect(restored.props["aria-pressed"]).toBe(false);
    expect(restored.props["aria-label"]).toBe(en["settings.maximize"]);
    (restored.props.onClick as () => void)();
    expect(toggle).toHaveBeenCalledTimes(1);
    const maximized = MaximizeToggle({ maximized: true, onToggle: toggle });
    expect(maximized.props["aria-pressed"]).toBe(true);
    expect(maximized.props["aria-label"]).toBe(en["settings.restore"]);
  });
});

describe("strings", () => {
  it.each(["models.form.signInHint", "settings.maximize", "settings.restore"] as const)(
    "%s exists in EN and ES",
    (key) => {
      expect(en[key]).toBeTruthy();
      expect(es[key]).toBeTruthy();
      expect(es[key]).not.toBe(en[key]);
    },
  );
});
