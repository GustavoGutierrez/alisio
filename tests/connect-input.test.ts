import { describe, expect, it, vi } from "vitest";
import {
  ConnectInputPrompt,
  printableInput,
  reduceConnectInput,
} from "../packages/cli/src/tui/connect-input.ts";

const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

const prompt = (secret = false) => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  return {
    component: new ConnectInputPrompt({
      provider: "Example provider",
      label: secret ? "API key" : "Base URL",
      initial: "",
      secret,
      placeholder: secret ? "Paste API key" : "https://api.example.test/v1",
      hint: secret ? "Input is masked" : "Paste the complete URL",
      step: secret ? 2 : 1,
      steps: 2,
      onSubmit,
      onCancel,
    }),
    onSubmit,
    onCancel,
  };
};

describe("connect input", () => {
  it("accepts complete plain and bracketed-paste chunks", () => {
    expect(printableInput("\x1b[200~https://api.example.test/v1\x1b[201~")).toBe(
      "https://api.example.test/v1",
    );
    let state = reduceConnectInput({ value: "", cursor: 0 }, { type: "insert", text: "https://" });
    state = reduceConnectInput(state, { type: "insert", text: "api.example.test/v1" });
    expect(state).toEqual({ value: "https://api.example.test/v1", cursor: 27 });

    const onSubmit = vi.fn();
    const withDefault = new ConnectInputPrompt({
      provider: "Example provider",
      label: "Base URL",
      initial: "https://default.example.test/v1",
      secret: false,
      placeholder: "https://api.example.test/v1",
      step: 1,
      steps: 2,
      onSubmit,
      onCancel: vi.fn(),
    });
    withDefault.handleInput("\x1b[200~https://pasted.example.test/v1\x1b[201~");
    withDefault.handleInput("\r");
    expect(onSubmit).toHaveBeenCalledWith("https://pasted.example.test/v1");
  });

  it("supports cursor navigation and deletion within a URL", () => {
    let state = { value: "https://example.test/v1", cursor: 23 };
    state = reduceConnectInput(state, { type: "left" });
    state = reduceConnectInput(state, { type: "insert", text: "x" });
    state = reduceConnectInput(state, { type: "backspace" });
    state = reduceConnectInput(state, { type: "delete" });
    state = reduceConnectInput(state, { type: "insert", text: "1" });
    state = reduceConnectInput(state, { type: "home" });
    state = reduceConnectInput(state, { type: "right" });
    state = reduceConnectInput(state, { type: "backspace" });
    expect(state.value).toBe("ttps://example.test/v1");
    expect(state.cursor).toBe(0);
  });

  it("renders a focused field and caret with explicit submit/cancel instructions", () => {
    const { component } = prompt();
    const rendered = stripAnsi(component.render(80).join("\n"));
    expect(rendered).toContain("Connect · Example provider (1/2)");
    expect(rendered).toContain("❯ Base URL");
    expect(rendered).toContain("https://api.example.test/v1 ▏");
    expect(rendered).toContain("Enter submit · Esc cancel");
  });

  it("masks pasted secrets, allows deletion, and never renders the value", () => {
    const { component, onSubmit } = prompt(true);
    component.handleInput("\x1b[200~fake-test-token-123\x1b[201~");
    component.handleInput("\x1b[D");
    component.handleInput("\x7f");
    const rendered = stripAnsi(component.render(80).join("\n"));
    expect(rendered).not.toContain("fake-test-token-123");
    expect(rendered).toContain("••••");
    component.handleInput("\r");
    expect(onSubmit).toHaveBeenCalledWith("fake-test-token-13");
  });

  it("submits with Enter and cancels with Escape", () => {
    const submitted = prompt();
    submitted.component.handleInput("https://example.test/v1");
    submitted.component.handleInput("\r");
    expect(submitted.onSubmit).toHaveBeenCalledWith("https://example.test/v1");
    const cancelled = prompt();
    cancelled.component.handleInput("\x1b");
    expect(cancelled.onCancel).toHaveBeenCalledOnce();
  });
});
