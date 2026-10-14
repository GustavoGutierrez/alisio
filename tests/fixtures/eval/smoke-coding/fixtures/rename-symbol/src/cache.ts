import type { User } from "./api.ts";
import { fetchUser } from "./api.ts";

export type Loader = typeof fetchUser;

const cache = new Map<number, User | undefined>();

export function fetchUserCached(id: number, load: Loader = fetchUser): User | undefined {
  if (!cache.has(id)) cache.set(id, load(id));
  return cache.get(id);
}

export const fetchUserCacheSize = (): number => cache.size;
