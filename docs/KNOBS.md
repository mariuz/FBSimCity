# Knob audit

Every control FBSimCity exposes, what it actually does to the model, and how
honest it is about Firebird. Written so nobody has to read `sim.js` to find
out whether a number means anything.

Three honesty levels:

- **real** — the mechanism works the way Firebird's does, at a smaller scale.
- **scaled** — the mechanism is real but the numbers are shrunk so a human
  can watch them move.
- **modeled** — a plausible stand-in. The *behavior* is directionally true;
  the implementation is not Firebird's.

## Control room

| Knob | Range | Effect | Honesty |
|---|---|---|---|
| Query rate | 0–20 q/s | Spawn rate of query particles | **scaled** — a real server does thousands/s; this is what fits on screen |
| Write mix | 0–100% | Share of queries that take a lock, write a version and commit | **real** — the read/write split drives everything downstream |
| Page cache | 16–128 buffers | Size of the LRU buffer cache | **scaled** — Firebird's default is 2048 pages; the hot set here is 40 pages, so 64 covers it and 16 thrashes |
| Sweep interval | 10–60 s | Seconds between automatic sweeps | **modeled** — real sweep is triggered by the OIT/OAT gap crossing the sweep interval (default 20 000 transactions), not by a wall clock |
| Automatic sweep | on/off | Enables the interval sweep | **real** — corresponds to setting the sweep interval to 0 |
| Long-running transaction | on/off | Starts a transaction that never commits, pinning the OIT | **real** — this is exactly how a forgotten transaction stalls GC |
| Rush hour ×60 | button | Injects 60 queries at once | **modeled** — a convenience for watching queueing |
| Speed | 0.5–4× | Multiplies the simulation timestep | n/a — presentation only |

## Backup yard

| Knob | Effect | Honesty |
|---|---|---|
| gbak | Runs a 12-second logical backup; its snapshot transaction pins the OIT for the whole run | **real** mechanism, **scaled** duration — a logical backup really does hold back garbage collection for its duration |
| nbackup L0 | Copies the whole file (8 s), then unlocks and merges | **scaled** |
| nbackup L1 | Copies only pages changed since L0 (3 s) | **real** structure — levels really do chain, and a restore needs every level in order |
| Lock / unlock | Freezes the main file; page writes divert to the difference file until merged back | **real** — this is what `nbackup -L` / `-N` do |
| Restore chain | Prints which levels a restore would apply, in order | **real** — reporting only, nothing is restored |

## What the readouts mean

| Readout | Source | Honesty |
|---|---|---|
| queries/s | Completed particles per second | **scaled** |
| cache hit | `hits / (hits + misses)` over a 1-second window | **real** formula |
| evictions | LRU frames reused | **real** |
| evictions (dirty) | Evictions that had to write the page out first | **real** — a dirty eviction makes a reader pay for someone else's write |
| Next / OAT / OIT | Transaction id counters | **real** arithmetic, **scaled** ids (they start at 1000, not at whatever your database is at) |
| stale versions | Record versions beyond the current one, summed over 12 tables | **scaled** — 12 tables, chains capped at 26 for display |
| lock waits | Writers that queued at the lock manager | **modeled** — a fixed 22% chance of contention per write, not a real lock table |
| deadlock rollbacks | Waiters chosen as deadlock victims | **modeled** — 6% of waits, not a real wait-for graph |
| backup | Current backup state, or the completed level chain | **real** |
| delta | Pages sitting in the difference file | **real** counting, **scaled** capacity |

## Deliberate simplifications

Things a Firebird engineer will notice are missing or wrong, listed so nobody
has to discover them by reading the source:

- **No SQL is parsed.** The DSQL district animates a pipeline; it does not
  tokenize anything. Particles carry no statement text.
- **The optimizer does not optimize.** Index vs sort is a coin flip weighted
  by the write mix, not a cost model.
- **Page access is a two-tier hot/cold distribution**, not a real access
  pattern derived from tables and indexes.
- **Careful writes are asserted, not ordered.** The excavation is labeled
  "careful writes" and no WAL exists — correct — but the model does not
  maintain a page precedence graph.
- **Commit-order snapshots (Firebird 4+) are not modeled.** Visibility here
  is a simple `txn < OIT` comparison.
- **One database, one attachment pool, no Classic/Super distinction**, no
  page-level locks, no ASTs, no replication.
- **Sweep is time-triggered**, not transaction-gap-triggered (see above).
- **The traced query is spared deadlocks** so the guided walk stays
  predictable. Real transactions enjoy no such courtesy.

If one of these matters for what you are trying to understand, read the
[Conceptual Architecture for Firebird](https://github.com/mariuz/conceptual-architecture-for-firebird-paper)
companions instead — they are grounded in the actual source.
