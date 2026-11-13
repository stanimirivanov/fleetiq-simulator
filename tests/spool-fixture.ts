import { Codec8Frame } from "../src/wire/codec8.ts";
import { encodeCodec8e } from "../src/wire/codec8e.ts";
import { variableRecord } from "./codec8e-fixture.ts";
export const binding = {
  config: "1".repeat(64),
  route: "2".repeat(64),
  profile: "3".repeat(64),
  scenario: "4".repeat(64),
  identity: "5".repeat(64),
  schedule: "6".repeat(64),
};
export const limits = {
  maxRecords: 2,
  maxFrameBytes: 1280,
  maxQueuedRecords: 1000,
  maxQueuedBytes: 16777216,
  maxAgeMs: 86400000,
};
export const work = [
  {
    atMs: 0,
    frame: Codec8Frame.fromExtendedBytes(encodeCodec8e(variableRecord)),
  },
  {
    atMs: 10,
    frame: Codec8Frame.fromExtendedBytes(
      encodeCodec8e({ ...variableRecord, timestampMs: "1" }),
    ),
  },
  { atMs: 20, frame: null },
];
