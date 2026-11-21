# Separate simulation and transport time

## Status

Accepted, 21 November 2026. The owner explicitly endorsed paused-schedule resume
and separate clocks in domain interview Q11, then authorized publication.

## Context and decision

A reproducible synthetic scenario must not silently change because its process
was stopped overnight. Resume continues the retained synthetic schedule with
scenario time paused during downtime. Device clock settings govern reported
record timestamps; real monotonic elapsed time governs transport deadlines and
retry budgets. Modeling movement during downtime requires an explicit scenario.

## Alternatives and consequences

Automatically catching up to wall time would couple generated observations to
operator delays and make resumed schedules nondeterministic. One shared clock
would allow device drift or virtual pacing to distort network deadlines. Separate
clocks preserve reproducibility but require explicit time terminology and prevent
resume from claiming an elapsed-real-world simulation. This records existing
behavior without changing checkpoint formats or requiring migration.

See [offline recovery](../offline-recovery.md) and
[scenario playback](../scenario-playback.md).
