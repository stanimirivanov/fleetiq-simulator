import { Codec8Frame, FrameError } from "./codec8.ts";

/** Fixed UDP admission error; never retains datagram, identity or peer bytes in diagnostics. */
export class UdpError extends Error {
  readonly category = "invalid-udp";

  /** Identifies invalid local wire inputs without serializing caller values. */
  constructor() {
    super("invalid-udp");
  }
}

/** Advances u16 channel/u8 AVL IDs modulo their widths; offsets below 65536 cannot repeat a pair. */
export function udpIds(packetId: number, avlPacketId: number, offset: number) {
  for (const [value, max] of [
    [packetId, 65535],
    [avlPacketId, 255],
    [offset, 65535],
  ])
    if (
      value === undefined ||
      max === undefined ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > max
    )
      throw new UdpError();
  return {
    packetId: (packetId + offset) & 0xffff,
    avlPacketId: (avlPacketId + offset) & 0xff,
  };
}

/**
 * Encapsulates a validated wire-owned AVL body, excluding the TCP preamble/length/CRC.
 * The 23-byte UDP/identity header adds eleven bytes over the admitted TCP profile:
 * at most 1291 bytes total. Returns detached private bytes and their validated count.
 */
export function encodeUdp(
  frame: Codec8Frame | Buffer,
  identity: string,
  packetId: number,
  avlPacketId: number,
) {
  udpIds(packetId, avlPacketId, 0);
  if (identity.length !== 15 || /[^0-9]/u.test(identity)) throw new UdpError();
  let snapshot: ReturnType<typeof Codec8Frame.snapshot>;
  try {
    snapshot = Codec8Frame.snapshot(frame);
  } catch (error) {
    if (error instanceof FrameError) throw new UdpError();
    throw error;
  }
  const body = snapshot.bytes.subarray(8, -4);
  const bytes = Buffer.alloc(23 + body.length);
  bytes.writeUInt16BE(bytes.length - 2);
  bytes.writeUInt16BE(packetId, 2);
  bytes[4] = 1;
  bytes[5] = avlPacketId;
  bytes.writeUInt16BE(15, 6);
  bytes.write(identity, 8, "ascii");
  body.copy(bytes, 23);
  return { bytes, packetId, avlPacketId, recordCount: snapshot.recordCount };
}

/** Only a complete seven-byte AVL response with exact echoed IDs/count can acknowledge a datagram. */
export function matchesUdpAck(
  reply: Buffer,
  packetId: number,
  avlPacketId: number,
  recordCount: number,
): boolean {
  return (
    recordCount > 0 &&
    reply.length === 7 &&
    reply.readUInt16BE() === 5 &&
    reply.readUInt16BE(2) === packetId &&
    reply[4] === 1 &&
    reply[5] === avlPacketId &&
    reply[6] === recordCount
  );
}
