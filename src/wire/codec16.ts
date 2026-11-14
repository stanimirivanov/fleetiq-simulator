import { Ajv2020, type JSONSchemaType } from "ajv/dist/2020.js";
import {
  crc16Arc,
  encodeCodec8Payload,
  type Record8,
  RecordError,
  recordSchema,
} from "./codec8.ts";

/**
 * Generic encode-only Codec 16 input, with u16 event/IO IDs and generation type.
 * The explicit provisional profile acknowledges conflicting manufacturer count
 * documentation; it makes no device, firmware or installed-platform claim.
 */
export type Record16 = Record8 & {
  profile: "generic-codec16-provisional";
  generationType: number;
};
const u16 = { type: "integer", minimum: 0, maximum: 65535 } as const;
const schema = {
  ...recordSchema,
  required: [...recordSchema.required, "profile", "generationType"],
  properties: {
    ...recordSchema.properties,
    profile: { type: "string", const: "generic-codec16-provisional" },
    generationType: { type: "integer", enum: [0, 1, 2, 4, 5, 6, 7] },
    eventId: u16,
    io: {
      ...recordSchema.properties.io,
      items: {
        ...recordSchema.properties.io.items,
        properties: { ...recordSchema.properties.io.items.properties, id: u16 },
      },
    },
  },
} satisfies JSONSchemaType<Record16>;
let valid: ((value: unknown) => value is Record16) | undefined;

/**
 * Encodes one generic Codec 16 TCP record using the provisional one-byte total.
 * Derives counts, length and CRC; preserves within-width IO order and exact u64
 * timestamps. Rejects reserved generation, duplicate IDs, NX and frames over 255
 * bytes before allocation. Lazy schema compilation leaves other profiles untouched.
 * See contracts/reference-vectors.md for evidence and unresolved authority limits.
 */
export function encodeCodec16(value: unknown): Buffer {
  valid ??= new Ajv2020({ ownProperties: true }).compile<Record16>(schema);
  if (!valid(value)) throw new RecordError();
  const size = 35 + value.io.reduce((n, io) => n + 2 + io.hex.length / 2, 0);
  if (
    BigInt(value.timestampMs) > (1n << 64n) - 1n ||
    new Set(value.io.map(({ id }) => id)).size !== value.io.length ||
    size + 12 > 255
  )
    throw new RecordError();
  const { profile: _profile, generationType, ...base } = value;

  // Only timestamp/GPS bytes are shared; Codec 16 owns its distinct IO layout.
  const header = encodeCodec8Payload({ ...base, eventId: 0, io: [] });
  const payload = Buffer.alloc(size);
  header.copy(payload, 0, 0, 26);
  payload[0] = 0x10;
  payload.writeUInt16BE(value.eventId, 26);
  payload[28] = generationType;
  payload[29] = value.io.length;
  let offset = 30;
  for (const width of [1, 2, 4, 8]) {
    const group = value.io.filter(({ hex }) => hex.length === width * 2);
    payload[offset++] = group.length;
    for (const { id, hex } of group) {
      payload.writeUInt16BE(id, offset);
      offset += 2;
      offset += payload.write(hex, offset, width, "hex");
    }
  }
  payload[offset] = 1;
  const frame = Buffer.alloc(size + 12);
  frame.writeUInt32BE(size, 4);
  payload.copy(frame, 8);
  frame.writeUInt32BE(crc16Arc(payload), size + 8);
  return frame;
}
