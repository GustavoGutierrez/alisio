import { INIT_TEMPLATE } from "./init.ts";

/** Prompt templates shipped with the CLI (lowest precedence; users and projects can override). */
export const BUILTIN_PROMPTS = [{ name: "init", text: INIT_TEMPLATE }];
