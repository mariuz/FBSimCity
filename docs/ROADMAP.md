# Roadmap

Planned improvements to **FBSimCity**, grouped into **engine-accuracy fixes**
(closing the gap between [`js/sim.js`](../js/sim.js) and Firebird's actual C++
implementation in `src/jrd/`) and **simulation & interactive features** (new
districts, controls, scenarios, and tighter integration with the
[`firebird-wasm`](https://github.com/mariuz/electric-firebird) engine in the
[machine room](../machine/)).

Every item below corresponds to a simplification currently recorded in
[`docs/KNOBS.md`](KNOBS.md).

---

## Part 1 — Engine Accuracy (`js/sim.js` vs `src/jrd/`)

### 1. Real OIT / OAT / OST progression & gap-triggered sweep (`tra.cpp`, `vio.cpp`)
- **Today in `sim.js`:** When no long-running transaction or `gbak` pins the
  markers, `refreshMarkers()` sets `s.oit = s.oat` immediately on every commit,
  and automatic sweep runs on a wall-clock timer (`sweepTimer >= sweepInterval`)
  even when the transaction gap is zero.
- **In Firebird (`src/jrd/tra.cpp`):**
  - **OAT** (Oldest Active) advances as soon as the oldest active transaction
    commits.
  - **OST** (Oldest Snapshot) tracks the oldest `OAT` observed when any still-running
    snapshot transaction started — the true visibility horizon below which
    record versions are unreachable.
  - **OIT** (Oldest Interesting) stays pinned at the oldest rolled-back (or
    uncommitted) transaction in the TIP until **sweep** completes a full pass
    and advances the header page's `hdr_oldest_transaction` up to `OST`.
  - Automatic sweep is triggered when `OST − OIT` crosses `MON$SWEEP_INTERVAL`
    (default `20 000` transactions, scaled in the model), not by a wall clock.
- **Improvement:** Track `ost` alongside `oit`, `oat`, and `next`; advance
  `oit` only when sweep finishes (or when no rollbacks occurred in the gap);
  trigger automatic sweep from `ost − oit >= sweepInterval`.

### 2. Back-version chain traversal cost for readers (`VIO_chase_record_version`)
- **Today in `sim.js`:** A pinned OIT grows the `Record Version Towers` and
  paints them red, but a `SELECT` particle pays the same dwell time and page
  fetches against a 26-version chain as against a 1-version chain. As a result,
  a stuck OIT does not slow down `SELECT` queries in the **Latency** panel.
- **In Firebird (`src/jrd/vio.cpp`):** Every reader that touches a row with
  back versions must walk the delta chain (`MON$BACKVERSION_READS`) until it
  reaches a version visible to its snapshot, often fetching extra data pages
  when back versions spill off-page.
- **Improvement:** Have each `SELECT` and `UPDATE` target a specific table
  (`s.tables[i]`) and add back-version walk latency (`version` + extra
  `cacheAccess` fetches) proportional to the number of versions newer than the
  reader's snapshot or awaiting GC. Watching `SELECT` p95 climb in the Latency
  panel as towers redden makes the consequence of a stuck OIT quantitative.

### 3. Cooperative vs background garbage collection (`GCPolicy`)
- **Today in `sim.js`:** `coopGC()` removes one version from a random table on
  35% of cache hits if nothing pins the OIT, at zero I/O or latency cost to the
  reader.
- **In Firebird (`src/jrd/vio.cpp`):**
  - **`cooperative`** (Classic default, and the policy `firebird-wasm` sets in
    the DPB): the reader that trips over dead back versions (`txn < OST`)
    purges them inline, paying the page mark and dirty-buffer cost itself.
  - **`background`** (SuperServer component of `combined`): readers flag pages
    in `gc_record` bitmaps and a background GC thread cleans them asynchronously.
- **Improvement:** Add a `GCPolicy` control (`cooperative`, `background`,
  `combined`) and charge inline cooperative purges to the reader's `version`
  latency bucket and dirty-page marks.

### 4. Careful writes precedence graph & `Forced Writes` switch (`cch.cpp`, `pio`)
- **Today in `sim.js`:** `flushDirty(s, 1)` flushes the first dirty buffer at
  commit, and forced writes are permanently on.
- **In Firebird (`src/jrd/cch.cpp`):**
  - Crash safety without a WAL relies on a **precedence graph**
    (`CCH_precedence`): before writing page `B` (e.g. a pointer page, index
    split, or primary record pointing to a back-version page `A`), `CCH` must
    flush page `A` first so no on-disk pointer ever dangles.
  - **`MON$FORCED_WRITES`** (`on` / `off`) controls whether writes are
    synchronous (`O_SYNC` / `FILE_FLAG_WRITE_THROUGH`) or buffered by the OS
    and flushed periodically by the cache writer.
- **Improvement:** Track parent→child precedence edges between dirtied cache
  slots (visualised as brief arcs in `Page Cache Plaza` when a commit flushes a
  dependency chain) and expose a **Forced writes** toggle so users can see the
  trade-off between commit latency and crash exposure.

### 5. Real per-table lock queues, `WAIT` / `NO WAIT`, and wait-for cycles (`lock.cpp`)
- **Today in `sim.js`:** Lock contention at `Lock Manager Tower` is a flat 22%
  probability per write, and deadlocks are a flat 6% of waits.
- **In Firebird (`src/jrd/lock/lock.cpp`):** Writers conflict only when
  updating the same record/relation, wait in an actual lock queue (`WAIT`
  with optional `LOCK TIMEOUT`) or abort immediately (`NO WAIT`), and deadlocks
  arise only when two transactions form a cycle in the wait-for graph, which
  the deadlock scan resolves after `DeadlockTimeout`.
- **Improvement:** Assign each writer a target table (with configurable
  hot-row skew), queue conflicting writers behind the actual lock holder on
  that table, detect real two-party wait cycles for deadlock rollbacks, and
  add a `WAIT` / `NO WAIT` transaction option.

### 6. Cost-based optimizer choice & index selectivity (`opt.cpp`, `btr.cpp`)
- **Today in `sim.js`:** Whether a `SELECT` visits `B-Tree Gardens` or the
  `Sort Yard` is a 50/50 coin flip.
- **In Firebird (`src/jrd/opt.cpp`):** The optimizer inspects index
  selectivity (`RDB$STATISTICS`) and query predicates to choose between index
  bitmap scans (`Index … Scan -> Bitmap -> Table Access By ID`), navigational
  index walks, or natural scans followed by an external merge sort.
- **Improvement:** Tie index vs natural-scan-plus-sort routing to table index
  selectivity (including stale statistics after bulk writes and `SET STATISTICS
  INDEX`).

### 7. Commit-order snapshots (`READ COMMITTED READ CONSISTENCY` in Firebird 4+)
- **Today in `sim.js`:** Visibility is modeled as a simple `txn < OIT`
  comparison.
- **In Firebird 4+:** `READ COMMITTED READ CONSISTENCY` is the default
  isolation mode for read-committed transactions, guaranteeing statement-level
  snapshot consistency even in the presence of concurrent writes, and restarting
  a write conflict against the newly committed version.
- **Improvement:** Model statement-level snapshot reads and write-conflict
  restarts under `READ COMMITTED READ CONSISTENCY` vs `SNAPSHOT` (`CONCURRENCY`).

---

## Part 2 — Simulation & Interactive Features

### 8. Prepared statement cache (`StatementCacheSize`)
- **Why:** Currently every particle walks `Lexer → Parser → BLR Generator →
  Compiler & Optimizer`, so `Parse & compile` takes ~47% of every query's work
  time. Since Firebird 3.0+ (and `firebird-wasm`'s 64-entry statement cache and
  `db.prepare()`), repeated statements hit the compiled statement cache and
  jump straight from `Y-Valve Gate` to `Execution Hall` with pre-compiled BLR.
- **What you will see:** A **Statement cache** slider (`off` .. `100% hit`).
  Cached particles turn violet at the Y-valve and take a shortcut expressway
  straight to `Execution Hall`, collapsing the `Parse & compile` bar in the
  Latency panel.

### 9. Server architecture switch: SuperServer vs Classic / SuperClassic
- **Why:** Firebird's three server architectures (`SuperServer`,
  `SuperClassic`, `Classic`) behave very differently in the cache and lock
  districts:
  - **SuperServer:** One shared `Page Cache Plaza`, in-process lock table,
    background GC thread.
  - **Classic / SuperClassic:** Each attachment has its own private page cache
    (drawn as partitioned mini-plazas), cooperative GC, and cross-connection
    cache coherence enforced by the `Lock Manager Tower` via **ASTs
    (Asynchronous System Traps)** — when attachment A wants to modify a page
    cached by attachment B, a blocking AST forces B to flush and release the
    page first.
- **What you will see:** Switching to **Classic** partitions the cache plaza,
  lights up AST signals between the `Lock Manager Tower` and `Page Cache
  Plaza`, and adds a new operator decision (*"SuperServer vs SuperClassic under
  a memory budget"*).

### 10. Live telemetry bridge from the Machine Room (`firebird-wasm` 0.12.0)
- **Why:** With `firebird-wasm` 0.12.0 exposing `db.databaseInfo()`
  (`oldestTransaction`, `oldestActive`, `oldestSnapshot`, `nextTransaction`,
  `fetches`, `reads`, `writes`, `marks`, `allocatedPages`) and
  `db.explain(sql, { detailed: true })`, the city no longer has to stay completely
  disconnected from the real engine.
- **What you will see:** An optional **"Live engine mode"** dock that boots the
  `firebird-wasm` worker inside the city page itself:
  - Typing a query (or clicking a preset workload) calls `db.explain()` to
    route the particle through the exact districts the real optimizer chose
    (`B-Tree Gardens` for `INDEX`, `Sort Yard` for `SORT`, `Record Version
    Towers` for `UPDATE`/`INSERT`/`DELETE`).
  - The Transaction Hall facade and stats bar display the real engine's
    `OIT / OAT / OST / Next` and `MON$IO_STATS` / `databaseInfo()` deltas after
    each statement.

### 11. Additional Operator Decisions
- **Stale index statistics after bulk load:** Run `SET STATISTICS INDEX` now
  (brief metadata lock + scan) or let queries keep choosing a bad plan.
- **Temp space exhaustion under concurrent sorts:** Raise `TempCacheLimit`
  (risking OS memory pressure) or throttle report queries spilling to disk.
- **Unindexed foreign key on child table:** Add the supporting index online or
  suffer table-scan lock waits on parent deletes.
