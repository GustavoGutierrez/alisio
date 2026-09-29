import { beforeAll, describe, expect, it, vi } from "vitest";
import { type PluginCatalogView, pluginCatalogItems } from "../packages/cli/src/tui/state.ts";

// NO_COLOR makes the whole render plain, so label assertions never depend on the terminal
// color state and the "no ANSI under NO_COLOR" guarantee is exercised directly.
let Picker: typeof import("../packages/cli/src/tui/app.ts").Picker;

const view = (id: string, name: string, category: string, extra: Partial<PluginCatalogView> = {}) =>
  ({
    id,
    name,
    description: `${name} plugin`,
    categories: category ? [category] : [],
    builtin: true,
    source: "built-in",
    status: "active",
    enabled: true,
    manageable: true,
    ...extra,
  }) as PluginCatalogView;

// Display sequence: model-provider › / DeepSeek / OpenAI / memory › / Memory / subagents › / Harness
const catalog = () =>
  pluginCatalogItems([
    view("deepseek", "DeepSeek", "model-provider"),
    view("openai", "OpenAI compatible", "model-provider"),
    view("memory", "Memory", "memory"),
    view("methodology-harness", "Harness", "subagents"),
  ]);

const up = "\x1b[A";
const down = "\x1b[B";
const enter = "\r";
const esc = "\x1b";
const backspace = "\x7f";

describe("Picker with grouped plugin items", () => {
  beforeAll(async () => {
    process.env.NO_COLOR = "1";
    ({ Picker } = await import("../packages/cli/src/tui/app.ts"));
  });

  it("opens with the first real row selected and renders headers above their groups", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const picker = new Picker("Plugins", catalog(), onSelect, onCancel, true);
    expect(picker.getSelectedItem()?.value).toBe("deepseek");
    const lines = picker.render(100);
    const text = lines.join("\n");
    // Our own styling stays plain under NO_COLOR: the header line carries no ANSI.
    expect(lines).toContain("  model-provider ›");
    // Header rows render before their groups; rows are indented under them.
    expect(text).toContain("model-provider ›");
    expect(text).toContain("  [x] DeepSeek");
    expect(lines.findIndex((l) => l.includes("model-provider ›"))).toBeLessThan(
      lines.findIndex((l) => l.includes("  [x] DeepSeek")),
    );
    // Exactly one row is selected (the `→ ` prefix) and it is never a header.
    const selected = lines.filter((l) => l.startsWith("→ "));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain("DeepSeek");
    expect(selected[0]).not.toContain("›");
  });

  it("skips headers when navigating and wraps in both directions", () => {
    const picker = new Picker("Plugins", catalog(), vi.fn(), vi.fn(), true);
    expect(picker.getSelectedItem()?.value).toBe("deepseek");
    picker.handleInput(down);
    expect(picker.getSelectedItem()?.value).toBe("openai");
    picker.handleInput(down);
    expect(picker.getSelectedItem()?.value).toBe("memory"); // jumped the memory › header
    picker.handleInput(down);
    expect(picker.getSelectedItem()?.value).toBe("methodology-harness"); // jumped subagents ›
    picker.handleInput(down);
    expect(picker.getSelectedItem()?.value).toBe("deepseek"); // wrapped past the headers
    picker.handleInput(up);
    expect(picker.getSelectedItem()?.value).toBe("methodology-harness"); // wrapped up
    picker.handleInput(up);
    expect(picker.getSelectedItem()?.value).toBe("memory");
    picker.handleInput(up);
    expect(picker.getSelectedItem()?.value).toBe("openai");
    picker.handleInput(up);
    expect(picker.getSelectedItem()?.value).toBe("deepseek");
  });

  it("never lands on a header across long navigation runs and never emits one", () => {
    const onSelect = vi.fn();
    const picker = new Picker("Plugins", catalog(), onSelect, vi.fn(), true);
    for (let i = 0; i < 40; i++) {
      picker.handleInput(down);
      expect(picker.getSelectedItem()?.value).not.toMatch(/^__group:/);
    }
    for (let i = 0; i < 40; i++) {
      picker.handleInput(up);
      expect(picker.getSelectedItem()?.value).not.toMatch(/^__group:/);
    }
    picker.handleInput(enter);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]?.value).toBe("deepseek");
    expect(onSelect.mock.calls[0]?.[0]?.value).not.toMatch(/^__group:/);
  });

  it("enters the row under the selection only, never a header", () => {
    const onSelect = vi.fn();
    const picker = new Picker("Plugins", catalog(), onSelect, vi.fn(), true);
    picker.handleInput(down); // openai
    picker.handleInput(down); // memory
    picker.handleInput(enter);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ value: "memory" }));
  });

  it("escape cancels without selecting", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const picker = new Picker("Plugins", catalog(), onSelect, onCancel, true);
    picker.handleInput(esc);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("filtering keeps only headers of groups with visible rows and stays navigable", () => {
    const onSelect = vi.fn();
    const picker = new Picker("Plugins", catalog(), onSelect, vi.fn(), true);
    picker.handleInput("m");
    picker.handleInput("e");
    picker.handleInput("m");
    const text = picker.render(100).join("\n");
    expect(text).toContain("memory ›");
    expect(text).toContain("  [x] Memory");
    expect(text).not.toContain("model-provider ›");
    expect(text).not.toContain("subagents ›");
    expect(text).not.toContain("DeepSeek");
    expect(picker.getSelectedItem()?.value).toBe("memory"); // reset onto the first visible row
    picker.handleInput(down);
    expect(picker.getSelectedItem()?.value).toBe("memory"); // single-row list wraps on itself
    picker.handleInput(enter);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ value: "memory" }));
  });

  it("restores every header when the filter clears and drops everything on no match", () => {
    const picker = new Picker("Plugins", catalog(), vi.fn(), vi.fn(), true);
    picker.handleInput("m");
    picker.handleInput("e");
    picker.handleInput("m");
    picker.handleInput(backspace);
    picker.handleInput(backspace);
    picker.handleInput(backspace);
    const restored = picker.render(100).join("\n");
    expect(restored).toContain("model-provider ›");
    expect(restored).toContain("memory ›");
    picker.handleInput(down); // openai
    picker.handleInput(down); // memory
    const scrolled = picker.render(100).join("\n");
    expect(scrolled).toContain("subagents ›"); // visible once the selection scrolls near it
    expect(picker.getSelectedItem()?.value).toBe("memory");
    picker.handleInput("z");
    const none = picker.render(100).join("\n");
    expect(none).toContain("No matching commands");
    expect(none).not.toContain("›");
    expect(picker.getSelectedItem()).toBeNull();
  });

  it("an empty catalog renders without headers and cancels cleanly", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const picker = new Picker("Plugins", [], onSelect, onCancel, true);
    expect(picker.getSelectedItem()).toBeNull();
    picker.handleInput(enter);
    expect(onSelect).not.toHaveBeenCalled();
    picker.handleInput(esc);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("a plain (header-free) picker behaves exactly like before", () => {
    const items = [
      { value: "once", label: "Allow once" },
      { value: "session", label: "Always allow" },
      { value: "deny", label: "Deny" },
    ];
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const picker = new Picker("Allow", items, onSelect, onCancel); // not filterable
    expect(picker.getSelectedItem()?.value).toBe("once");
    picker.handleInput(up);
    expect(picker.getSelectedItem()?.value).toBe("deny"); // wrap on an unfiltered list
    picker.handleInput(enter);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ value: "deny" }));
    picker.handleInput("x"); // stray typing is ignored when not filterable
    expect(picker.getSelectedItem()?.value).toBe("deny");
    picker.handleInput(esc);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
