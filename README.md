# FBSimCity

**An explorable city that shows how Firebird actually works.**

🔗 **Live: [mariuz.github.io/FBSimCity](https://mariuz.github.io/FBSimCity/)**

![FBSimCity v0.9.0 under cache thrash: 16 page buffers against a hot set of 40, cache hit ratio down to 34%, and the latency panel showing where a query's time actually goes — parse and compile 47%, page cache 22%, disk reads 19%](docs/screenshot.png)

FBSimCity is an interactive isometric city where every building is a real
Firebird subsystem and every glowing particle is a query making its commute:
in through the client harbor, through the SQL translator, into the relational
engine, and back home carrying results. It is aimed at engineers who know SQL
but have never seen what happens *under* it — why a long-running transaction
makes a Firebird database slow down, what the famous OIT/OAT/Next counters in
`gstat -h` mean, why sweep matters, and how Firebird survives crashes without
a write-ahead log.

Inspired by [PGSimCity](https://github.com/NikolayS/PGSimCity) (the same idea
for PostgreSQL). The architectural block base comes from the paper
[**Conceptual Architecture for Firebird**](https://github.com/mariuz/conceptual-architecture-for-firebird-paper)
by Hubert Chan and Dmytro Yashkir (University of Waterloo), extended by Popa
Adrian Marius — Firebird as a top-level **pipe-and-filter** system:

```
clients ⇄ REMOTE (Y-valve) ⇄ DSQL (SQL → BLR) ⇄ JRD (engine) — LOCK manager
```

## The city map

| District / building | Subsystem | What you see |
|---|---|---|
| Client Harbor | REMOTE | Queries arrive over TCP/IP and XNET; results ship back out |
| Y-Valve Gate | Y-valve | Every attachment is dispatched to the right provider |
| Lexer, Parser, BLR Generator | DSQL | SQL particles (cyan) become BLR particles (violet) |
| Security Gatehouse | SCL | Authentication and ACLs before entering the engine |
| Metadata Library | MET | The RDB$ system tables the compiler consults |
| Compiler & Optimizer | CMP | BLR becomes an optimized execution tree |
| Execution Hall | EXE | The heart of JRD — interprets the request tree |
| B-Tree Gardens | BTR | Index retrievals with prefix-compressed keys |
| Sort Yard | SORT | External merge sort for ORDER BY / GROUP BY |
| Transaction Hall | TRA | TIP pages; live **Next / OAT / OIT** counters on the facade |
| Lock Manager Tower | LOCK | Shared-memory lock table; writers queue, deadlock victims roll back |
| Record Version Towers | VIO / MGA | Each UPDATE stacks a version; towers redden as chains grow |
| Sweep & GC Depot | GC | Cooperative GC plus the sweep truck touring the towers |
| Page Cache Plaza | CCH | Buffer slots flash green (hit) / red (miss) / yellow (dirty) |
| Database File excavation | PIO | Careful writes — no WAL — keep the file consistent |
| Journal Yard | REPL | Committed changes journalled into segments, sealed and queued |
| Replicator | REPL | Ships segments; async trails, sync makes commits wait |
| Replica Database | REPL | A second database replaying the journal in commit order |
| gbak Depot | GBAK | Logical backup; its snapshot pins the OIT for the whole run |
| nbackup Vault | NBACKUP | Physical backup by level; L0 full, L1 changed pages only |
| Difference File pit | DELTA | Where writes divert while the database is locked |

## Things to try

- **Trace a query** (or press `G`): follow one UPDATE station by station —
  harbor, Y-valve, lexer, parser, BLR generator, security, compiler,
  execution, cache (hit or miss, with the detour to disk), lock manager,
  version towers, commit — with a narrated step mode and a camera that
  follows the particle.
- **Pick a scenario** from the control room: steady state, cache thrash,
  stuck OIT / version bloat, lock contention, rush hour, or sweep storm.
- **Flip on "Long-running transaction."** The OIT pins, the sweep truck is
  not allowed to demolish anything, and the version towers grow and turn
  red — Firebird's version of bloat. Flip it off and hit **Sweep now**.
- **Break the replica.** Firebird 4+ replication is *logical* — there is no
  WAL to ship, so committed changes are journalled into segments and replayed
  on the replica in commit order. Set the replica slow and watch lag build;
  set it unreachable and watch segments stack up in the yard. Then switch to
  **synchronous** and break it again: replication *stops itself*
  (`disable_on_error`) while commits carry on untouched — no hang, no error
  to the client, and a replica quietly rotting until someone notices.
- **Open the latency panel** (`Latency`) to see where a query's time actually
  goes — parse and compile, page cache, disk reads, sorting, lock waits,
  writing a version, commit, and replication send. Every bucket is charged
  from real elapsed time in the model and the parts are asserted to sum to
  the whole. Transit between districts is *excluded* and labelled: a real
  query does not walk anywhere, and a profile where the animation dominates
  would look authoritative while meaning nothing.
- **Squeeze sort memory.** `TempCacheLimit` decides which sorts fit in
  memory; the rest spill to temporary files, and you can watch the sorting
  bar grow as you turn it down.
- **Make an operator decision.** Four situations where Firebird hands you a
  genuinely hard call — an idle transaction blocking sweep, a backup holding
  the OIT through peak, a forgotten nbackup lock growing its delta, a dead
  replica whose journal segments are filling the volume. Both
  answers cost something, and the verdict is measured from what actually
  happened in the model: how many versions were collected, how many page
  writes the merge cost, what the hit ratio did while it ran.
- **Run the nightly gbak** from the backup yard while the city is busy, and
  watch the OIT pin itself to gbak's snapshot for the whole run — the reason
  a nightly backup and a bloating database are so often the same story.
- **Lock the database** (nbackup `-L`) and watch every page write divert into
  the orange difference-file pit, then merge back on unlock.
- **Shrink the page cache** to 16 pages and watch the hit ratio fall while
  queries detour down into the database-file excavation — and the *dirty*
  eviction counter start climbing, because a reader now has to write
  somebody else's page out before it can reuse the frame.
- **Raise the write mix** and watch lock waits climb at the tower — with the
  occasional deadlock victim sent home (red particle).
- **Rush hour ×60** floods the harbor with a burst of queries.
- Take the **guided tour** for a narrated walk down the pipeline.
- Open **Page anatomy** (`P`) for a labeled diagram of a Firebird data page
  and the record version chain.
- **Click the Record Version Towers** to open the live chain inspector: the
  busiest table's versions with their writing transaction ids, marked
  reachable or garbage against the live OIT.
- Prefer text? **[The life of a query](https://mariuz.github.io/FBSimCity/lifecycle.html)**
  is the same journey as an accessible, keyboard-navigable page — no canvas,
  works with a screen reader.
- **Want the real thing?** The
  [machine room](https://mariuz.github.io/FBSimCity/machine/) runs the actual
  Firebird engine on the page — [Electric Firebird](https://github.com/mariuz/electric-firebird)
  compiles it to WebAssembly the way PGlite does for PostgreSQL. Type SQL at
  it, or run one of six guided sequences that each end in a number you can
  hold against something the city draws.
- **No mouse?** `Tab` and `Shift+Tab` step through every subsystem in pipeline
  order, opening each panel and announcing it to a screen reader.
- Switch to the **daylight theme** (`D`), pause the world (`space`), or run
  it at 4× speed. Press `?` for all shortcuts.
- **Deep-link a state**: `?scenario=stuckoit&theme=day&warp=50&panel=mvcc&lock=1`
  applies a scenario (`steady`, `thrash`, `stuckoit`, `locks`, `rush`,
  `sweepstorm`, `nightlygbak`, `nbackup`, `replicalag`, `syncstall`), picks a
  theme, opens a dock (`dock=latency` or `dock=decisions`), fast-forwards the
  simulation, opens a building's info panel and can leave the database
  locked — handy for sharing a reproducible view (the README screenshot is
  exactly
  [this link](https://mariuz.github.io/FBSimCity/?scenario=thrash&warp=90&dock=latency)).

## The machine room — the real engine, in the page

**[mariuz.github.io/FBSimCity/machine/](https://mariuz.github.io/FBSimCity/machine/)**

The city is a model. The [machine room](machine/) is the other thing: the
actual Firebird embedded engine compiled to WebAssembly by
[Electric Firebird](https://github.com/mariuz/electric-firebird), running in a
worker on the page, with a SQL workbench and six guided sequences that each
end in a number you can hold against something the city draws.

| Sequence | What the engine is asked | What it settles |
|---|---|---|
| Every statement gets a transaction | `CURRENT_TRANSACTION`, twice | The Transaction Hall's per-query id is the engine's behaviour, not a device |
| OIT, OAT and Next | `MON$DATABASE` | The three markers over the yard are columns in a monitoring table |
| An UPDATE writes a version | `MON$RECORD_STATS` back-version reads and purges | The towers grow floors because the engine really does keep the old rows |
| The catalogue is ordinary tables | `RDB$RELATIONS` | Metadata is a district, not a special mechanism |
| A fetch is not a read | `MON$IO_STATS` fetches against reads | The cache plaza is exactly this distinction |
| No write-ahead log | `MON$DATABASE` settings | Page size, buffers, sweep interval, forced writes — and no log setting, because there is no log |

Every verdict is computed from what came back, so a sequence can report that
the answer was *not* what was expected. The page also states plainly what the
runtime cannot show — one attachment means no lock waits to watch, there is no
replica, and `gbak`/`nbackup` are separate programs against a file that does
not exist here.

The engine is loaded from Electric Firebird's published build at the same
origin, so no WebAssembly is vendored into this repository and the city itself
still makes no network calls at all. Getting it to run inside the page needs
`SharedArrayBuffer`, which needs cross-origin isolation, which GitHub Pages
cannot grant — a service worker supplies the headers. v0.8.0 claimed this
embed was impossible; it was wrong, and [engine.html](engine.html) records why.

## Found something wrong?

Every building panel and the latency view carry a **report** link that opens
a pre-filled issue. No analytics or tracking is attached to those links, or
to anything else — the city makes no network calls at all.

Corrections get acted on rather than filed. The whole replication model was
rewritten in v0.6.1 after Dmitry Sibiryakov pointed out on firebird-general
that a synchronous replica which dies does not hang commits — it stops
replicating and lets them through. He was right, the source agreed with him,
and [docs/KNOBS.md](docs/KNOBS.md) records the error rather than quietly
erasing it.

## What it is (and isn't)

The simulation implements honest scaled-down mechanics: multi-generational
record versions with per-table chains carrying real transaction ids, logical
replication that journals committed changes into segments and replays them in
commit order,
Next/OAT/OIT marker arithmetic, cooperative garbage collection plus interval
sweep, an LRU page cache with forced-write flushing at commit and a write
charge for dirty evictions, gbak and nbackup with difference files, and lock
waits with deadlock rollbacks. Numbers are scaled so changes stay
human-observable.

It is **not** an emulator: no SQL is parsed, no Firebird code runs in your
browser, and plenty of subtlety (commit-order snapshots, precedence graphs of
careful writes, savepoints, two-phase commit…) is simplified. Treat it as
intuition, not documentation — corrections welcome via issues and PRs.

**[docs/KNOBS.md](docs/KNOBS.md) audits every control**: what it does to the
model, and whether the mechanism is real, merely scaled, or a plausible
stand-in — plus the deliberate simplifications, listed so nobody has to
discover them by reading the source, and a section on where the model is
*kinder* than Firebird and where it is *harsher*, since divergence runs both
ways.

Animation respects `prefers-reduced-motion`: the pulsing, the sweeping lock
beacon and the blinking OIT warning stop, while everything that carries
information — colours, counters, particle movement — stays.

## Running locally

No build step, no dependencies — plain HTML, CSS and JavaScript on a 2D
canvas. Serve the directory with any static server:

```bash
python -m http.server 8000
```

then open <http://localhost:8000/>.

## Code layout

- `js/data.js` — the world: buildings, districts, descriptions (from the
  paper), roads, tour script
- `js/sim.js` — the Firebird behavioral model (no rendering)
- `js/render.js` — isometric canvas renderer (*structure is matte, meaning
  is neon*)
- `js/ui.js` — control room, stats bar, info panel, guided tour
- `js/main.js` — bootstrap, input, main loop
- `js/camera.js` — camera arithmetic: zoom anchoring and touch gestures,
  split out so it can be tested without a canvas or a touchscreen
- `lifecycle.html` — the accessible text walk of the pipeline
- `machine/` — the machine room: the real engine, a SQL workbench and the
  guided sequences that check the city against it
- `engine.html` — what Electric Firebird is, and where the model is knowingly
  wrong
- `docs/KNOBS.md` — knob audit: what every control really does
- `test/` — the test suite (open `test/index.html`; no framework, no build)
- `tools/screenshot.ps1` — regenerates `docs/screenshot.png` from a deep link

## Tests

Open [`test/index.html`](test/) in a browser. It runs the real simulation and
asserts against the real DOM and the real docs — no framework, no build step,
nothing to install.

Most of the suite exists to catch **drift**. It checks that every control in
the UI is documented in `docs/KNOBS.md` and that every documented knob
produces a measurable change in the model; that every scenario in the picker
appears in the README; that `js/sim.js` never reaches for the DOM, the canvas
or the render layer, because it is documented as pure; that both answers to
every operator decision produce different, measured verdicts; and that the
colour pairs carrying meaning — cache hit versus miss, SQL versus BLR — stay
distinguishable, including under simulated deuteranopia.

That last check earned its keep immediately: it found that the hit and miss
flashes had a contrast ratio of 1.18, meaning they differed in hue but barely
in brightness. They now differ in hue, luminance *and* size.

It also checks that the **readouts agree with the model** — the stats bar is
generated text, and text is easy to leave behind when the model moves — that
the throughput figure is within reach of an independently counted number of
completed queries rather than an estimate that can wander, and that the camera
keeps whatever you zoomed towards under the point you zoomed at, including for
pinch gestures and for a third finger landing mid-pinch.

**Camera:** drag to pan, scroll or pinch to zoom, arrow keys to pan, `+` / `−`
to zoom. There is no rotation — the city is a fixed isometric projection.

## Credits

- Architecture: [Conceptual Architecture for Firebird](https://github.com/mariuz/conceptual-architecture-for-firebird-paper)
  — Hubert Chan & Dmytro Yashkir, updated and extended by Popa Adrian Marius
- Idea & inspiration: [PGSimCity](https://github.com/NikolayS/PGSimCity) by
  Nikolay Samokhvalov
- [Firebird](https://firebirdsql.org/) — the wonderful database this city
  is a scale model of

## License

MIT — see [LICENSE](LICENSE).

FBSimCity is an independent educational project and is not affiliated with
or endorsed by the Firebird Project. Firebird® is a registered trademark of
the Firebird Foundation Incorporated.
