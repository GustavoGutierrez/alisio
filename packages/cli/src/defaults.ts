/**
 * Built-in plugins and prompt templates, and the slash names templates may not take. Shared by the
 * `alisio` binary and by hosts that embed the app (the desktop wrapper imports it through the
 * `@alisio/alisio-code/defaults` export, which has no commander side effects).
 */
export async function cliDefaults() {
  const [{ BUILTIN_PLUGINS }, { BUILTIN_PROMPTS }, { reservedCommandNames }] = await Promise.all([
    import("./builtin.ts"),
    import("./prompts/index.ts"),
    import("./tui/state.ts"),
  ]);
  return {
    builtins: BUILTIN_PLUGINS,
    builtinPrompts: BUILTIN_PROMPTS,
    reservedPromptNames: reservedCommandNames(),
  };
}
