// Teltonika AVL Protocols, Codec 16 TCP worked example (no identity/capture).
// The hex stream has priority 00; its prose table incorrectly says 01.
export const manufacturer16 =
  "000000000000005f10020000016bdbc7833000000000000000000000000000000000000b05040200010000030002000b00270042563a00000000016bdbc7871800000000000000000000000000000000000b05040200010000030002000b00260042563a00000200005fb3";
export const record16 = {
  schemaVersion: 1,
  profile: "generic-codec16-provisional",
  timestampMs: String(0x16bdbc78330),
  priority: 0,
  longitudeE7: 0,
  latitudeE7: 0,
  altitude: 0,
  angle: 0,
  satellites: 0,
  speed: 0,
  eventId: 11,
  generationType: 5,
  io: [
    { id: 1, hex: "00" },
    { id: 3, hex: "00" },
    { id: 11, hex: "0027" },
    { id: 66, hex: "563a" },
  ],
};

// First manufacturer record, with single-record envelope/count and independent CRC.
export const single16 =
  "000000000000003110010000016bdbc7833000000000000000000000000000000000000b05040200010000030002000b00270042563a00000100000f89";
