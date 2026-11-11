import { Ajv2020, type JSONSchemaType } from "ajv/dist/2020.js";

export type Record8 = {
  schemaVersion: 1;
  timestampMs: string;
  priority: number;
  longitudeE7: number;
  latitudeE7: number;
  altitude: number;
  angle: number;
  satellites: number;
  speed: number;
  eventId: number;
  io: { id: number; hex: string }[];
};

const widths = [1, 2, 4, 8];
const maxTimestamp = (1n << 64n) - 1n;
const integer = (minimum: number, maximum: number) => ({
  type: "integer" as const,
  minimum,
  maximum,
});
const u8 = integer(0, 255);
const u16 = integer(0, 65535);
const properties = {
  schemaVersion: { type: "integer", const: 1 },
  timestampMs: {
    type: "string",
    maxLength: 20,
    pattern: "^(?:0|[1-9][0-9]*)(?![\\s\\S])",
  },
  priority: integer(0, 2),
  longitudeE7: integer(-1800000000, 1800000000),
  latitudeE7: integer(-900000000, 900000000),
  altitude: u16,
  angle: integer(0, 360),
  satellites: u8,
  speed: u16,
  eventId: u8,
  io: {
    type: "array",
    maxItems: 64,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["id", "hex"],
      properties: {
        id: u8,
        hex: {
          type: "string",
          maxLength: 16,
          pattern:
            "^(?:[0-9a-fA-F]{2}|[0-9a-fA-F]{4}|[0-9a-fA-F]{8}|[0-9a-fA-F]{16})(?![\\s\\S])",
        },
      },
    },
  },
} as const;

export class RecordError extends Error {
  constructor() {
    super("invalid-record");
  }
}

export const recordSchema = {
  type: "object",
  additionalProperties: false,
  properties,
  required: [
    "schemaVersion",
    "timestampMs",
    "priority",
    "longitudeE7",
    "latitudeE7",
    "altitude",
    "angle",
    "satellites",
    "speed",
    "eventId",
    "io",
  ],
} satisfies JSONSchemaType<Record8>;

const valid = new Ajv2020({ ownProperties: true }).compile<Record8>(
  recordSchema,
);

export function crc16Arc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xa001 : 0);
    }
  }
  return crc;
}

export function encodeCodec8(value: unknown): Buffer {
  if (!valid(value)) throw new RecordError();
  const timestamp = BigInt(value.timestampMs);
  if (timestamp > maxTimestamp) throw new RecordError();

  // 12-byte envelope + 3 codec/count bytes + 30 fixed record bytes.
  const size = value.io.reduce(
    (bytes, io) => bytes + 1 + io.hex.length / 2,
    45,
  );
  const frame = Buffer.alloc(size);
  frame.writeUInt32BE(size - 12, 4);
  frame[8] = 8;
  frame[9] = 1;
  frame.writeBigUInt64BE(timestamp, 10);
  frame[18] = value.priority;
  frame.writeInt32BE(value.longitudeE7, 19);
  frame.writeInt32BE(value.latitudeE7, 23);
  frame.writeUInt16BE(value.altitude, 27);
  frame.writeUInt16BE(value.angle, 29);
  frame[31] = value.satellites;
  frame.writeUInt16BE(value.speed, 32);
  frame[34] = value.eventId;
  frame[35] = value.io.length;
  let offset = 36;
  for (const width of widths) {
    const group = value.io.filter(({ hex }) => hex.length === width * 2);
    frame[offset++] = group.length;
    for (const { id, hex } of group) {
      frame[offset++] = id;
      offset += frame.write(hex, offset, width, "hex");
    }
  }
  frame[offset++] = 1;
  frame.writeUInt32BE(crc16Arc(frame.subarray(8, offset)), offset);
  return frame;
}
