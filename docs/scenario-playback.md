# Deterministic route and model playback

`createPlayback(route, scenario, profile)` in `src/scenarios/route.ts` accepts
parsed JSON and returns `{ durationMs, sample(elapsedMs) }`. Each sample is a
version-1 `Record8E` for `encodeCodec8e`, not an already sent packet. Callers own
file admission and capture/send scheduling. The existing one-record CLI remains
unchanged; SIM-PR10 will connect capture scheduling. No IO, clocks or randomness
are read by this API.

Load the checked-in `scenarios/normal-day.json` and
`profiles/fmb920-docs-v1.json` in the caller. Supply a bare GeoJSON LineString,
for example `{ "type": "LineString", "coordinates": [[-0.01, 0], [0.01, 0]] }`.
GeoJSON uses longitude then latitude ([RFC 7946](https://datatracker.ietf.org/doc/html/rfc7946)).
Only finite 2D coordinates within WGS84 bounds are admitted; reject extra keys,
more than 100,000 points, repeated consecutive positions, degenerate arcs below
1e-12 radians, near-antipodal arcs and longitude jumps over 180 degrees. No GPX,
road routing or antimeridian normalization is provided.

Motion follows shortest spherical arcs by travelled distance, not linear degree
interpolation. Central angle is atan2 of vector cross-product magnitude and dot
product; interpolation weights are sin((1-f)angle)/sin(angle) and
sin(f angle)/sin(angle). Coordinates round once to signed e7. The mean radius is
6,371,008.8m, also used by [Turf helpers](https://github.com/Turfjs/turf/blob/master/packages/turf-helpers/index.ts).
This is a kinematic sphere approximation, not an ellipsoidal navigation model;
no new dependency or upstream implementation is copied.

Scenario v1 requires a profile ID, 1–64-character ASCII seed, canonical decimal
u64 `startTimeMs`, signed integer `clockOffsetMs` (±24h), integer `driftPpm`
(±1000), explicit `loop` and 1–256 phases. Total duration is at most seven days.
Each phase requires positive integer `durationMs`, integer `speedMmPerSecond`
(0–1,000,000), `ignition` and `gpsFix`. A speed of zero is a stop; ignition and
movement are independent so idling and towing can be represented. Phase state
changes at its start before sampling. At the scenario horizon the final phase's
state remains in effect; samples after the horizon reject.

Sample times are safe integer virtual milliseconds in nondecreasing order;
equal-time samples are idempotent and do not implicitly coalesce events. Device
time is start + offset + elapsed + trunc(elapsed × driftPpm / 1,000,000), using
bigint with signed truncation toward zero. Reject u64 underflow/overflow before
playback. This timestamp is never a socket/ACK deadline.

At a route endpoint motion and odometer accumulation stop unless `loop` is true.
Looping wraps the position while retaining cumulative distance. Stops have no
random jitter. GPS loss continues physical motion and IO but holds the last
sampled valid coordinates (zero before any fix) and zeros satellites, heading
and GPS speed. Recovery uses the current physical position. Valid fixes use
synthetic altitude 0 and 8 satellites; moving speed rounds to integer km/h and
heading to integer degrees modulo 360. The [manufacturer GPS description](https://wiki.teltonika-gps.com/view/Codec)
is the basis for the no-fix representation. Quality interpretation by an installed
platform/browser is not qualified by these unit/native decoder checks.

The documentation-derived FMB920 profile has immutable role/ID/width meanings:
239 ignition and 240 movement (1 byte), 21 GSM strength (1 byte), 66 external
voltage and 67 battery voltage (2 bytes), 16 odometer and 12 fuel used (4 bytes).
The JSON catalogue must match the reviewed schema; arbitrary relabeling fails.
[Manufacturer IO definitions](https://wiki.teltonika-gps.com/view/FMB920_Teltonika_Data_Sending_Parameters_ID)
provide widths/scales. Voltage is fixed synthetic 12V/4V in millivolts; odometer
counts whole metres, and fuel is an explicit 8L/100km estimate in millilitres,
not tank/CAN/OBD data. Event ID and priority are 0 (regular sample). Raw values
are zero-padded big-endian hex. FNV-1a of the seed, XOR virtual milliseconds,
selects GSM strength 3–5; this is deterministic synthetic variation, not RF noise.

Playback snapshots input geometry/phases and owns only previous sample time and
last fix. Reproducing GPS-loss output requires the same ordered sample sequence,
not just the same final timestamp. Returned records/IO can be mutated without
changing subsequent samples. Checkpoint persistence is deferred to SIM-PR11.
`ScenarioError` / `ProfileError` expose fixed categories, without private input.
