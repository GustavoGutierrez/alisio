import { fetchUser as lookup } from "./api.ts";

export function describe(id: number): string {
  const user = lookup(id);
  return user ? `${user.id}:${user.name}` : "unknown";
}
