// Test-only Codec 8 oracle. No production imports, offsets, schema or CRC helper.
// Protocol: https://wiki.teltonika-gps.com/view/Codec#Codec_8

function reflect(value: number, bits: number): number {
  let result = 0;
  for (let bit = 0; bit < bits; bit++) {
    result = result * 2 + (value & 1);
    value >>>= 1;
  }
  return result;
}

// MSB-first polynomial division with reflected input/output, unlike the
// production LSB-first implementation. Both use CRC-16/ARC's zero initial value.
export function oracleCrc(bytes: Uint8Array): number {
  let remainder = 0;
  for (const byte of bytes) {
    remainder ^= reflect(byte, 8) << 8;
    for (let bit = 0; bit < 8; bit++)
      remainder =
        ((remainder << 1) ^ (remainder & 0x8000 ? 0x8005 : 0)) & 0xffff;
  }
  return reflect(remainder, 16);
}

function requireFrame(condition: boolean): asserts condition {
  if (!condition) throw new Error("oracle-invalid-frame");
}

// Independently walks the admitted single-record TCP profile. The return shape
// deliberately does not import Record8, so production type/schema drift is visible.
export function decodeSingleRecord(bytes: Uint8Array) {
  requireFrame(bytes.length >= 45 && bytes.length <= 1280);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bodyEnd = bytes.length - 4;
  requireFrame(view.getUint32(0) === 0);
  requireFrame(view.getUint32(4) === bytes.length - 12);
  requireFrame(
    view.getUint32(bodyEnd) === oracleCrc(bytes.subarray(8, bodyEnd)),
  );
  let position = 8;

  function take(length: number): Uint8Array {
    requireFrame(position + length <= bodyEnd);
    const result = bytes.subarray(position, position + length);
    position += length;
    return result;
  }

  function unsigned(length: number): number {
    return take(length).reduce((value, byte) => value * 256 + byte, 0);
  }

  function coordinate(): number {
    const raw = unsigned(4);
    return raw >= 2 ** 31 ? raw - 2 ** 32 : raw;
  }

  requireFrame(unsigned(1) === 8);
  requireFrame(unsigned(1) === 1);
  const timestampMs = take(8)
    .reduce((value, byte) => value * 256n + BigInt(byte), 0n)
    .toString();
  const priority = unsigned(1);
  const longitudeE7 = coordinate();
  const latitudeE7 = coordinate();

  // Preserve the platform's raw u16 contract; signed altitude is unresolved.
  const altitude = unsigned(2);
  const angle = unsigned(2);
  const satellites = unsigned(1);
  const speed = unsigned(2);
  const eventId = unsigned(1);
  const total = unsigned(1);
  requireFrame(
    priority <= 2 &&
      Math.abs(longitudeE7) <= 1800000000 &&
      Math.abs(latitudeE7) <= 900000000 &&
      angle <= 360 &&
      total <= 64,
  );
  const io: { id: number; hex: string }[] = [];
  for (const width of [1, 2, 4, 8]) {
    const count = unsigned(1);
    requireFrame(io.length + count <= total);
    for (let item = 0; item < count; item++) {
      const id = unsigned(1);
      const hex = Array.from(take(width), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      io.push({ id, hex });
    }
  }
  requireFrame(io.length === total);
  requireFrame(unsigned(1) === 1 && position === bodyEnd);
  return {
    schemaVersion: 1 as const,
    timestampMs,
    priority,
    longitudeE7,
    latitudeE7,
    altitude,
    angle,
    satellites,
    speed,
    eventId,
    io,
  };
}
