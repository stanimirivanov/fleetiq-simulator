// Adapted from Traccar TeltonikaProtocolDecoder (Apache-2.0), fixed revision:
// 5357b171de1fbdcd0e8161b52b107dd406317660, decodeLocation/readExtByte.
// Copyright 2013 - 2026 Anton Tananaev (anton@traccar.org).
// Adaptation: Codec 16 only, raw fields instead of Position/model mappings;
// exact consumption/count checks added. This is not the full Traccar runtime.
// See contracts/reference-vectors.md and contracts/licenses/traccar.txt.

export function reference16(payload: Buffer) {
  let offset = 0;
  function take(length: number): Buffer {
    if (offset + length > payload.length)
      throw new Error("reference-truncated");
    const bytes = payload.subarray(offset, offset + length);
    offset += length;
    return bytes;
  }
  const number = (width: number) => take(width).readUIntBE(0, width);
  if (number(1) !== 0x10) throw new Error("reference-codec");
  const count = number(1);
  const records = [];
  for (let i = 0; i < count; i++) {
    const header = take(24).toString("hex");
    const eventId = number(2);
    const generationType = number(1);
    const total = number(1);
    const io = [];
    for (const width of [1, 2, 4, 8]) {
      const group = number(1);
      for (let j = 0; j < group; j++) {
        const id = number(2);
        io.push({ id, hex: take(width).toString("hex") });
      }
    }
    if (io.length !== total) throw new Error("reference-total");
    records.push({ header, eventId, generationType, io });
  }
  if (number(1) !== count || offset !== payload.length)
    throw new Error("reference-count-or-trailing");
  return records;
}
