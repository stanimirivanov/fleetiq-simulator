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

// The admitted FleetIQ profile limits the number of IO entries per record.
const maxIoValues = 64;
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
    maxItems: maxIoValues,
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

// Layout follows Teltonika Codec 8 over TCP:
// https://wiki.teltonika-gps.com/view/Codec#Codec_8
const avlLayout = {
  codec: 0,
  recordCount: 1,
  timestamp: 2,
  priority: 10,
  longitude: 11,
  latitude: 15,
  altitude: 19,
  angle: 21,
  satellites: 23,
  speed: 24,
  eventId: 26,
  ioTotal: 27,
  ioGroups: 28,
  minimumBytes: 33,
};
const tcpLayout = { preamble: 0, length: 4, payload: 8, checksumBytes: 4 };

// This is the admitted FleetIQ profile's byte bound. Each frame in this slice
// declares one record, independently of the transport's batch-count limit.
const maxTcpFrameBytes = 1280;
const recordCount = 1;

export class FrameError extends Error {
  constructor() {
    super("invalid-frame");
  }
}

// Buffer.from can share a pool's backing ArrayBuffer with other copies.
// Dedicated storage prevents a caller's .buffer view from reaching private bytes.
function isolatedCopy(bytes: Buffer): Buffer {
  const copy = Buffer.alloc(bytes.length);
  bytes.copy(copy);
  return copy;
}

export class Codec8Frame {
  readonly #bytes: Buffer;
  readonly #recordCount: number;

  private constructor(input: Buffer) {
    const minimumBytes =
      tcpLayout.payload + avlLayout.minimumBytes + tcpLayout.checksumBytes;
    if (
      !Buffer.isBuffer(input) ||
      input.length < minimumBytes ||
      input.length > maxTcpFrameBytes
    )
      throw new FrameError();

    const bytes = isolatedCopy(input);
    const checksum = bytes.length - tcpLayout.checksumBytes;
    const declaredCount = bytes[tcpLayout.payload + avlLayout.recordCount];
    if (
      bytes.readUInt32BE(tcpLayout.preamble) !== 0 ||
      bytes.readUInt32BE(tcpLayout.length) !== checksum - tcpLayout.payload ||
      bytes[tcpLayout.payload + avlLayout.codec] !== 8 ||
      declaredCount !== recordCount ||
      bytes[checksum - 1] !== declaredCount ||
      bytes.readUInt32BE(checksum) !==
        crc16Arc(bytes.subarray(tcpLayout.payload, checksum))
    )
      throw new FrameError();
    this.#bytes = bytes;
    this.#recordCount = declaredCount;
    Object.freeze(this);
  }

  static fromBytes(bytes: Buffer): Codec8Frame {
    return new Codec8Frame(bytes);
  }
  static fromRecord(value: unknown): Codec8Frame {
    return new Codec8Frame(encodeCodec8(value));
  }
  get recordCount(): number {
    return this.#recordCount;
  }

  // Private fields establish the runtime brand, so forged metadata and virtual
  // snapshot methods cannot alter the bytes and count consumed by transport.
  static snapshot(value: Codec8Frame | Buffer) {
    const frame = Buffer.isBuffer(value) ? new Codec8Frame(value) : value;
    if (!(frame instanceof Codec8Frame) || !(#bytes in frame))
      throw new FrameError();
    return {
      bytes: isolatedCopy(frame.#bytes),
      recordCount: frame.#recordCount,
    };
  }

  snapshot() {
    return Codec8Frame.snapshot(this);
  }
}

export function encodeCodec8Payload(value: unknown): Buffer {
  if (!valid(value)) throw new RecordError();
  const timestamp = BigInt(value.timestampMs);
  if (timestamp > maxTimestamp) throw new RecordError();

  const size = value.io.reduce(
    (bytes, io) => bytes + 1 + io.hex.length / 2,
    avlLayout.minimumBytes,
  );
  const payload = Buffer.alloc(size);
  payload[avlLayout.codec] = 8;
  payload[avlLayout.recordCount] = recordCount;
  payload.writeBigUInt64BE(timestamp, avlLayout.timestamp);
  payload[avlLayout.priority] = value.priority;
  payload.writeInt32BE(value.longitudeE7, avlLayout.longitude);
  payload.writeInt32BE(value.latitudeE7, avlLayout.latitude);
  payload.writeUInt16BE(value.altitude, avlLayout.altitude);
  payload.writeUInt16BE(value.angle, avlLayout.angle);
  payload[avlLayout.satellites] = value.satellites;
  payload.writeUInt16BE(value.speed, avlLayout.speed);
  payload[avlLayout.eventId] = value.eventId;
  payload[avlLayout.ioTotal] = value.io.length;
  let offset = avlLayout.ioGroups;
  for (const width of widths) {
    const group = value.io.filter(({ hex }) => hex.length === width * 2);
    payload[offset++] = group.length;
    for (const { id, hex } of group) {
      payload[offset++] = id;
      offset += payload.write(hex, offset, width, "hex");
    }
  }
  // The protocol repeats the count after the records, inside CRC coverage.
  payload[offset] = recordCount;
  return payload;
}

export function encodeCodec8(value: unknown): Buffer {
  const payload = encodeCodec8Payload(value);
  const frame = Buffer.alloc(
    tcpLayout.payload + payload.length + tcpLayout.checksumBytes,
  );
  frame.writeUInt32BE(payload.length, tcpLayout.length);
  payload.copy(frame, tcpLayout.payload);
  frame.writeUInt32BE(
    crc16Arc(payload),
    frame.length - tcpLayout.checksumBytes,
  );
  return frame;
}
