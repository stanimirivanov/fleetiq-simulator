import { crc16Arc } from "./codec8.ts";

/** Fixed peer-input failure; never includes command text or wire bytes. */
export class CommandError extends Error {
  constructor() {
    super("invalid-command");
  }
}

/**
 * Admits only the complete documented single getinfo request, including type 05,
 * both counts, lengths and zero-extended CRC-16/ARC. No command is executed.
 */
export function decodeGetinfo(bytes: Buffer): "getinfo" {
  if (
    bytes.length !== 27 ||
    bytes.readUInt32BE(0) !== 0 ||
    bytes.readUInt32BE(4) !== 15 ||
    bytes[8] !== 12 ||
    bytes[9] !== 1 ||
    bytes[10] !== 5 ||
    bytes.readUInt32BE(11) !== 7 ||
    bytes.subarray(15, 22).toString("hex") !== "676574696e666f" ||
    bytes[22] !== 1 ||
    bytes.readUInt32BE(23) !== crc16Arc(bytes.subarray(8, -4))
  )
    throw new CommandError();
  return "getinfo";
}

/**
 * Encodes one type 06 response with derived counts, length and CRC. Printable
 * ASCII only, 1–256 bytes; callers must supply synthetic fixture data, not secrets.
 */
export function encodeCommandResponse(text: string): Buffer {
  if (!/^[\x20-\x7e]{1,256}$/u.test(text)) throw new CommandError();
  const bytes = Buffer.alloc(text.length + 20);
  bytes.writeUInt32BE(text.length + 8, 4);
  bytes[8] = 12;
  bytes[9] = 1;
  bytes[10] = 6;
  bytes.writeUInt32BE(text.length, 11);
  bytes.write(text, 15, "ascii");
  bytes[bytes.length - 5] = 1;
  bytes.writeUInt32BE(crc16Arc(bytes.subarray(8, -4)), bytes.length - 4);
  return bytes;
}
