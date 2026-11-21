# Simulation domain boundaries

Read the [local glossary](../GLOSSARY.md) and
[shared product model](https://github.com/stanimirivanov/fleetiq-platform/blob/main/docs/architecture/domain-model.md)
when discussing identity, attribution or evidence. The owner endorsed this scope
in the domain interview on 21 November 2026.

| Module | Responsibility | Contract evidence |
| --- | --- | --- |
| Scenarios | Deterministic motion, capture, batching and synthetic fleet scheduling | [Playback](scenario-playback.md), [capture](capture-batching.md), [fleet](fleet.md) |
| Wire | Validated protocol records and immutable encoding | [Wire boundary](../src/wire/AGENTS.md) |
| Session | Bounded attempts, deadlines and acknowledgement receipts | [Receipt contract](../src/session/state.ts) |
| Transport | Socket, login and acknowledgement exchange | [Transport boundary](../src/transport/AGENTS.md) |
| Storage | Private retained progress and frozen pending work | [Recovery](offline-recovery.md) |
| Qualification harness | Exact producer/decoder compatibility and independent reference behavior | [Platform pin](../harness/src/qualification/platform/platform-pin.json) |

A simulator alias selects a private wire identity; the simulator cannot prove its
platform registration. Protocol signals acquire business meaning only through
platform semantic configuration. Product transport support and reference-peer
support remain distinct; UDP reference tests and offline Codec 16 do not establish
installed FleetIQ support. The product fleet’s current two-attempt cap is a
qualification constraint, not a permanent platform capacity boundary.

GPS-loss scenarios can retain old coordinates and report zero GPS speed while
physical movement continues. Consumers must interpret validity and quality,
not infer stopped motion from a GPS value. Scenario, device and transport time
are independent; [paused resume](adr/0002-separate-simulation-and-transport-time.md)
is deliberate. [Frozen replay](adr/0001-retain-uncertain-batches-for-retry.md)
permits remote duplicates and claims only protocol acknowledgement.

The simulator owns emission and local transport evidence. Platform owns durable
acceptance and semantic processing; UI owns browser presentation; deploy owns
qualification of their assembled versions. Tests at one boundary do not substitute
for installed-product or physical hardware qualification.
