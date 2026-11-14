export const record = {
  schemaVersion: 1,
  timestampMs: String(0x16b40d8ea30),
  priority: 1,
  longitudeE7: 0,
  latitudeE7: 0,
  altitude: 0,
  angle: 0,
  satellites: 0,
  speed: 0,
  eventId: 1,
  io: [
    { id: 21, hex: "03" },
    { id: 1, hex: "01" },
    { id: 66, hex: "5e0f" },
    { id: 241, hex: "0000601a" },
    { id: 78, hex: "0000000000000000" },
  ],
};

// Teltonika Codec 8 over TCP, first worked example.
export const frame =
  "000000000000003608010000016b40d8ea30010000000000000000000000000000000105021503010101425e0f01f10000601a014e0000000000000000010000c7cf";
