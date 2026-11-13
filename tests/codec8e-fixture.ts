import { record } from "./codec8-fixture.ts";

// Teltonika's Codec 8 Extended TCP example, with presentation spaces removed.
export const extended = {
  ...record,
  timestampMs: String(0x16b412cee00),
  eventId: 1,
  io: [
    { id: 1, hex: "01" },
    { id: 17, hex: "001d" },
    { id: 16, hex: "015e2c88" },
    { id: 11, hex: "000000003544c87a" },
    { id: 14, hex: "000000001dd7e06a" },
  ],
  variableIo: [],
};
export const extendedFrame =
  "000000000000004a8e010000016b412cee000100000000000000000000000000000000010005000100010100010011001d00010010015e2c880002000b000000003544c87a000e000000001dd7e06a00000100002994";

// Synthetic NX example laid out by hand from the manufacturer field table.
// CRC 7c8e was checked with the independent MSB-first test oracle.
export const variableRecord = {
  ...record,
  timestampMs: "0",
  priority: 0,
  eventId: 65535,
  io: [{ id: 300, hex: "0102" }],
  variableIo: [{ id: 65535, hex: "00010203ff" }],
};
export const variableFrame =
  "00000000000000368e01000000000000000000000000000000000000000000000000ffff000200000001012c0102000000000001ffff000500010203ff0100007c8e";
