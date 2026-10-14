import { fetchUser } from "./api.ts";

export const METRIC = "fetchUser.calls";
export const counters: Record<string, number> = {};

export function greet(id: number): string {
  counters[METRIC] = (counters[METRIC] ?? 0) + 1;
  const user = fetchUser(id);
  return user ? `Hello, ${user.name}` : "Hello, stranger";
}
