/** A client of the old remote service. It has nothing to do with the local user table. */
export class LegacyClient {
  fetchUser(id: number): string {
    return `legacy:${id}`;
  }
}

export function legacyDescribe(id: number): string {
  return new LegacyClient().fetchUser(id);
}
