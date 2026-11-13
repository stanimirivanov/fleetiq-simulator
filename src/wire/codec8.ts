import { Ajv2020, type JSONSchemaType } from "ajv/dist/2020.js";

/**
 * Single-record Codec 8 input; widths and scalar ranges are enforced by recordSchema.
 * Timestamps are exact decimal u64 strings, coordinates are signed degrees × 10⁷,
 * and IO hex retains its 1/2/4/8-byte width. IDs/event are u8; duplicate IDs remain
 * admitted here although the pinned platform decoder rejects them.
 */
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

/**
 * A record failed closed schema or profile validation; messages never include input values.
 */
export class RecordError extends Error {
  constructor() {
    super("invalid-record");
  }
}

/**
 * Closed version-1 Codec 8 schema, bounded to 64 fixed-width IO entries.
 * Encoding also checks the timestamp against u64 before allocating payload bytes.
 */
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

/**
 * Computes CRC-16/ARC with polynomial 0xa001 and zero initial value.
 * Callers supply only the AVL data field; the TCP preamble, length and CRC field
 * are outside checksum coverage. This checksum does not authenticate data.
 */
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

/**
 * Frame admission failed; the fixed category keeps wire bytes out of error output.
 */
export class FrameError extends Error {
  constructor() {
    super("invalid-frame");
  }
}

/**
 * Copies into dedicated backing storage; a caller’s .buffer view cannot reach
 * private bytes through Node’s shared Buffer pool.
 */
function isolatedCopy(bytes: Buffer): Buffer {
  const copy = Buffer.alloc(bytes.length);
  bytes.copy(copy);
  return copy;
}

/**
 * Checks Extended IO shape up to the exclusive repeated-count offset.
 * Bounds every read, requires distinct IDs and exact total/byte consumption, and
 * throws FrameError for malformed or out-of-profile groups; GPS scalars are not decoded.
 */
function validateExtendedIo(bytes: Buffer, end: number): void {
  let offset = 38;
  const ids = new Set<number>();

  /** Reads one big-endian field or fails before touching bytes beyond the IO body. */
  function take16(): number {
    if (offset + 2 > end) throw new FrameError();
    const value = bytes.readUInt16BE(offset);
    offset += 2;
    return value;
  }
  for (const width of [1, 2, 4, 8, 0]) {
    const count = take16();
    if (count > 64) throw new FrameError();
    for (let index = 0; index < count; index++) {
      const id = take16();
      const length = width || take16();
      if (ids.has(id) || length === 0 || length > 256 || offset + length > end)
        throw new FrameError();
      ids.add(id);
      offset += length;
    }
  }
  if (offset !== end || ids.size > 64 || ids.size !== bytes.readUInt16BE(36))
    throw new FrameError();
}

/**
 * Owns detached single-record bytes and their ACK count as one immutable runtime brand.
 * Codec 8 admission checks envelope/count/CRC; Extended admission also checks IO
 * structure. Neither factory is a complete semantic decoder or authenticates a peer.
 * Snapshots are copies, so transport cannot observe subsequent caller mutations.
 */
export class Codec8Frame {
  readonly #bytes: Buffer;
  readonly #recordCount: number;

  /** Copies and admits only the selected codec within the 1280-byte TCP profile. */
  private constructor(input: Buffer, codec = 8) {
    const minimumBytes =
      tcpLayout.payload +
      (codec === 8 ? avlLayout.minimumBytes : 41) +
      tcpLayout.checksumBytes;
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
      bytes[tcpLayout.payload + avlLayout.codec] !== codec ||
      declaredCount !== recordCount ||
      bytes[checksum - 1] !== declaredCount ||
      bytes.readUInt32BE(checksum) !==
        crc16Arc(bytes.subarray(tcpLayout.payload, checksum))
    )
      throw new FrameError();
    if (codec === 0x8e) validateExtendedIo(bytes, checksum - 1);
    this.#bytes = bytes;
    this.#recordCount = declaredCount;
    Object.freeze(this);
  }

  /** Admits a Codec 8 envelope only; rejects Extended and malformed count/CRC fields. */
  static fromBytes(bytes: Buffer): Codec8Frame {
    return new Codec8Frame(bytes);
  }

  /** Admits Codec 8E only, including bounded fixed/NX group structure. */
  static fromExtendedBytes(bytes: Buffer): Codec8Frame {
    return new Codec8Frame(bytes, 0x8e);
  }

  /** Validates and encodes the original Codec 8 record contract into owned bytes. */
  static fromRecord(value: unknown): Codec8Frame {
    return new Codec8Frame(encodeCodec8(value));
  }

  /** Returns the admitted repeated AVL count used to match a four-byte ACK. */
  get recordCount(): number {
    return this.#recordCount;
  }

  /**
   * Returns detached bytes and their private count; raw Buffers first undergo codec admission.
   * Checks private branding directly so forged metadata or virtual overrides cannot
   * change what transport sends or acknowledges. Invalid inputs throw FrameError.
   */
  static snapshot(value: Codec8Frame | Buffer) {
    const frame = Buffer.isBuffer(value)
      ? new Codec8Frame(value, value[8] === 0x8e ? 0x8e : 8)
      : value;
    if (!(frame instanceof Codec8Frame) || !(#bytes in frame))
      throw new FrameError();
    return {
      bytes: isolatedCopy(frame.#bytes),
      recordCount: frame.#recordCount,
    };
  }

  /** Returns a mutable copy whose backing storage cannot reach this frame’s bytes. */
  snapshot() {
    return Codec8Frame.snapshot(this);
  }
}

/**
 * Validates a Codec 8 record and encodes one AVL data field, without a TCP envelope.
 * Derives both counts and groups IO by width, preserving order within each group.
 * Throws RecordError before payload allocation for invalid schema or u64 overflow.
 */
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

/**
 * Wraps one validated Codec 8 payload in a zero-preamble TCP envelope with CRC-16/ARC.
 * Returns fresh bytes; RecordError denotes invalid record input, not a transport failure.
 */
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
