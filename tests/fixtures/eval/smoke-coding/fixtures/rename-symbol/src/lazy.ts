export async function lazyName(id: number): Promise<string> {
  const { fetchUser } = await import("./api.ts");
  return fetchUser(id)?.name ?? "unknown";
}

export async function lazyId(id: number): Promise<number> {
  const api = await import("./api.ts");
  return api["fetchUser"](id)?.id ?? -1;
}
