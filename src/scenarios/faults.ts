import { Ajv2020 } from "ajv/dist/2020.js";
import { Codec8Frame, crc16Arc, FrameError } from "../wire/codec8.ts";

/** Fault admission never retains input, identities or peer data in diagnostics. */
export class FaultError extends Error {
  readonly category = "invalid-faults";

  /** Uses one fixed category for malformed or unauthorized fault plans. */
  constructor() {
    super("invalid-faults");
  }
}

/** One action per one-based original packet ordinal; duplicates do not renumber subsequent actions. */
type Action = { packet: number } & (
  | {
      kind:
        | "corrupt-crc"
        | "duplicate-record"
        | "unregistered-identity"
        | "disconnect-before-write"
        | "disconnect-after-write";
    }
  | { kind: "truncate-close" | "split-write"; offset: number }
  | { kind: "late-event-time"; timestampMs: string }
);

/** Closed local-only opt-in. No ambient time, randomness, identities or endpoints are inferred. */
export const faultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "authorizedLocalTarget", "actions"],
  properties: {
    schemaVersion: { const: 1 },
    authorizedLocalTarget: { const: true },
    actions: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: {
        oneOf: [
          ...[
            "corrupt-crc",
            "duplicate-record",
            "unregistered-identity",
            "disconnect-before-write",
            "disconnect-after-write",
          ].map((kind) => ({
            type: "object",
            additionalProperties: false,
            required: ["packet", "kind"],
            properties: {
              packet: { type: "integer", minimum: 1, maximum: 16 },
              kind: { const: kind },
            },
          })),
          ...["truncate-close", "split-write"].map((kind) => ({
            type: "object",
            additionalProperties: false,
            required: ["packet", "kind", "offset"],
            properties: {
              packet: { type: "integer", minimum: 1, maximum: 16 },
              kind: { const: kind },
              offset: { type: "integer", minimum: 1, maximum: 1279 },
            },
          })),
          {
            type: "object",
            additionalProperties: false,
            required: ["packet", "kind", "timestampMs"],
            properties: {
              packet: { type: "integer", minimum: 1, maximum: 16 },
              kind: { const: "late-event-time" },
              timestampMs: {
                type: "string",
                pattern: "^(0|[1-9][0-9]{0,19})(?![\\s\\S])",
              },
            },
          },
        ],
      },
    },
  },
};
const valid = new Ajv2020({ ownProperties: true }).compile<{
  actions: Action[];
}>(faultSchema);

/** Private frozen transport work; deny requires no successful AVL ACK, not proof of server validation. */
export type FaultPacket = {
  ordinal: number;
  bytes: Buffer;
  recordCount: number;
  identity: string;
  deny: boolean;
  splitAt: number | null;
  closeAfter: boolean;
  disconnect: "before" | "after" | null;
};

/** Validates before mutating snapshots, isolating malformed traffic from normal wire constructors. */
export function planFaults(
  frames: readonly (Buffer | Codec8Frame)[],
  input: unknown,
  identity: string,
  alternateIdentity?: string,
): FaultPacket[] {
  if (
    !valid(input) ||
    identity.length !== 15 ||
    !/^[0-9]{15}$/.test(identity) ||
    frames.length < 1 ||
    frames.length > 16
  )
    throw new FaultError();
  const actions = new Map<number, Action>();
  for (const action of input.actions) {
    if (action.packet > frames.length || actions.has(action.packet))
      throw new FaultError();
    actions.set(action.packet, { ...action });
  }
  return frames.flatMap((frame, index) => {
    let snapshot: ReturnType<typeof Codec8Frame.snapshot>;
    try {
      snapshot = Codec8Frame.snapshot(frame);
    } catch (error) {
      if (error instanceof FrameError) throw new FaultError();
      throw error;
    }
    if (snapshot.recordCount !== 1) throw new FaultError();
    const bytes = snapshot.bytes;
    const action = actions.get(index + 1);
    if (action && "offset" in action && action.offset >= bytes.length)
      throw new FaultError();
    const packet: FaultPacket = {
      ordinal: index + 1,
      bytes,
      recordCount: 1,
      identity,
      deny: false,
      splitAt: null,
      closeAfter: false,
      disconnect: null,
    };
    switch (action?.kind) {
      case "corrupt-crc":
        bytes.writeUInt8(
          bytes.readUInt8(bytes.length - 1) ^ 1,
          bytes.length - 1,
        );
        packet.deny = true;
        break;
      case "truncate-close":
        packet.bytes = Buffer.from(bytes.subarray(0, action.offset));
        packet.closeAfter = true;
        packet.deny = true;
        break;
      case "split-write":
        packet.splitAt = action.offset;
        break;
      case "duplicate-record":
        return [packet, { ...packet, bytes: Buffer.from(bytes) }];
      case "late-event-time": {
        const timestamp = BigInt(action.timestampMs);
        if (timestamp >= bytes.readBigUInt64BE(10)) throw new FaultError();
        bytes.writeBigUInt64BE(timestamp, 10);
        bytes.writeUInt32BE(crc16Arc(bytes.subarray(8, -4)), bytes.length - 4);
        break;
      }
      case "unregistered-identity":
        if (
          alternateIdentity?.length !== 15 ||
          !/^[0-9]{15}$/.test(alternateIdentity) ||
          alternateIdentity === identity
        )
          throw new FaultError();
        packet.identity = alternateIdentity;
        packet.deny = true;
        break;
      case "disconnect-before-write":
        packet.disconnect = "before";
        break;
      case "disconnect-after-write":
        packet.disconnect = "after";
        break;
    }
    return [packet];
  });
}
