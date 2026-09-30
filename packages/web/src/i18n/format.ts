/** Replaces `{name}` placeholders; unknown ones stay visible so missing params are obvious. */
export const format = (text: string, params: Record<string, string | number> = {}): string =>
  text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    params[name] !== undefined ? String(params[name]) : whole,
  );
