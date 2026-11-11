import type { Record8 } from "../src/wire/codec8.ts";

// Fixed-seed generation is reproducible without a new dependency or live data.
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

// Vary field boundaries independently of IO cardinality. Reverse IO entries
// so the encoder must regroup widths while preserving order within each width.
function generatedRecord(index: number, next: () => number): Record8 {
  const io = Array.from(
    { length: [0, 1, 4, 64][(index >>> 2) % 4] ?? 0 },
    (_, item) => {
      const width = [1, 2, 4, 8][item % 4] ?? 1;
      const hex = Array.from({ length: width }, () =>
        (next() & 255).toString(16).padStart(2, "0"),
      ).join("");
      return { id: 255 - item, hex: item % 2 ? hex.toUpperCase() : hex };
    },
  ).reverse();
  return {
    schemaVersion: 1,
    timestampMs:
      [
        "0",
        "18446744073709551615",
        "9007199254740993",
        String((BigInt(next()) << 32n) | BigInt(next())),
      ][index % 4] ?? "0",
    priority: index % 3,
    longitudeE7:
      [-1800000000, 0, 1800000000, (next() % 3600000001) - 1800000000][
        index % 4
      ] ?? 0,
    latitudeE7:
      [-900000000, 900000000, 0, (next() % 1800000001) - 900000000][
        index % 4
      ] ?? 0,
    altitude: [0, 65535, next() % 65536][index % 3] ?? 0,
    angle: [0, 360, next() % 361][index % 3] ?? 0,
    satellites: [0, 255, next() % 256][index % 3] ?? 0,
    speed: [0, 65535, next() % 65536][index % 3] ?? 0,
    eventId: [0, 255, next() % 256][index % 3] ?? 0,
    io,
  };
}

export function generatedCorpus(): { id: string; record: Record8 }[] {
  return [1, 0x8badf00d].flatMap((seed) => {
    const next = generator(seed);
    return Array.from({ length: 128 }, (_, index) => ({
      id: `seed=${seed} case=${index}`,
      record: generatedRecord(index, next),
    }));
  });
}
