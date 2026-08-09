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
| Scenario | 8 presets | Sets the sliders and switches to a named situation, seeds the event log, and flies the camera to the district it is about | n/a — a shortcut for the knobs below, it adds no mechanism of its own |
| Query rate | 0–20 q/s | Spawn rate of query particles | **scaled** — a real server does thousands/s; this is what fits on screen |
| Write mix | 0–100% | Share of queries that take a lock, write a version and commit | **real** — the read/write split drives everything downstream |
| Page cache | 16–128 buffers | Size of the LRU buffer cache | **scaled** — Firebird's default is 2048 pages; the hot set here is 40 pages, so 64 covers it and 16 thrashes |
| Sort memory | 8–120 units | Firebird's `TempCacheLimit`: sorts that fit run in memory, larger ones spill to temporary files | **real** mechanism, **scaled** units — the spill is genuine disk I/O the query pays for, but the sizes are arbitrary |
| Sweep interval | 10–60 s | Seconds between automatic sweeps | **modeled** — real sweep is triggered by the OIT/OAT gap crossing the sweep interval (default 20 000 transactions), not by a wall clock |
| Automatic sweep | on/off | Enables the interval sweep | **real** — corresponds to setting the sweep interval to 0 |
| Long-running transaction | on/off | Starts a transaction that never commits, pinning the OIT | **real** — this is exactly how a forgotten transaction stalls GC |
| Rush hour ×60 | button | Injects 60 queries at once | **modeled** — a convenience for watching queueing |
| Speed | 0.5–4× | Multiplies the simulation timestep | n/a — presentation only |

## Replication

Firebird 4+ logical replication. There is no write-ahead log to ship, so the
committed changes themselves are journalled into segments and replayed on the
replica in commit order.

| Knob | Effect | Honesty |
|---|---|---|
| Replication mode | `off`, `asynchronous`, or `synchronous` | **real** — async journals to segments and the replica trails; sync sends down a live connection and writes no journal |
| Replica health | `healthy`, `slow to apply`, `unreachable` | **modeled** — a single dial standing in for network, disk and load on the replica |
| repl lag | Changes committed but not yet applied | **real** arithmetic (generated − applied), **scaled** magnitudes |
| segments | Sealed journal segments waiting to ship | **real** structure — 20 changes per segment here, configurable in reality; async only |

The behaviour that matters most: **a failing replica does not block a
commit.** `disable_on_error` (default `true`) tears replication down —
`STOP_ERROR` is logged, the replicating flags are cleared and the replicator
disposed — and the commit succeeds normally. On the commit path Firebird
calls `checkStatus()` with `canThrow = false`, so it cannot throw even when
`report_errors` is on (and `report_errors` defaults to `false`).

Synchronous replication here is **not** two-phase commit and offers no
durability guarantee, so there is none to lose when a replica dies. The
practical consequence is worse than a hang would be: replication stops,
commits carry on, nobody is told, and the replica silently rots until
somebody notices and turns it back on.

*Verified against `src/jrd/replication/Publisher.cpp` and `Config.cpp` on
FirebirdSQL/firebird master. An earlier version of this model claimed the
opposite — that commits hang — which was wrong; thanks to Dmitry Sibiryakov
for the correction.*

## Backup yard

| Knob | Effect | Honesty |
|---|---|---|
| gbak | Runs a 12-second logical backup; its snapshot transaction pins the OIT for the whole run | **real** mechanism, **scaled** duration — a logical backup really does hold back garbage collection for its duration |
| nbackup L0 | Copies the whole file (8 s), then unlocks and merges | **scaled** |
| nbackup L1 | Copies only pages changed since L0 (3 s) | **real** structure — levels really do chain, and a restore needs every level in order |
| Lock / unlock | Freezes the main file; page writes divert to the difference file until merged back | **real** — this is what `nbackup -L` / `-N` do |
| Restore chain | Prints which levels a restore would apply, in order | **real** — reporting only, nothing is restored |

## Operator decisions

Three situations where both answers cost something. Each one sets the world
into the situation for real, then measures the consequence of your choice
from the model rather than asserting it.

| Decision | The call | Honesty |
|---|---|---|
| Sweep is blocked | Terminate the idle attachment, or wait for it | **real** — killing it advances the OIT and loses that transaction's work; waiting collects nothing |
| The backup is holding the OIT | Let gbak finish, or cancel it | **real** trade — the bloat is recoverable by sweep, the missing backup is not |
| The delta file is growing | Unlock and merge now, or wait for a quiet window | **real** — merging costs measured page writes at peak; waiting grows the delta and does not shrink the merge |
| The replica is gone | Stop replication and discard the backlog, or keep journalling and wait | **real** — dropping frees the disk but the replica needs a fresh restore, not a resume; waiting risks the volume filling and taking the primary with it |

The numbers quoted back to you in a verdict (versions collected, page writes,
hit ratio, delta size) are measured from the run, not written in advance.

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
| model clock | Elapsed time inside the simulation, with the speed multiplier and pause state | **real** — it is the model's own clock, which warp and the speed control move faster than yours |
| Latency profile | Mean time per bucket over the last 256 completed trips, plus p50/p95 | **real** accounting — every bucket is charged from elapsed model time and the parts are asserted to sum to the whole, so the profile cannot quietly lose time. The *magnitudes* are scaled like everything else |

## Deliberate simplifications

Things a Firebird engineer will notice are missing or wrong, listed so nobody
has to discover them by reading the source:

- **No SQL is parsed.** The DSQL district animates a pipeline; it does not
  tokenize anything. Particles carry no statement text. If you want an engine
  that really does parse it, [the real engine page](../engine.html) points at
  [Electric Firebird](https://github.com/mariuz/electric-firebird) — Firebird
  compiled to WebAssembly — so the model and the genuine article are one click
  apart.
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
  page-level locks, no ASTs.
- **Replication is one replica and one dial.** Real deployments have several
  replicas with independent lag, selective replication via
  `RDB$PUBLICATIONS`, journal archiving, and apply errors that stop
  replication until a human intervenes. None of that is here.
- **Sweep is time-triggered**, not transaction-gap-triggered (see above).
- **The traced query is spared deadlocks** so the guided walk stays
  predictable. Real transactions enjoy no such courtesy.

If one of these matters for what you are trying to understand, read the
[Conceptual Architecture for Firebird](https://github.com/mariuz/conceptual-architecture-for-firebird-paper)
companions instead — they are grounded in the actual source.

## Divergence runs both ways

Worth stating plainly, because a list of simplifications only ever shows one
direction: the model is *kinder* than Firebird in some places and *harsher*
in others.

**Kinder than reality:** lock contention is a flat probability rather than a
real wait-for graph, so pathological convoys never form. The traced query is
spared deadlocks. Page access follows a tidy two-tier distribution instead of
whatever your schema actually does. Sweep always finishes.

**Harsher than reality:** the cache is tiny (16–128 buffers against a 40-page
hot set), so thrashing appears at a scale no production instance would see.
Version chains are capped at 26 for display, which flatters a stuck OIT —
real chains have no such mercy. gbak takes twelve seconds here and hours in
production, so the OIT pin looks survivable when it may not be.

## Keeping this file honest

`test/` asserts that every control listed above exists in the UI and is
documented here, that every scenario in the picker appears in the README,
that each knob produces a measurable change in the model, and that every
deep link printed in the docs uses parameters and values the app actually
handles. Adding a control without documenting it fails the suite.

The suite also tests itself: a set of deliberate-breakage checks confirm
that the drift tests *can* go red — that breaking a documented knob name,
putting DOM access in the simulation layer, dropping a latency bucket or
colliding two semantic colours would each be caught. A green suite is only
worth something if it is capable of turning red.

A **fuzzer** then sweeps every combination of query rate, write mix, cache
size, replication mode and replica health — 324 of them — stirring in sort
memory, sweep, long transactions, nbackup locks and gbak, and asserts the
model never produces a NaN, a negative counter, an unbounded queue, markers
past `Next`, or a version chain out of step with its own count. Knobs that
are individually sane can still combine into nonsense.

A **soak** runs the worst settings for 90 seconds and checks the city is
still doing work at the end rather than wedged. `test/index.html?soak=1`
extends the fuzz and soak to their long form; the default stays short
enough that people actually run it.

## Found something wrong?

Every building panel and the latency view carry a **report** link that opens
a pre-filled issue. No analytics or tracking is attached to those links, or
to anything else here.

Corrections are acted on, not filed: the entire replication model was
rewritten in v0.6.1 after Dmitry Sibiryakov pointed out on firebird-general
that the synchronous-failure behaviour was backwards.
