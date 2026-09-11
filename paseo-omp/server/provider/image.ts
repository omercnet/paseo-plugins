export type OmpImageMimeType = "image/gif" | "image/jpeg" | "image/png" | "image/webp";

const IMAGE_MIME_TYPES: Readonly<Record<string, true>> = {
  "image/gif": true,
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
};

export function isOmpImageMimeType(value: string): value is OmpImageMimeType {
  return IMAGE_MIME_TYPES[value] === true;
}

export function isValidImagePayload(
  data: string,
  mimeType: string,
  maxEncodedLength: number,
): boolean {
  if (
    data.length === 0 ||
    data.length > maxEncodedLength ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(data) ||
    !isOmpImageMimeType(mimeType)
  ) {
    return false;
  }
  const bytes = Buffer.from(data, "base64");
  if (mimeType === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/gif") {
    return (
      bytes.length >= 6 &&
      (bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
        bytes.subarray(0, 6).toString("ascii") === "GIF89a")
    );
  }
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}
