# Product test support

`wire/` owns literal vectors, generated corpora and independent reference decoders;
retain provenance and licensing. `peers/` owns independent TCP/UDP servers and
command vectors. `playback/` owns synthetic playback and spool inputs;
`processes/` owns the real spool-crash child program.

Keep these modules free of harness imports and test declarations. They support
product behavior checks, not coding-policy enforcement. Repository-relative
profile reads and child entry points run from the repository root. Do not put
real identities, endpoints, captures or private settings here.
