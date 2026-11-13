import { Ajv2020, type JSONSchemaType } from "ajv/dist/2020.js";
import {
  Codec8Frame,
  crc16Arc,
  encodeCodec8,
  encodeCodec8Payload,
  type Record8,
  RecordError,
  recordSchema,
} from "./codec8.ts";

/**
 * Codec 8 Extended input: event/fixed IO IDs widen to u16 and NX stays a separate list.
 * Combined IO is limited to 64 unique IDs; variable hex is 1–256 bytes, even when
 * its length matches a fixed group. Scalar units and exact timestamps match Record8.
 */
export type Record8E = Record8 & { variableIo: { id: number; hex: string }[] };
const u16 = { type: "integer", minimum: 0, maximum: 65535 } as const;

/**
 * Closed Extended schema reusing Codec 8 scalar fields and widening IO identifiers.
 * The encoder additionally enforces combined uniqueness/count and the TCP byte cap.
 */
export const extendedRecordSchema = {
  ...recordSchema,
  properties: {
    ...recordSchema.properties,
    eventId: u16,
    io: {
      ...recordSchema.properties.io,
      items: {
        ...recordSchema.properties.io.items,
        properties: { ...recordSchema.properties.io.items.properties, id: u16 },
      },
    },
    variableIo: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "hex"],
        properties: {
          id: u16,
          hex: {
            type: "string",
            maxLength: 512,
            pattern: "^(?:[0-9a-fA-F]{2}){1,256}(?![\\s\\S])",
          },
        },
      },
    },
  },
  required: [...recordSchema.required, "variableIo"],
} satisfies JSONSchemaType<Record8E>;
const valid = new Ajv2020({ ownProperties: true }).compile<Record8E>(
  extendedRecordSchema,
);

/**
 * Encodes one Codec 8E TCP frame with two-byte IO IDs/counts and separate NX values.
 * Preserves raw fixed widths and within-group order; short NX values never move to
 * a fixed group. Throws RecordError for schema/profile violations before allocating
 * wire buffers, including combined-count, duplicate-ID, u64 and 1280-byte limits.
 */
export function encodeCodec8e(value: unknown): Buffer {
  if (!valid(value)) throw new RecordError();
  const entries = [...value.io, ...value.variableIo];
  const size =
    41 +
    value.io.reduce((n, io) => n + 2 + io.hex.length / 2, 0) +
    value.variableIo.reduce((n, io) => n + 4 + io.hex.length / 2, 0);
  if (
    BigInt(value.timestampMs) > (1n << 64n) - 1n ||
    entries.length > 64 ||
    new Set(entries.map(({ id }) => id)).size !== entries.length ||
    size + 12 > 1280
  )
    throw new RecordError();

  // Reuse only the unchanged timestamp/GPS header, with an empty Codec 8 IO body.
  const { variableIo: _variableIo, ...base } = value;
  const header = encodeCodec8Payload({ ...base, eventId: 0, io: [] });
  const payload = Buffer.alloc(size);
  header.copy(payload, 0, 0, 26);
  payload[0] = 0x8e;
  payload.writeUInt16BE(value.eventId, 26);
  payload.writeUInt16BE(entries.length, 28);
  let offset = 30;
  for (const width of [1, 2, 4, 8]) {
    const group = value.io.filter(({ hex }) => hex.length === width * 2);
    payload.writeUInt16BE(group.length, offset);
    offset += 2;
    for (const { id, hex } of group) {
      payload.writeUInt16BE(id, offset);
      offset += 2;
      offset += payload.write(hex, offset, width, "hex");
    }
  }
  payload.writeUInt16BE(value.variableIo.length, offset);
  offset += 2;
  for (const { id, hex } of value.variableIo) {
    payload.writeUInt16BE(id, offset);
    payload.writeUInt16BE(hex.length / 2, offset + 2);
    offset += 4;
    offset += payload.write(hex, offset, hex.length / 2, "hex");
  }
  payload[offset] = 1;
  const frame = Buffer.alloc(size + 12);
  frame.writeUInt32BE(size, 4);
  payload.copy(frame, 8);
  frame.writeUInt32BE(crc16Arc(payload), size + 8);
  return frame;
}

/**
 * Dispatches CLI record JSON by an own codec selector without mutating the input.
 * Absent or "8" preserves the original closed Codec 8 contract; "8e" requires the
 * Extended contract. Unknown selectors and cross-codec fields throw RecordError.
 */
export function encodeAvlRecord(value: unknown): Buffer {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new RecordError();
  if (!Object.hasOwn(value, "codec")) return encodeCodec8(value);
  const { codec, ...record } = value as { codec: unknown };
  if (codec === "8e") return encodeCodec8e(record);
  if (codec === "8") return encodeCodec8(record);
  throw new RecordError();
}

/** Assembles 1–16 admitted single-record Extended frames, deriving count, length and CRC.
 * Rejects mixed codecs, extra records or TCP frames over 1280 bytes before allocation.
 */
export function combineCodec8e(frames: readonly Codec8Frame[]): Codec8Frame {
  if (frames.length < 1 || frames.length > 16) throw new RecordError();
  const records = frames.map((frame) =>
    Codec8Frame.fromExtendedBytes(Codec8Frame.snapshot(frame).bytes)
      .snapshot()
      .bytes.subarray(10, -5),
  );
  const size = 15 + records.reduce((sum, record) => sum + record.length, 0);
  if (size > 1280) throw new RecordError();
  const bytes = Buffer.alloc(size);
  bytes.writeUInt32BE(size - 12, 4);
  bytes[8] = 0x8e;
  bytes[9] = frames.length;
  let offset = 10;
  for (const record of records) offset += record.copy(bytes, offset);
  bytes[offset] = frames.length;
  bytes.writeUInt32BE(crc16Arc(bytes.subarray(8, -4)), size - 4);
  return Codec8Frame.fromExtendedBatchBytes(bytes);
}
