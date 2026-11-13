# Capture triggers and bounded FIFO batching

These APIs compose existing playback and TCP delivery without filesystem or
transport effects in scenario code. CLI file/spool orchestration belongs to
SIM-PR11; this slice does not persist records or claim crash recovery.

## Capture and clocks

`createPlayback` now exposes immutable `transitions` (virtual `atMs`, ignition,
physical movement). They include phase starts and the first integer millisecond
at a nonlooping route endpoint. Reading metadata does not acquire a GPS fix.
`capture(playback, { intervalMs, sendIntervalMs, on })` consumes a fresh cursor;
`on` is an ordered, duplicate-free subset of ignition, movement-start and stop
(named `ignition`, `movement`, `stop`). Initial state is a baseline, not an
implicit ignition event. Same-time events follow that order, then a periodic
capture, then any send tick. Event and periodic records remain separate.

A capture tick contains `{ type: "capture", atMs, reason, record }`; a send tick
is `{ type: "send", atMs }`. Periodic capture starts at zero. Sends start at the
independent send interval and always flush once at the horizon. No implicit
periodic record is added at a nonaligned horizon. Positive integer cadences are
bounded to seven virtual days. Preflight rejects over 1000 captures (including
events) or 1000 sends before sampling; metadata and iteration are bounded.
A generator is single-use. GPS loss never invents a stop from GPS speed zero:
triggers use physical movement, while records retain playback quality semantics.

Profile-owned event IDs are ignition 239 and movement/stop 240. They retain
low/regular priority 0 ([FMB920 IO settings](https://wiki.teltonika-gps.com/view/FMB920_I/O_settings));
periodic ID is 0. Triggers and cadences are an explicit lab policy, not factory
configuration or hardware qualification. Values reflect updated state.

`createClock(scale)` returns a mapper from injected monotonic **elapsed** integer
milliseconds to virtual milliseconds. Scale 1 is real-time; 2–1000 explicitly
accelerates simulation. Backward, unsafe, fractional and over-seven-day virtual
time rejects. Device epoch/offset/drift are not clock inputs. Always give
`sendBatches` a real monotonic `now`, never this virtual mapper or device time.
Virtual acceleration changes when capture is eligible, not ACK/run deadlines.

## FIFO and wire ownership

`new BatchQueue({ maxRecords, maxFrameBytes, maxQueuedRecords, maxQueuedBytes })`
requires integer limits: records 1–16, whole TCP bytes 53–1280, queued records
1–1000 and queued bytes 53–16777216. `enqueue(record)` validates/encodes and freezes
one Extended record before insertion. Invalid, individually oversized and full
queue inputs fail without replacing/removing anything. Record validation uses
RecordError; queue policy/capacity/stale-handle rejection uses invalid-session.

`peek()` returns the stable largest fitting FIFO prefix or undefined. Count and
byte limits are independent; splitting never skips a head. A pending packet is
unchanged by new enqueues or caller mutation. `length` and `queuedBytes` include
pending records. Byte accounting conservatively counts full single-record frames;
the cached packet adds at most 1280 bytes beyond that queue counter.

After transport confirms the complete count, `acknowledge(theSameHandle)` removes
exactly its wire-private count and invalidates the handle. Failures retain the
same pending bytes. Stale, forged or copied handles reject without removal.
The caller is responsible for invoking acknowledgement only after successful
delivery. ACK loss still permits remote duplicates; memory state is not a durable
commit. Commit acknowledgement and cursor atomically when SIM-PR11 adds storage.

Wire adds `combineCodec8e(singleRecordFrames)` and
`Codec8Frame.fromExtendedBatchBytes(bytes)` for 1–16 records under 1280 bytes.
Counts, length and CRC are derived/validated; transport uses their private
snapshot count. Existing `fromBytes` and `fromExtendedBytes` stay single-record.
Raw Extended admission in transport now admits bounded complete multi-record
packets. Codec 8 batching is not introduced. An exact ACK count completes the
packet; a smaller count is a failure, not a partial FIFO commit.

Composition: feed capture records into the queue; at each send tick, peek, await
`sendBatches([pending], realSessionOptions)`, acknowledge that exact handle, and
repeat until empty. If send fails, retain the head and stop/retry according to
session policy. Do not dequeue on send attempt or use a receipt's public count
to override the queue's private metadata. Fleet/fault/durable policies remain later slices.
