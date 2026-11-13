import { type Stack, startStack } from "./stack.ts";

let stack: Stack | undefined;

/** Starts the stack once; workers read where it listens from the environment. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  stack = await startStack();
  process.env.E2E_BASE_URL = stack.url;
  process.env.E2E_TOKEN = stack.token;
  process.env.E2E_WORKSPACE = stack.workspace;
  process.env.E2E_NOTES_URL = stack.notes.url;
  process.env.E2E_CONTROL = stack.control;
  return async () => {
    await stack?.close();
  };
}
