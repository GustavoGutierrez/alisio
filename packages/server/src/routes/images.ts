/**
 * Image detection by magic bytes (never by name or declared type) for uploads and file previews:
 * PNG, JPEG, GIF and WebP, the formats the TUI and providers accept (spec §11.1). Dimensions are
 * read from the header when present; they are advisory metadata, not validation.
 */
export interface SniffedImage {
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width?: number;
  height?: number;
}

const ascii = (bytes: Uint8Array, at: number, text: string) =>
  bytes.length >= at + text.length &&
  [...text].every((ch, i) => bytes[at + i] === ch.charCodeAt(0));

const dims = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : {});

function jpegSize(b: Uint8Array): { width?: number; height?: number } {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return {};
    const marker = b[i + 1] as number;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = ((b[i + 2] as number) << 8) | (b[i + 3] as number);
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return dims(
        ((b[i + 7] as number) << 8) | (b[i + 8] as number),
        ((b[i + 5] as number) << 8) | (b[i + 6] as number),
      );
    if (length < 2) return {};
    i += 2 + length;
  }
  return {};
}

function webpSize(b: Uint8Array): { width?: number; height?: number } {
  const u24 = (at: number) =>
    (b[at] as number) | ((b[at + 1] as number) << 8) | ((b[at + 2] as number) << 16);
  if (ascii(b, 12, "VP8X") && b.length >= 30) return dims(u24(24) + 1, u24(27) + 1);
  if (ascii(b, 12, "VP8 ") && b.length >= 30)
    return dims(
      ((b[26] as number) | ((b[27] as number) << 8)) & 0x3fff,
      ((b[28] as number) | ((b[29] as number) << 8)) & 0x3fff,
    );
  if (ascii(b, 12, "VP8L") && b.length >= 25) {
    const bits =
      (b[21] as number) |
      ((b[22] as number) << 8) |
      ((b[23] as number) << 16) |
      ((b[24] as number) << 24);
    return dims((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return {};
}

/** The image type (and size when readable) of `bytes`, or undefined when it is not one. */
export function sniffImage(bytes: Uint8Array): SniffedImage | undefined {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, "PNG\r\n\x1a\n")) {
    const size =
      b.length >= 24 && ascii(b, 12, "IHDR")
        ? dims(
            Buffer.from(b.subarray(16, 20)).readUInt32BE(0),
            Buffer.from(b.subarray(20, 24)).readUInt32BE(0),
          )
        : {};
    return { mimeType: "image/png", ...size };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { mimeType: "image/jpeg", ...jpegSize(b) };
  if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"))
    return {
      mimeType: "image/gif",
      ...(b.length >= 10
        ? dims(
            (b[6] as number) | ((b[7] as number) << 8),
            (b[8] as number) | ((b[9] as number) << 8),
          )
        : {}),
    };
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return { mimeType: "image/webp", ...webpSize(b) };
  return undefined;
}
