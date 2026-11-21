# FleetIQ simulation language

Local simulation vocabulary extends the [shared product glossary](https://github.com/stanimirivanov/fleetiq-platform/blob/main/GLOSSARY.md).

## Language

**Simulator device alias**: A local name selecting a private wire identity; it is distinct from a registered platform asset identity.

**Synthetic fleet**: A bounded collection of simulated participants. _Avoid_: organizational fleet or tenant as a synonym.

**Scenario**: A deterministic synthetic schedule of motion, device state and observations.

**Route**: The travel geometry used by a scenario; it does not establish a platform trip or journey.

**Device profile**: The reviewed model-specific meanings used to produce protocol signals; it does not certify physical hardware or firmware.

**Capture**: Sampling a synthetic observation at a scenario tick or state transition, independently of transmission.

**Record**: One protocol telemetry record produced from a captured observation.

**Batch**: A bounded ordered group of records selected for a transport exchange.

**Acknowledged batch**: A batch for which the peer returned the expected record-count acknowledgement; subsequent product processing is separate evidence.

**Checkpoint**: Retained progress and pending work sufficient to continue a synthetic schedule.

**Resume**: Continuation of the retained synthetic schedule, with scenario time paused during process downtime.

**Scenario time**: The virtual timeline governing synthetic motion and capture.

**Device time**: The reported device clock used to timestamp emitted records.

**Transport elapsed time**: Real elapsed time governing exchange deadlines and retry budgets.

**Physical movement**: Movement of the simulated subject, independently of GPS-fix availability.

**Reported GPS speed**: The speed represented by GPS-related protocol evidence, distinct from physical movement.

**Fault scenario**: A deliberately controlled deviation used to observe a peer’s response; an observed refusal does not establish its internal reason.
