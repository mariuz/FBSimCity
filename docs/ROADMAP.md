# Roadmap

Planned improvements to **FBSimCity**, grouped into four areas:

1. **[Engine Accuracy (`js/sim.js` vs `src/jrd/`)](#part-1--engine-accuracy-jssimjs-vs-srcjrd)** — closing the gap between [`js/sim.js`](../js/sim.js) and Firebird's actual C++ implementation in `src/jrd/`.
2. **[Simulation & Interactive Features](#part-2--simulation--interactive-features)** — new districts, controls, scenarios, and tighter integration with the [`firebird-wasm`](https://github.com/mariuz/electric-firebird) engine in the [machine room](../machine/).
3. **[Rendering & Visual Readouts (`js/render.js`)](#part-3--rendering--visual-readouts-jsrenderjs)** — sharper isometric picking, depth sorting, and on-canvas subsystem visualisations.
4. **[Interface & UX (`js/ui.js`, `css/style.css`)](#part-4--interface--ux-jsuijs-cssstylecss)** — non-overlapping panels, custom query tracing, time-series scrubbing, and shareable deep-links.

Every accuracy item in Part 1 corresponds to a simplification currently recorded in
[`docs/KNOBS.md`](KNOBS.md).

---

## Part 1 — Engine Accuracy (`js/sim.js` vs `src/jrd/`)

### 1. [x] Real OIT / OAT / OST progression & gap-triggered sweep (`tra.cpp`, `vio.cpp`) — *Completed*
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

### 2. [x] Back-version chain traversal cost for readers (`VIO_chase_record_version`) — *Completed*
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

### 3. [x] Cooperative vs background garbage collection (`GCPolicy`) — *Completed*
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

### 4. [x] Careful writes precedence graph & `Forced Writes` switch (`cch.cpp`, `pio`) — *Completed*
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

### 5. [x] Real per-table lock queues, `WAIT` / `NO WAIT`, and wait-for cycles (`lock.cpp`) — *Completed*
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

### 6. [x] Cost-based optimizer choice & index selectivity (`opt.cpp`, `btr.cpp`) — *Completed*
- **Today in `sim.js`:** Whether a `SELECT` visits `B-Tree Gardens` or the
  `Sort Yard` is a 50/50 coin flip.
- **In Firebird (`src/jrd/opt.cpp`):** The optimizer inspects index
  selectivity (`RDB$STATISTICS`) and query predicates to choose between index
  bitmap scans (`Index … Scan -> Bitmap -> Table Access By ID`), navigational
  index walks, or natural scans followed by an external merge sort.
- **Improvement:** Tie index vs natural-scan-plus-sort routing to table index
  selectivity (including stale statistics after bulk writes and `SET STATISTICS
  INDEX`).

### 7. [x] Commit-order snapshots (`READ COMMITTED READ CONSISTENCY` in Firebird 4+) — *Completed*
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

### 8. [x] Prepared statement cache (`StatementCacheSize`) — *Completed*
- **Why:** Currently every particle walks `Lexer → Parser → BLR Generator →
  Compiler & Optimizer`, so `Parse & compile` takes ~47% of every query's work
  time. Since Firebird 3.0+ (and `firebird-wasm`'s 64-entry statement cache and
  `db.prepare()`), repeated statements hit the compiled statement cache and
  jump straight from `Y-Valve Gate` to `Execution Hall` with pre-compiled BLR.
- **What you will see:** A **Statement cache** slider (`off` .. `100% hit`).
  Cached particles turn violet at the Y-valve and take a shortcut expressway
  straight to `Execution Hall`, collapsing the `Parse & compile` bar in the
  Latency panel.

### 9. [x] Server architecture switch: SuperServer vs Classic / SuperClassic — *Completed*
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

### 10. [x] Live telemetry bridge from the Machine Room (`firebird-wasm` 0.12.0) — *Completed*
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

### 11. [x] Additional Operator Decisions — *Completed*
- **Stale index statistics after bulk load:** Run `SET STATISTICS INDEX` now
  (brief metadata lock + scan) or let queries keep choosing a bad plan.
- **Temp space exhaustion under concurrent sorts:** Raise `TempCacheLimit`
  (risking OS memory pressure) or throttle report queries spilling to disk.
- **Unindexed foreign key on child table:** Add the supporting index online or
  suffer table-scan lock waits on parent deletes.

---

## Part 3 — Rendering & Visual Readouts (`js/render.js`)

### 12. [x] Exact isometric polygon hit-testing & per-tower MVCC inspection — *Completed*
- **Today in `render.js`:** `pick()` tests a 2D axis-aligned bounding box
  (`x0..x1`, `y0..y1`) around the 8 projected vertices of each building, and
  only attaches `building` metadata to the first `Record Version Tower`
  (`i === 0 ? m : null`). Clicking near diagonal edges of adjacent buildings
  (`lexer` / `parser` / `blrgen`) or clicking one of the other 11 MVCC towers
  either mis-picks a neighbour or opens the generic `mvcc` building card.
- **Improvement:**
  - Replace the 2D AABB check in `pick()` with point-in-polygon tests against
    the three visible isometric quads (top, left, right faces) in reverse
    painter order.
  - Make each of the 12 `Record Version Towers` (`s.tables[0..11]`) individually
    hoverable and clickable, showing a tooltip and inspector breakdown of that
    table's current version count, oldest `minTx`, and how many versions are
    eligible for GC (`tx < OIT`).

### 13. [x] Discrete version-slab rendering on `Record Version Towers` — *Completed*
- **Today in `render.js`:** Each tower in `Record Version Towers` is drawn as a
  single solid-coloured box of height `0.5 + t.versions * 0.28` that shifts
  uniformly from blue to amber to red as `t.versions` grows.
- **Improvement:** Render each record version as a stacked horizontal slab (like
  floors of a skyscraper), colouring the primary head version cyan/blue,
  visible snapshot back-versions (`tx >= OIT`) amber, and dead unreachable
  back-versions (`tx < OIT`) crimson. When cooperative GC or the sweeper cleans
  a table, the dead bottom slabs visibly crumble/dissolve while live slabs
  settle down.

### 14. [x] On-canvas subsystem micro-visualisations (`btr`, `sort`, `lock`, `cache`) — *Completed*
- **Today in `render.js`:** Several key districts (`B-Tree Gardens`, `Sort Yard`,
  `Lock Manager Tower`) are rendered as static decorative roofs whose visual
  state barely changes under load.
- **Improvement:**
  - **`B-Tree Gardens` (`btr`):** Draw a glowing root → internal → leaf node
    fanout tree on the garden terrace that lights up the traversed path whenever
    a `SELECT` particle performs an index lookup (and flashes an index-split
    pulse on heavy `UPDATE`/`INSERT` traffic).
  - **`Sort Yard` (`sort`):** Render merge-sort run stacks in the yard; when
    concurrent sorts exceed `TempCacheLimit`, draw an animated spill chute sending
    temporary run blocks down to `Disk & OS Cache` (`pio`).
  - **`Lock Manager Tower` (`lock`):** Render waiting writer particles orbiting
    or queued in holding bays around the tower base, and draw glowing red
    wait-for arcs between contending transactions when a deadlock cycle forms.
  - **`Page Cache Plaza` (`cache`):** Overlay LRU heat borders on hot slots, a
    pin icon on buffers currently held by an active cursor, and brief precedence
    arcs between dirty slots when `flushDirty` writes ordered pages to `pio`.

### 15. [x] Particle motion trails, shape encoding, and topological depth sorting *(Completed)*
- **Today in `render.js`:**
  - Queries are plain circles distinguished only by fill colour (`SELECT` blue,
    `UPDATE` orange, `ROLLBACK` red), which is harder to distinguish under
    colour-vision deficiency or at high `Time warp` (`2×` / `4×`).
  - `collectDrawables()` sorts buildings and particles by a single scalar sum
    (`key = x + w + y + d`), which can occasionally cause particles on adjacent
    roads to clip through elongated building facades (`Transaction Hall` or
    `Page Cache Plaza`).
- **Improvement:**
  - Give particles short tapered motion tails and distinct silhouettes / badges
    (circle for `SELECT`, diamond/chevron for `UPDATE`, hollow ring for
    `Sweep`, X-burst for `ROLLBACK` / deadlock abort).
  - Use an isometric interval / topological depth sort so road particles never
    clip behind buildings that are geometrically behind them.

---

## Part 4 — Interface & UX (`js/ui.js`, `css/style.css`)

### 16. [x] Unified right-hand inspector drawer & collision-free dock layout *(Completed)*
- **Today in `ui.js` & `style.css`:**
  - `#info-panel` and `#decide-dock` both anchor at `top: 60px; right: 12px` and
    forcibly close each other when opened, so you cannot read a building's
    `src/jrd/` notes while evaluating an Operator Decision.
  - `#latency-dock` (`left: 12px; bottom: 46px`) overlaps the bottom of
    `#controls` (`top: 60px; left: 12px`) on viewports shorter than ~820 px.
- **Improvement:** Consolidate the right-hand overlays into a docked,
  collapsible inspector rail with tabs (**District Info**, **Decisions**,
  **Latency**, **Trace**) and allow panels to stack cleanly without covering
  `#controls` or the city center.

### 17. [x] Selectable query trace profiles & step-by-step replay controls *(Completed)*
- **Today in `ui.js`:** Clicking **Trace** (`#btn-trace`) always spawns a
  generic `UPDATE` (`spawnQuery(s, true)`) with `deadlock = false`, and the
  trace bar only follows the particle in real time until it exits.
- **Improvement:**
  - Add a trace selector dropdown next to **Trace**:
    - *`SELECT` (Index lookup via `B-Tree Gardens`)*
    - *`SELECT` (Natural scan + `Sort Yard` merge)*
    - *`UPDATE` (Cache miss + dirty-page mark + TIP commit)*
    - *`UPDATE` (Lock wait / deadlock rollback at `Lock Manager Tower`)*
  - Add **Step back / Step forward / Pause at next district** buttons on the
    `#trace-bar` so learners can freeze the city at each stage of a query's life
    and click directly into that building's C++ source references.

### 18. [x] Expandable time-series telemetry drawer & hover readouts *(Completed)*
- **Today in `ui.js`:** The bottom `#stats` bar draws three `64×18` px
  sparklines (`#sp-qps`, `#sp-hit`, `#sp-vers`) with no axis labels, hover
  values, or correlation view.
- **Improvement:** Allow clicking any metric in `#stats` to expand a
  time-series telemetry drawer plotting synchronized 3-minute histories of
  **QPS**, **Cache hit %**, **OIT / OAT / OST gap**, **Total record versions**,
  and **p50 / p95 latency**, complete with vertical markers showing where a
  scenario started, a sweep ran, or an Operator Decision was applied.

### 19. [x] One-click "Copy shareable link" button & live URL sync *(Completed)*
- **Today in `ui.js`:** `applyDeepLink()` supports rich URL parameters
  (`?scenario=...&theme=...&warp=...&panel=...&dock=...&lock=1`), and the
  machine room supports `?seq=...`, but there is no button in the UI to export
  the current simulation state as a shareable link.
- **Improvement:** Add a **Share / Copy link** button in `#topbar` that serialises
  the active scenario, theme, time warp, open dock/panel, and slider overrides
  into the URL (`history.replaceState`) and copies it to the clipboard with a
  toast confirmation.

### 20. [x] District quick-jump bar & responsive mobile bottom-sheet layout *(Completed)*
- **Today in `style.css`:** On narrow/tablet screens (`< 900 px`), `#topbar nav`
  and `#stats` wrap into multiple rows, leaving a cramped viewport between the
  floating `#controls` and `#info-panel` overlays.
- **Improvement:**
  - Add a compact keyboard/click **District jump bar** (`1–9` hotkeys or pill
    strip) that smoothly pans and zooms the camera to any of the 15 engine
    buildings.
  - On narrow viewports, collapse `#controls` and `#info-panel` into swipeable
    bottom sheets so the isometric canvas keeps full screen height.

---

## Part 5 — Engine Accuracy & `firebird-wasm` `0.13.0+` Integration (`js/sim.js`, `machine/`)

### 21. Live `db.sweep()`, `db.introspect()`, and Firebird 6 schema-qualified plan bridge (`firebird-wasm` `0.13.0`)
- **What `firebird-wasm` `0.13.0` adds:**
  - `db.sweep()` (`isc_dpb_sweep` via `IAttachment`): invokes garbage-collection
    sweep directly inside the WebAssembly engine and advances `OIT` to `OST`.
  - `db.introspect()` & `migrate()`: queries `RDB$RELATIONS`,
    `RDB$RELATION_FIELDS`, and `RDB$INDICES` to return structured catalog
    metadata.
  - Firebird 5.0 LTS & Firebird 6.0 WASM build matrix, where Firebird 6 plans
    emit schema-qualified identifiers (`Table "PUBLIC"."MGA_DEMO"`) and
    `db.databaseInfo()` normalizes `OAT`/`OST` to `OIT` before the first
    transaction starts.
- **Improvement:**
  - Add a **Sweep** button (`#sweep` calling `db.sweep()`) and an **Introspect
    catalog** sequence (`db.introspect()`) in `machine/`, broadcasting sweep and
    catalog telemetry over `BroadcastChannel('fbsimcity-telemetry')` so the
    city's sweep truck and `Metadata Library (RDB$)` react in real time.
  - Parse Firebird 6 schema-qualified table names (`"PUBLIC"."TABLE"`) in
    `Sim.spawnExplainedQuery()` and map them deterministically to the city's 12
    tables (`T0..T11`).

### 22. Cursor batch streaming (`PreparedStatement.queryStream()`) & segmented BLOB I/O (`IBlob`)
- **Today in `sim.js`:** Every `SELECT` returns a single monolithic result
  particle from `Execution Hall` → `Y-Valve Gate` → `Client Harbor`, and BLOB
  pages are not distinguished from regular data pages.
- **Improvement:**
  - Model `PreparedStatement.queryStream({ fetchSize })` (`firebird-wasm`
    `0.13.0`): long-running cursor queries hold their snapshot (`OST`) open
    while emitting a train of smaller batch-fetch sub-particles between `EXE`,
    `Y-VALVE`, and `REMOTE`.
  - Model segmented BLOB reads/writes (`openBlobStream` / `createBlobStream` in
    `src/jrd/blb.cpp`): large payloads allocate dedicated BLOB pages on the
    `Database File (PIO)` and stream segments without evicting hot relational
    index pages.

### 23. Durable write-queue (`FB_WRITE_QUEUE$`) & optimistic pre-image rollback modeling
- **What `firebird-wasm` `0.13.0` adds:** `createWriteQueue()` persists pending
  offline mutations in `FB_WRITE_QUEUE$` and rolls back local optimistic
  state using captured pre-images when a server conflict occurs.
- **Improvement:** Add an optional **Local-first write queue** mode at `Client
  Harbor` showing mutations staged in `FB_WRITE_QUEUE$`, flushed in ordered
  batches through `Y-Valve Gate`, and rolled back cleanly via pre-image
  restoration when a conflict or `NO WAIT` abort occurs.

### 24. Firebird 5.0 parallel sweep / index workers & Firebird 6.0 SQL schemas (`PUBLIC`)
- **Today in `sim.js`:** Sweep is always a single truck touring `T0..T11`
  sequentially over 4 seconds, and `Metadata Library` treats all tables as a
  flat namespace.
- **Improvement:**
  - Model Firebird 5.0's `ParallelWorkers` (`firebird.conf`): allow `1–4`
    parallel sweep / index-build workers that divide the 12 `Record Version
    Towers` concurrently, cutting sweep duration at the cost of higher `Page
    Cache Plaza` & `Database File` I/O pressure.
  - Display Firebird 6.0 `SCHEMA` namespaces (`PUBLIC`, `APP`, `AUDIT`) in the
    `Metadata Library (RDB$)` and `Compiler & Optimizer (CMP)` inspector panels.

---

## Part 6 — Next-Gen 3D Rendering: Three.js & WebGPU (`js/render-webgpu.js`, `js/render.js`)

### 25. Pluggable Three.js `WebGPURenderer` backend with seamless WebGL2 / Canvas2D fallback
- **Today in `render.js`:** The entire city is drawn in immediate-mode 2D
  Canvas (`ctx.beginPath` / `ctx.fill` per prism face), which limits lighting,
  shadows, and high-entity counts.
- **Improvement:**
  - Introduce a clean renderer adapter (`Render.setBackend("webgpu" | "canvas2d")`)
    backed by **Three.js `WebGPURenderer`** (automatically falling back to
    `WebGLRenderer` or the zero-dependency `Canvas2D` renderer when WebGPU is
    unavailable or in headless tests).
  - Match the orthographic isometric projection (`Render.TW = 20`,
    `Render.TH = 10`, `Render.TZ = 14`) 1:1 so `Camera`, `Render.pick`, and
    `Render.pickTower` coordinates stay identical across 2D and 3D modes.

### 26. GPU-instanced version slabs, cache buffers, and particles (`THREE.InstancedMesh` + WebGPU storage buffers)
- **Today in `render.js`:** Every cache slot (`128`), version slab (`12 × 26`),
  and particle (`300`) issues separate CPU path calls every frame.
- **Improvement:**
  - Batch all `Record Version Tower` slabs, `Page Cache Plaza` slots, `Database
    File` page cells, and query particles into `THREE.InstancedMesh` (and
    WebGPU storage/instance buffers updated via typed arrays), supporting
    `5,000+` concurrent particles at `120 fps` with zero per-frame garbage
    allocation.

### 27. TSL (Three.js Shading Language) procedural shaders, soft shadows & emissive bloom
- **Improvement:**
  - Use Three.js Node Material / TSL shaders for:
    - Animated data-bus road lanes and `StatementCacheSize` expressway pulses,
    - Emissive selective bloom on `SQL` (cyan), `BLR` (violet), `Result`
      (emerald), and `Rollback` (crimson) particles (automatically toned down in
      Daylight and `prefers-reduced-motion` modes),
    - Real-time directional sun / moon shadow maps across the 12 `Record
      Version Towers` so tower height (version bloat) casts physical shadows
      across the JRD district.

---

## Part 7 — Code Review Findings & Architecture Hardening (`js/sim.js`, `js/ui.js`, `js/render.js`)

### 28. Deterministic PRNG seeding (`Sim.create({ seed })`), state serialization & zero-allocation hot loops
- **Code review findings in `sim.js` & `render.js`:**
  1. `sim.js` calls `Math.random()` directly in 16 places (`pickPage`,
     `pickTable`, `spawnQuery`, `arrive`), making exact bug reproduction and
     seeded replay impossible.
  2. `moveParticles()` and `collectDrawables()` allocate fresh objects and
     arrays (`s.particles.filter(...)`, `list.push(boundsOf({...}))`) on every
     60 Hz frame.
- **Improvement:**
  - Replace direct `Math.random()` calls in `sim.js` with a fast seedable PRNG
    (`mulberry32` stored on `s.rng`, defaulting to random seed when omitted) so
    any simulation run or test failure can be replayed deterministically from a
    seed in the share URL (`?seed=...`).
  - Reuse pre-allocated drawable pools and in-place compaction in
    `moveParticles()` to eliminate 60 Hz GC pauses.

### 29. DOM construction safety (`replaceChildren` vs `innerHTML`), CSP hardening & Web Worker simulation option
- **Code review findings in `ui.js` & `index.html`:**
  1. `ui.js` rebuilds `#info-body`, `#decide-body`, `#latency-body`, and
     `#event-log` via string concatenation and `innerHTML` inside `updateStats()`
     (every frame/tick when open), whereas `machine/machine.js` already uses
     safe `document.createElement` + `replaceChildren()`.
  2. `updateStats()` re-renders `#event-log` `innerHTML` on every frame even
     when `s.log` has not changed since the last frame.
- **Improvement:**
  - Guard `#event-log`, `#chain-live`, `#lock-live`, and `#opt-live` updates
    behind dirty-version checks so DOM nodes are only touched when model state
    changes.
  - Replace dynamic `innerHTML` string assembly with structured DOM builders
    and add a strict `<meta http-equiv="Content-Security-Policy">` header.

---

## Part 8 — Google Chrome UX, Core Web Vitals & Modern Web Platform Practices (`index.html`, `css/style.css`, `js/ui.js`)

### 30. Native HTML `<dialog>` modals, Popover API, and keyboard focus management
- **Today in `index.html` & `ui.js`:** `#help-overlay` and `#anatomy-overlay`
  are `<div class="overlay hidden">` elements without native focus trapping,
  `aria-modal`, or browser `CloseWatcher` integration.
- **Improvement:**
  - Upgrade `#help-overlay` and `#anatomy-overlay` to native `<dialog>` elements
    using `.showModal()` / `.close()`, giving Chrome users automatic top-layer
    rendering, background `inert` focus trapping, and hardware/gesture `Escape`
    dismissal (`CloseWatcher`).
  - Use the native HTML `popover="auto"` API for quick glossary/metric tooltips
    on `#stats` counters.

### 31. View Transitions API, `ResizeObserver` (`devicePixelContentBoxSize`), and INP `< 16 ms` optimization
- **Today in `main.js` & `ui.js`:**
  - `frame()` checks `canvas.clientWidth` on every `requestAnimationFrame`
    tick (forcing synchronous layout reads in the render loop) instead of using
    `ResizeObserver`.
  - Switching tabs in `#inspector-rail` or scenarios snaps abruptly.
- **Improvement:**
  - Observe `#city` with `ResizeObserver` (reading `devicePixelContentBoxSize`
    when supported by Chrome for pixel-exact HiDPI rendering) and remove layout
    reads from `frame()`.
  - Wrap inspector tab switches and building panel transitions in
    `document.startViewTransition()` (with graceful fallback) and yield long
    decision fast-forwards (`runFor`) or heavy UI updates to keep Chrome's
    **Interaction to Next Paint (INP)** well under `16 ms`.

### 32. Chrome DevTools Performance Extensibility API (`performance.measure` tracks) & installable Offline PWA
- **Improvement:**
  - Instrument `Sim.tick` and `Render.draw` with Chrome DevTools Performance
    Extensibility markers (`performance.measure(..., { detail: { devtools: { dataType: 'track-entry', track: 'FBSimCity Engine' } } })`
    when enabled via `?devtools=1`), surfacing custom **Simulation** and
    **Isometric Render** flamechart tracks right inside Chrome DevTools
    Performance recordings.
  - Add `manifest.webmanifest`, `<meta name="color-scheme" content="dark light">`,
    and an offline-capable Service Worker so `FBSimCity` passes Chrome
    Lighthouse PWA / Best Practices / Accessibility audits at 100%.


