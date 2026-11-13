import { Ajv2020 } from "ajv/dist/2020.js";

// Reviewed FMB920 permanent IO subset; schema constants prevent profile relabeling.
// https://wiki.teltonika-gps.com/view/FMB920_Teltonika_Data_Sending_Parameters_ID
const catalogue = {
  ignition: [239, 1],
  movement: [240, 1],
  gsm: [21, 1],
  externalVoltage: [66, 2],
  batteryVoltage: [67, 2],
  odometer: [16, 4],
  fuelUsed: [12, 4],
} as const;

/** Fixed profile identity and reviewed field widths; JSON cannot redefine sensor meanings. */
type Profile = {
  schemaVersion: 1;
  id: "fmb920-docs-v1";
  io: Record<keyof typeof catalogue, { id: number; width: number }>;
};
const valid = new Ajv2020({ ownProperties: true }).compile<Profile>({
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "io"],
  properties: {
    schemaVersion: { const: 1 },
    id: { const: "fmb920-docs-v1" },
    io: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(catalogue),
      properties: Object.fromEntries(
        Object.entries(catalogue).map(([name, [id, width]]) => [
          name,
          {
            type: "object",
            additionalProperties: false,
            required: ["id", "width"],
            properties: { id: { const: id }, width: { const: width } },
          },
        ]),
      ),
    },
  },
});

/** Kinematic state in exact micrometres; radio strength is synthetic, not an RF model. */
type ModelState = {
  ignition: boolean;
  moving: boolean;
  distanceMicrometers: bigint;
  strength: number;
};

/** Rejected profile definitions or raw values; no model/config data appears in output. */
export class ProfileError extends Error {
  constructor() {
    super("invalid-profile");
  }
}

/**
 * Admits only the documentation-derived catalogue and returns fresh, fixed-width raw IO.
 * Voltages are synthetic 12V/4V; odometer is whole travelled metres and fuel is an
 * explicit 8L/100km estimate in millilitres. No hardware/accessory qualification is implied.
 */
export function createProfile(value: unknown) {
  if (!valid(value)) throw new ProfileError();
  return ({ ignition, moving, distanceMicrometers, strength }: ModelState) => {
    if (!Number.isInteger(strength) || strength < 0 || strength > 5)
      throw new ProfileError();
    const values = {
      ignition: BigInt(+ignition),
      movement: BigInt(+moving),
      gsm: BigInt(strength),
      externalVoltage: 12000n,
      batteryVoltage: 4000n,
      odometer: distanceMicrometers / 1000000n,
      fuelUsed: (distanceMicrometers * 8n) / 100000000n,
    };
    if (distanceMicrometers < 0n || values.odometer > 2147483647n)
      throw new ProfileError();
    return (Object.keys(catalogue) as (keyof typeof catalogue)[]).map(
      (name) => {
        const [id, width] = catalogue[name];
        return { id, hex: values[name].toString(16).padStart(width * 2, "0") };
      },
    );
  };
}
