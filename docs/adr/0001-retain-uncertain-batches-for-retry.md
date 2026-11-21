# Retain uncertain batches for retry

## Status

Accepted, 21 November 2026. The owner explicitly endorsed acknowledgement-only
evidence and possible duplicate remote effects in domain interview Q9, then
authorized publication. This record does not change historical deployment-plan
proposal statuses.

## Context and decision

Record-count acknowledgements cannot establish end-to-end exactly-once delivery.
Retain frozen pending batch bytes until the expected acknowledgement is observed
and the local checkpoint advances. After an uncertain outcome, retry can repeat
remote effects, including when the remote peer accepted records before a local
checkpoint commit failed. Report protocol acknowledgement separately from durable
acceptance, semantic processing, projection and browser visibility.

## Alternatives and consequences

Dropping uncertain batches risks loss. Treating a count acknowledgement as unique
remote processing invents a guarantee the protocol cannot provide. Frozen replay
preserves the attempted content at the cost of possible duplicates; consumers
must use their own explicit identity and processing contracts. This documents
existing behavior, requires no migration and does not change peer deduplication.
Persistent-compliant-peer mode retains its documented equal-count ambiguity.

See [recovery](../offline-recovery.md) and the
[receipt contract](../../src/session/state.ts). An earlier cross-repository
[planning proposal](https://github.com/stanimirivanov/fleetiq-deploy/blob/main/docs/plans/teltonika-simulator/adr/0004-retry-and-evidence.md)
remains historical; this record is authoritative for the simulator-owned decision.
