/** Seeds the minimal wire owner so each snapshot can resolve its allowed imports.
 * @param {Record<string, string>} extra
 */
export const files = (extra) =>
  new Map(
    Object.entries({ "wire/codec8.ts": "export const codec = 8;", ...extra }),
  );

/** Projects diagnostics onto stable location/rule prefixes for exact ordering checks. */
export const codes = (/** @type {string[]} */ diagnostics) =>
  diagnostics.map((message) => message.split(";")[0]);
