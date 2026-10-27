/* FBSimCity — simulation model.
 * Scaled-down but honest Firebird mechanics: MGA record versions,
 * Next/OAT/OIT transaction markers, cooperative GC + sweep, an LRU page
 * cache over a 400-page database file, and lock-manager waits.
 * No SQL is parsed and no Firebird code runs here — it's a model, not an
 * emulator.
 */
var Sim = (function () {
  "use strict";

  var PAGE_SPACE = 400;      // pages in the "database file"
  var TABLE_COUNT = 12;      // version towers
  var MAX_CHAIN = 26;        // display cap for a version chain

  function create() {
    var s = {
      // tunables (bound to UI)
      queryRate: 6,          // queries / second
      updateRatio: 0.35,     // fraction of queries that write
      cacheSize: 64,         // page buffers
      sweepEnabled: true,
      sweepInterval: 25,     // OST − OIT transaction gap threshold
      longTxn: false,

      // transaction counters
      next: 1000,
      oat: 999,
      ost: 999,
      oit: 999,
      pinned: null,          // id of the long-running txn, when active
      active: [],            // ids of in-flight write txns
      rolledBack: [],        // ids of rolled-back txns awaiting sweep

      // MVCC towers
      tables: [],
      totalVersions: 0,
      backversionReads: 0,   // MON$BACKVERSION_READS: delta steps walked by queries
      purges: 0,             // MON$RECORD_PURGES: dead back-versions removed by GC
      gcPolicy: "combined",  // combined | cooperative | background (firebird.conf GCPolicy)
      bgGcAcc: 0,

      // page cache: slots of {page, lastUse, flash, state}
      cache: [],
      hits: 0, misses: 0,
      hitRatio: 1,

      // stats
      qps: 0, done: 0, completed: 0, statTimer: 0,
      lockWaits: 0, rollbacks: 0,
      lockMode: "wait",      // wait | nowait (SET TRANSACTION WAIT / NO WAIT)
      deadlocks: 0,          // true wait-for cycle rollbacks
      noWaitAborts: 0,       // immediate conflict aborts under NO WAIT
      isolationMode: "read_consistency", // read_consistency | snapshot
      commitNumber: 1000,    // Firebird 4+ commit-order counter (CN)
      writeRestarts: 0,      // statement restarts on write conflict (READ CONSISTENCY)
      updateConflicts: 0,    // isc_update_conflict rollbacks (SNAPSHOT / CONCURRENCY)

      // sweep
      sweepTimer: 0, sweepActive: false, sweepProgress: 0, sweepBlocked: false,

      // run control
      paused: false, speed: 1,

      // cache bookkeeping & careful-writes precedence (src/jrd/cch.cpp)
      evictions: 0, dirtyEvictions: 0, pageWrites: 0,
      forcedWrites: true,    // MON$FORCED_WRITES: sync commit flush vs OS-buffered
      precedenceFlushes: 0,  // parent->child ordered flushes via CCH_precedence
      precedenceArcs: [],    // [{from, to, flash}] drawn over Page Cache Plaza
      flushAcc: 0,
      serverMode: "super",   // super | superclassic | classic (firebird.conf ServerMode)
      astCount: 0,           // blocking_ast_bdb cross-cache invalidations/flushes
      astArcs: [],           // [{slot, flash}] drawn from Lock Manager Tower to CCH

      // sort memory (Firebird's TempCacheLimit): sorts larger than this
      // spill to temporary files on disk
      tempCacheLimit: 40,
      sorts: 0, sortSpills: 0,
      indexScans: 0, naturalScans: 0, statsRecomputed: 0,
      stmtCacheRatio: 0,     // StatementCacheSize hit ratio (0..1)
      stmtCacheHits: 0,      // compiled statements reused without DSQL/CMP parse
      telemetryEvents: 0,    // live telemetry packets from firebird-wasm
      lastTelemetry: null,   // {sql, planText, info} from Machine Room / explain()

      // where completed queries actually spent their time, sampled over the
      // last LAT_SAMPLE trips rather than asserted
      lat: { samples: [], totals: null },

      // backup & recovery (gbak logical dump, nbackup physical levels)
      backup: {
        gbakActive: false, gbakProgress: 0, gbakTxn: null, gbakRuns: 0,
        nbActive: false, nbProgress: 0, nbLevel: 0,
        levels: [],            // completed nbackup levels: {level, at, pages}
        locked: false,         // nbackup -L: main file frozen
        deltaPages: 0, deltaFlash: 0,
        merging: false, mergeProgress: 0, mergeFrom: 0
      },

      // query trace
      tracedQ: null, traceStep: true, traceStage: null, traceNote: "",

      // logical replication (Firebird 4+): journal segments, shipped and
      // replayed on the replica in commit order
      repl: {
        mode: "async",        // off | async | sync
        health: "healthy",    // healthy | slow | down
        pending: 0,           // changes in the open segment
        segments: [],         // sealed segments awaiting apply, in order
        segNo: 1,
        generated: 0, applied: 0,
        disabled: false,      // disable_on_error tore replication down
        stops: 0,             // STOP_ERROR events
        flash: 0, applyAcc: 0
      },

      // operator decisions
      challenge: null,   // {id, at, snap} while a situation is live
      verdict: null,     // {id, choice, lines[], measuredFor} once answered

      // disk activity marker for the renderer
      diskFlash: 0, diskPos: 0.5,

      // entities
      particles: [],
      burstQueue: 0,
      spawnAcc: 0,

      time: 0,
      log: []
    };
    for (var i = 0; i < TABLE_COUNT; i++) {
      // chain[0] is the oldest version, chain[last] the current one;
      // each entry is the id of the transaction that wrote it (seeds sit
      // well below the initial markers, like rows loaded long ago).
      // selectivity models RDB$STATISTICS (1 / distinct keys): tables 0..7
      // carry selective indexes (< 0.12 -> B-Tree), while tables 8..11 carry
      // low-selectivity indexes (>= 0.12 -> natural scan + Sort Yard).
      var baseSel = i < 8
        ? +(0.005 + i * 0.008).toFixed(3)
        : +(0.18 + (i - 8) * 0.08).toFixed(3);
      s.tables.push({
        versions: 1, flash: 0, chain: [960 + i], gcFlag: false,
        lockHolder: null, waiters: [],
        selectivity: baseSel, statDrift: 0,
        lastCommitCn: 960 + i
      });
    }
    setCacheSize(s, s.cacheSize);
    say(s, "Database on line. Cache " + s.cacheSize + " pages, sweep interval " +
      s.sweepInterval + " txns.");
    return s;
  }

  /* The city is never empty on load.
   *
   * Without this a first-time visitor arrives at a database that has never
   * run: every cache slot empty, one version per tower, and OIT/OAT/Next
   * sitting exactly where they were initialised. That teaches nothing, and
   * worse, it teaches something false — a real Firebird database you open
   * has a history behind it. PGSimCity shipped the same defect and fixed it
   * the same way; ours was found by looking for it after reading theirs.
   *
   * Quiet, in two senses: the message log is restored afterwards, so the
   * first line the reader sees is the one about the database coming on line
   * rather than 25 seconds of backfill, and no challenge can open, because
   * challenges only ever start from an explicit call.
   */
  function warm(s, seconds) {
    var log = s.log.slice();
    var n = Math.round(Math.max(0, Math.min(120, seconds || 0)) * 60);
    for (var i = 0; i < n; i++) tick(s, 1 / 60);
    s.log = log;
    return s;
  }

  function say(s, msg) {
    s.log.push({ t: s.time, msg: msg });
    if (s.log.length > 6) s.log.shift();
  }

  function setCacheSize(s, n) {
    s.cacheSize = n;
    s.cache = [];
    if (s.precedenceArcs) s.precedenceArcs = [];
    if (s.astArcs) s.astArcs = [];
    for (var i = 0; i < n; i++) {
      // state drives the flash colour only; `dirty` is the real bookkeeping;
      // `dep` is the index of a cache slot that must be written to disk
      // before this slot (CCH_precedence careful-write dependency).
      s.cache.push({ page: -1, lastUse: 0, flash: 0, state: 0, dirty: false, dep: -1 });
    }
  }

  /* Check whether linking `fromIdx -> toIdx` would create a cycle in the
   * precedence graph (CCH_precedence). */
  function dependsOn(s, startIdx, targetIdx) {
    var cur = startIdx, steps = 0;
    while (cur >= 0 && cur < s.cache.length && steps < s.cache.length) {
      if (cur === targetIdx) return true;
      cur = s.cache[cur].dep;
      steps++;
    }
    return false;
  }

  /* Record a careful-write dependency: when a page is dirtied (e.g. a
   * pointer page or primary record pointing to a newly written back-version
   * page), link it to a previously dirtied buffer so the prerequisite page
   * is guaranteed to reach disk first. */
  function attachPrecedence(s, slotIdx) {
    var slot = s.cache[slotIdx];
    if (slot.dep >= 0 && slot.dep < s.cache.length && s.cache[slot.dep].dirty) return;
    slot.dep = -1;
    var bestIdx = -1, bestTime = -1;
    for (var i = 0; i < s.cache.length; i++) {
      if (i === slotIdx) continue;
      var c = s.cache[i];
      if (c.dirty && c.page >= 0 && !dependsOn(s, i, slotIdx)) {
        if (c.lastUse >= bestTime) {
          bestTime = c.lastUse;
          bestIdx = i;
        }
      }
    }
    if (bestIdx >= 0) slot.dep = bestIdx;
  }

  /* Flush a single cache slot in careful-write precedence order: if slot
   * `idx` depends on another dirty slot `dep`, flush `dep` to disk first so
   * no on-disk pointer ever dangles without a WAL. */
  function flushSlot(s, idx, visited) {
    if (idx < 0 || idx >= s.cache.length) return 0;
    var c = s.cache[idx];
    if (!c.dirty) { c.dep = -1; return 0; }
    if (!visited) visited = {};
    if (visited[idx]) return 0;
    visited[idx] = true;

    var count = 0;
    var dep = c.dep;
    c.dep = -1;
    if (dep >= 0 && dep < s.cache.length && s.cache[dep].dirty && !visited[dep]) {
      count += flushSlot(s, dep, visited);
      s.precedenceFlushes++;
      s.precedenceArcs.push({ from: idx, to: dep, flash: 1 });
      if (s.precedenceArcs.length > 16) s.precedenceArcs.shift();
    }
    c.dirty = false;
    pageWrite(s, c.page);
    return count + 1;
  }

  // Hot/cold page access: most traffic lands on a small working set, like a
  // real OLTP database. Default cache (64) covers the hot set; shrink it
  // below HOT_SET and the plaza starts thrashing.
  var HOT_SET = 40;
  function pickPage() {
    if (Math.random() < 0.88) return Math.floor(Math.random() * HOT_SET);
    return HOT_SET + Math.floor(Math.random() * (PAGE_SPACE - HOT_SET));
  }

  /* returns true on hit; on miss the page is faulted in (LRU eviction) */
  function cacheAccess(s, isWrite, attachment) {
    var page = pickPage();
    var startIdx = 0, endIdx = s.cache.length, i;
    if (s.serverMode !== "super" && s.cache.length >= 4) {
      var parts = 4;
      var att = (attachment !== undefined && attachment !== null)
        ? (attachment % parts)
        : Math.floor(Math.random() * parts);
      var partSize = Math.floor(s.cache.length / parts);
      startIdx = att * partSize;
      endIdx = (att === parts - 1) ? s.cache.length : (startIdx + partSize);
      // Cross-attachment cache coherence (blocking_ast_bdb in src/jrd/cch.cpp):
      // when another attachment caches this page and either side writes, the
      // Lock Manager delivers a blocking AST forcing the holder to flush and
      // release/downgrade its buffer first.
      for (i = 0; i < s.cache.length; i++) {
        if (i >= startIdx && i < endIdx) continue;
        var other = s.cache[i];
        if (other.page === page && (isWrite || other.dirty)) {
          s.astCount++;
          s.astArcs.push({ slot: i, flash: 1 });
          if (s.astArcs.length > 16) s.astArcs.shift();
          if (other.dirty) {
            flushSlot(s, i);
          }
          if (isWrite) {
            other.page = -1;
            other.dirty = false;
            other.dep = -1;
          }
        }
      }
    }
    var slot = null, slotIdx = -1, lru = null, lruIdx = startIdx;
    for (i = startIdx; i < endIdx; i++) {
      var c = s.cache[i];
      if (c.page === page) { slot = c; slotIdx = i; break; }
      if (!lru || c.lastUse < lru.lastUse) { lru = c; lruIdx = i; }
    }
    if (slot) {
      slot.lastUse = s.time;
      slot.flash = 1;
      slot.state = isWrite ? 3 : 1; // 1 hit, 3 dirty
      if (isWrite) {
        attachPrecedence(s, slotIdx);
        slot.dirty = true;
      }
      s.hits++;
      return true;
    }
    if (lru.page >= 0) {
      s.evictions++;
      // Evicting a DIRTY buffer is not free: the page (and any careful-write
      // prerequisite it depends on) must be written out before its frame can
      // be reused, so the reader pays for someone else's write.
      if (lru.dirty) {
        s.dirtyEvictions++;
        flushSlot(s, lruIdx);
      }
    }
    lru.page = page;
    lru.lastUse = s.time;
    lru.flash = 1;
    lru.state = 2; // miss / freshly faulted
    lru.dep = -1;
    if (isWrite) {
      attachPrecedence(s, lruIdx);
      lru.dirty = true;
    } else {
      lru.dirty = false;
    }
    s.misses++;
    s.diskFlash = 1;
    s.diskPos = page / PAGE_SPACE;
    return false;
  }

  /* Forced writes (the Firebird default): a commit does not return until its
   * pages (and their careful-write prerequisites) are safely on disk, so
   * committing cleans buffers as it goes. */
  function flushDirty(s, n) {
    var totalFlushed = 0;
    for (var i = 0; i < s.cache.length && n > 0; i++) {
      var c = s.cache[i];
      if (c.dirty) {
        totalFlushed += flushSlot(s, i);
        n--;
      }
    }
    return totalFlushed;
  }

  function tickCacheWriter(s, dt) {
    for (var i = s.precedenceArcs.length - 1; i >= 0; i--) {
      s.precedenceArcs[i].flash -= dt * 1.8;
      if (s.precedenceArcs[i].flash <= 0) s.precedenceArcs.splice(i, 1);
    }
    for (var j = s.astArcs.length - 1; j >= 0; j--) {
      s.astArcs[j].flash -= dt * 2.0;
      if (s.astArcs[j].flash <= 0) s.astArcs.splice(j, 1);
    }
    if (s.forcedWrites) { s.flushAcc = 0; return; }
    // When forcedWrites is off, dirty buffers linger in the cache and are
    // flushed periodically in batches by the background cache writer.
    s.flushAcc += dt * 1.2;
    if (s.flushAcc >= 1) {
      s.flushAcc -= 1;
      flushDirty(s, 1);
    }
  }

  /* A page leaves the cache for durable storage. While nbackup holds the
   * database locked, the main file is frozen and the write is diverted into
   * the difference (delta) file instead. */
  function pageWrite(s, page) {
    var b = s.backup;
    if (b.locked) {
      b.deltaPages++;
      b.deltaFlash = 1;
    } else {
      s.diskFlash = 1;
      s.diskPos = page / PAGE_SPACE;
      s.pageWrites++;
    }
  }

  function oldestVisible(s) {
    // versions older than the Oldest Snapshot (OST) may be garbage collected
    return s.ost;
  }

  /* The oldest transaction still holding the markers back. Either the
   * user's forgotten transaction or gbak's snapshot read — a logical backup
   * of a busy database holds back GC for as long as it runs, which is why
   * a nightly gbak and a bloating database are often the same story. */
  function holder(s) {
    var g = s.backup.gbakTxn;
    if (s.pinned !== null && g !== null) return Math.min(s.pinned, g);
    if (s.pinned !== null) return s.pinned;
    return g; // null when nothing is holding
  }

  function refreshMarkers(s) {
    var emptyFloor = s.next > 1000 ? s.next : 999;
    var floor = s.active.length ? Math.min.apply(null, s.active) : emptyFloor;
    var h = holder(s);
    s.oat = h !== null ? Math.min(h, floor) : floor;

    // OST (Oldest Snapshot): the oldest OAT observed when any still-running
    // transaction started (src/jrd/tra.cpp: tra_oldest_active).
    var snapFloor = s.oat;
    for (var i = 0; i < s.particles.length; i++) {
      var q = s.particles[i];
      if (!q.dead && q.snap !== null && q.snap !== undefined && q.snap < snapFloor) {
        snapFloor = q.snap;
      }
    }
    s.ost = snapFloor;

    // OIT (Oldest Interesting): stays pinned at the earliest unswept
    // rolled-back transaction on the TIP until sweep finishes a full pass
    // and advances hdr_oldest_transaction up to OST.
    var rbFloor = s.rolledBack.length ? Math.min.apply(null, s.rolledBack) : s.ost;
    s.oit = Math.min(rbFloor, s.ost);
  }

  /* Purging a dead record version modifies the data page in place, leaving
   * a resident cache buffer dirty (MON$PAGE_MARKS). */
  function markDirtyBuffer(s) {
    for (var i = 0; i < s.cache.length; i++) {
      var c = s.cache[i];
      if (c.page >= 0 && !c.dirty) {
        attachPrecedence(s, i);
        c.dirty = true;
        c.state = 3;
        c.flash = Math.max(c.flash, 0.55);
        return;
      }
    }
  }

  function coopGC(s, tableIdx, q) {
    // GCPolicy (src/jrd/vio.cpp):
    // - "background": readers only flag the page in gc_record bitmaps; a
    //   background GC thread cleans them asynchronously without stalling SELECTs.
    // - "cooperative": the reader purges dead back-versions (< OST) inline,
    //   paying the version-purge dwell and dirty-page mark itself.
    // - "combined": flags for background GC, and purges inline when chains grow.
    if (holder(s) !== null) return false;
    var idx = (tableIdx !== undefined && tableIdx !== null)
      ? tableIdx : Math.floor(Math.random() * TABLE_COUNT);
    var t = s.tables[idx];
    if (!(t.versions > 1 && t.chain[0] < s.ost)) return false;

    if (s.gcPolicy === "background") {
      t.gcFlag = true;
      return false;
    }
    if (s.gcPolicy === "combined") {
      t.gcFlag = true;
      if (t.versions < 4 && Math.random() >= 0.35) return false;
    }

    t.chain.shift();
    t.versions--;
    s.totalVersions--;
    s.purges++;
    t.flash = 0.6;
    if (t.versions <= 1 || t.chain[0] >= s.ost) t.gcFlag = false;
    markDirtyBuffer(s);
    if (q) q.dwell += 0.04;
    return true;
  }

  function tickBackgroundGC(s, dt) {
    if (s.gcPolicy === "cooperative" || holder(s) !== null) {
      s.bgGcAcc = 0;
      return;
    }
    s.bgGcAcc += dt * 10;
    while (s.bgGcAcc >= 1) {
      s.bgGcAcc -= 1;
      var cleaned = false;
      for (var i = 0; i < TABLE_COUNT; i++) {
        var t = s.tables[i];
        if (t.gcFlag && t.versions > 1 && t.chain[0] < s.ost) {
          t.chain.shift();
          t.versions--;
          s.totalVersions--;
          s.purges++;
          t.flash = Math.max(t.flash, 0.45);
          if (t.versions <= 1 || t.chain[0] >= s.ost) t.gcFlag = false;
          markDirtyBuffer(s);
          cleaned = true;
          break;
        }
      }
      if (!cleaned) { s.bgGcAcc = 0; break; }
    }
  }

  /* VIO_chase_record_version (src/jrd/vio.cpp): every query touching a row
   * with back versions must walk the delta chain to reconstruct or verify a
   * snapshot-visible version, fetching extra data pages when deep chains
   * spill off-page. */
  function chaseVersionChain(s, q, t) {
    var back = t.versions - 1;
    if (back <= 0) return;
    s.backversionReads += back;
    q.dwell += back * 0.025;
    t.flash = Math.max(t.flash, 0.45);
    var offPage = Math.floor(back / 5);
    var missed = false;
    for (var i = 0; i < offPage; i++) {
      if (!cacheAccess(s, false)) missed = true;
    }
    if (missed) {
      q.path.splice(q.idx + 1, 0, wp("pio", 0.16));
    }
  }

  // ---- per-table lock table & wait-for graph (src/jrd/lock/lock.cpp) ----

  /* Hot-table skew: in OLTP workloads, a few hot tables (0..2) receive the
   * majority of concurrent writes, where lock queues and deadlocks form. */
  function pickTable(isWrite) {
    if (isWrite && Math.random() < 0.68) {
      return Math.floor(Math.random() * 3);
    }
    return Math.floor(Math.random() * TABLE_COUNT);
  }

  function pruneLocks(s) {
    for (var i = 0; i < TABLE_COUNT; i++) {
      var t = s.tables[i];
      if (t.lockHolder && (t.lockHolder.dead || t.lockHolder.txn === null)) {
        t.lockHolder = null;
      }
      if (t.waiters.length) {
        t.waiters = t.waiters.filter(function (w) {
          return !w.dead && w.txn !== null && w.waiting;
        });
      }
      if (!t.lockHolder && t.waiters.length) {
        var nextQ = t.waiters.shift();
        t.lockHolder = nextQ;
        if (nextQ.locksHeld.indexOf(i) === -1) nextQ.locksHeld.push(i);
        nextQ.waiting = false;
        nextQ.waitingOn = -1;
        if (nextQ.dwell > 0.05) nextQ.dwell = 0.04;
      }
    }
  }

  /* Walk the wait-for graph starting from `holderQ`: if `holderQ` (or a
   * transaction holding `requesterQ.table` while queued on a relation held
   * by `requesterQ`) is waiting on a lock held by `requesterQ`, then making
   * `requesterQ` wait would form a deadlock cycle. */
  function detectDeadlockCycle(s, requesterQ, holderQ) {
    var cur = holderQ, steps = 0;
    while (cur && !cur.dead && cur.waitingOn >= 0 && steps < TABLE_COUNT) {
      var tbl = s.tables[cur.waitingOn];
      var nextHolder = tbl ? tbl.lockHolder : null;
      if (!nextHolder) break;
      if (nextHolder === requesterQ ||
          requesterQ.locksHeld.indexOf(cur.waitingOn) !== -1) {
        return true;
      }
      cur = nextHolder;
      steps++;
    }
    for (var i = 0; i < requesterQ.locksHeld.length; i++) {
      var heldIdx = requesterQ.locksHeld[i];
      var heldTbl = s.tables[heldIdx];
      if (!heldTbl) continue;
      for (var j = 0; j < heldTbl.waiters.length; j++) {
        var w = heldTbl.waiters[j];
        if (w && !w.dead && w !== requesterQ &&
            w.locksHeld.indexOf(requesterQ.table) !== -1) {
          return true;
        }
      }
    }
    return false;
  }

  function releaseLocks(s, q) {
    if (!q) return;
    if (q.waitingOn >= 0 && q.waitingOn < TABLE_COUNT) {
      var wt = s.tables[q.waitingOn];
      var wi = wt.waiters.indexOf(q);
      if (wi >= 0) wt.waiters.splice(wi, 1);
      q.waitingOn = -1;
      q.waiting = false;
    }
    for (var i = 0; i < TABLE_COUNT; i++) {
      var t = s.tables[i];
      if (t.lockHolder === q) {
        t.lockHolder = null;
        while (t.waiters.length) {
          var nextQ = t.waiters.shift();
          if (!nextQ.dead && nextQ.txn !== null) {
            t.lockHolder = nextQ;
            if (nextQ.locksHeld.indexOf(i) === -1) nextQ.locksHeld.push(i);
            nextQ.waiting = false;
            nextQ.waitingOn = -1;
            if (nextQ.dwell > 0.05) nextQ.dwell = 0.04;
            break;
          }
        }
      }
    }
    if (q.locksHeld) q.locksHeld.length = 0;
  }

  // ---- query particles -------------------------------------------------

  function wp(id, dwell, act) {
    var p = FB.stations[id];
    return { x: p.x, y: p.y, dwell: dwell || 0, act: act || null, at: id };
  }

  function spawnQuery(s, traced) {
    var isUpdate = traced ? true : Math.random() < s.updateRatio;
    var reads = traced ? 2 : 1 + Math.floor(Math.random() * 3);
    var tableIdx = pickTable(isUpdate);
    var firstTable = (isUpdate && !traced && Math.random() < 0.65)
      ? ((tableIdx + 1 + Math.floor(Math.random() * 2)) % 3)
      : tableIdx;
    var stmtCached = !traced && s.stmtCacheRatio > 0 &&
      Math.random() < s.stmtCacheRatio;
    var path;
    if (stmtCached) {
      s.stmtCacheHits++;
      path = [
        wp("harbor", 0.05),
        wp("yvalve", 0.08, "stmtcache"),
        wp("exec", 0.12, "execstart")
      ];
    } else {
      path = [
        wp("harbor", 0.05),
        wp("yvalve", 0.12),
        wp("lexer", 0.15),
        wp("parser", 0.2),
        wp("blrgen", 0.15, "blr"),
        wp("security", 0.08),
        wp("cmp", 0.25, "compile"),
        wp("exec", 0.15, "execstart")
      ];
    }
    for (var i = 0; i < reads; i++) path.push(wp("cache", 0.1, "page"));
    if (isUpdate) {
      path.push(wp("lock", 0.12, "lock"));
      path.push(wp("mvcc", 0.18, "version"));
      path.push(wp("cache", 0.08, "wpage"));
      path.push(wp("tra", 0.04, "commit"));
    } else {
      path.push(wp("mvcc", 0.04, "rversion"));
    }
    path.push(wp("exec", 0.08));
    path.push(wp("yvalve", 0.06, "result"));
    path.push(wp("harbor", 0, "done"));

    var q = {
      x: FB.stations.harbor.x, y: FB.stations.harbor.y,
      path: path, idx: 0, dwell: 0.05,
      speed: traced ? 8 : 12 + Math.random() * 5,
      kind: isUpdate ? "update" : "select",
      attachment: Math.floor(Math.random() * 4),
      table: tableIdx,
      firstTable: firstTable,
      stmtCached: stmtCached,
      needsPlan: !isUpdate && Math.random() < 0.55,
      planApplied: false,
      plan: isUpdate ? "INDEX+UPD" : "NATURAL",
      locksHeld: [],
      waitingOn: -1,
      hadLockWait: false,
      startCn: s.commitNumber,
      stmtCn: s.commitNumber,
      phase: "sql",           // sql -> blr -> result
      txn: null,
      snap: null,             // OAT when this query's transaction started
      traced: !!traced,
      waiting: false,
      dead: false,
      lat: newLat(),
      latBucket: "travel"
    };
    var emptyFloor = s.next > 1000 ? s.next : 999;
    var activeFloor = s.active.length ? Math.min.apply(null, s.active) : emptyFloor;
    if (isUpdate) {
      q.txn = s.next++;
      s.active.push(q.txn);
      q.snap = Math.min(activeFloor, q.txn);
    } else {
      q.snap = activeFloor;
    }
    s.particles.push(q);
    refreshMarkers(s);
    return q;
  }

  function finishTxn(s, q, rolledBack) {
    releaseLocks(s, q);
    if (q.txn === null) return;
    var i = s.active.indexOf(q.txn);
    if (i >= 0) s.active.splice(i, 1);
    if (rolledBack) {
      s.rollbacks++;
      if (s.rolledBack.indexOf(q.txn) === -1) s.rolledBack.push(q.txn);
    }
    q.txn = null;
    q.snap = null;
    refreshMarkers(s);
  }

  function applySelectPlan(s, q) {
    if (!q.needsPlan || q.planApplied) return;
    q.planApplied = true;
    var ot = s.tables[q.table !== undefined ? q.table : 0];
    var sel = Math.min(1, ot.selectivity + ot.statDrift);
    var rvIdx = -1;
    for (var pi = q.idx + 1; pi < q.path.length; pi++) {
      if (q.path[pi].act === "rversion") { rvIdx = pi; break; }
    }
    if (rvIdx >= 0) {
      if (sel < 0.12) {
        q.plan = "INDEX";
        s.indexScans++;
        q.path.splice(rvIdx + 1, 0, wp("btr", 0.14, "btr"));
      } else {
        q.plan = "NATURAL+SORT";
        s.naturalScans++;
        q.path.splice(rvIdx + 1, 0,
          wp("cache", 0.08, "page"),
          wp("sort", 0.15, "sort"));
      }
    }
  }

  function arrive(s, q) {
    var step = q.path[q.idx];
    if (q.traced) {
      s.traceStage = step.at;
      s.traceNote = "";
    }
    // charge this station's dwell to the right bucket
    q.latBucket = ({
      lexer: "compile", parser: "compile", blrgen: "compile", cmp: "compile",
      cache: "cacheHit", pio: "diskRead", sort: "sortSpill",
      lock: "lockWait", mvcc: "version", tra: "commit", journal: "repl"
    })[step.at] || "travel";

    switch (step.act) {
      case "blr":
      case "stmtcache":
        q.phase = "blr";
        break;
      case "compile":
        // Cost-based optimizer (src/jrd/opt.cpp): inspect cached index
        // selectivity (RDB$STATISTICS = selectivity + statDrift) on q.table.
        applySelectPlan(s, q);
        break;
      case "execstart":
        // Cached statements carry a pre-compiled execution plan straight into EXE
        applySelectPlan(s, q);
        // Firebird 4+ READ COMMITTED READ CONSISTENCY: establish a fresh
        // statement-level commit-order snapshot (CN) when execution starts.
        if (s.isolationMode === "read_consistency") {
          q.stmtCn = s.commitNumber;
        }
        break;
      case "page":
        // Multi-table updates lock their first relation during the initial
        // read/modify step before requesting the second relation at LOCK.
        if (q.kind === "update" && !q.traced && q.locksHeld.length === 0 &&
            q.firstTable !== q.table) {
          var ft = s.tables[q.firstTable];
          q.locksHeld.push(q.firstTable);
          if (!ft.lockHolder) ft.lockHolder = q;
        }
        if (cacheAccess(s, false, q.attachment)) {
          if (q.traced) s.traceNote = "hit";
          if (Math.random() < 0.35) coopGC(s, q.table);
        } else {
          if (q.traced) s.traceNote = "miss";
          // miss: detour down to the database file and back
          q.path.splice(q.idx + 1, 0, wp("pio", 0.22), wp("cache", 0.05));
        }
        break;
      case "rversion": {
        var rt = s.tables[q.table !== undefined ? q.table : Math.floor(Math.random() * TABLE_COUNT)];
        chaseVersionChain(s, q, rt);
        if (Math.random() < 0.65) coopGC(s, q.table, q);
        break;
      }
      case "wpage": {
        var wHit = cacheAccess(s, true, q.attachment);
        if (q.traced) s.traceNote = wHit ? "hit" : "miss";
        break;
      }
      case "sort": {
        // Firebird sorts in memory up to TempCacheLimit and spills the rest
        // to temporary files. A spill is disk I/O the query pays for.
        s.sorts++;
        var need = 8 + Math.floor(Math.random() * 90);
        if (need > s.tempCacheLimit) {
          s.sortSpills++;
          q.dwell += 0.35 + (need - s.tempCacheLimit) / 120;
          s.diskFlash = 1;
          s.diskPos = Math.random();
          if (q.traced) s.traceNote = "spill";
        } else if (q.traced) {
          s.traceNote = "inmemory";
        }
        break;
      }
      case "lock": {
        pruneLocks(s);
        if (!q.traced && q.locksHeld.length === 0 && q.firstTable !== q.table) {
          var ftLock = s.tables[q.firstTable];
          if (!ftLock.lockHolder) {
            ftLock.lockHolder = q;
            q.locksHeld.push(q.firstTable);
          }
        }
        var lt = s.tables[q.table !== undefined ? q.table : 0];
        if (q.traced || !lt.lockHolder || lt.lockHolder === q) {
          if (!q.traced) {
            lt.lockHolder = q;
            if (q.locksHeld.indexOf(q.table) === -1) q.locksHeld.push(q.table);
          }
          break;
        }
        // Contention: another active transaction holds the lock on q.table
        var holderQ = lt.lockHolder;
        s.lockWaits++;
        if (s.lockMode === "nowait") {
          // SET TRANSACTION NO WAIT: abort immediately without queuing
          s.noWaitAborts++;
          say(s, "NO WAIT lock conflict on T" + q.table + ": txn " + q.txn +
            " aborted (held by txn " + holderQ.txn + ").");
          finishTxn(s, q, true);
          q.phase = "rollback";
          q.dwell = 0.02;
          q.path = q.path.slice(0, q.idx + 1)
            .concat([wp("exec", 0.05), wp("yvalve", 0.05), wp("harbor", 0, "done")]);
          break;
        }
        // WAIT mode: check if waiting on holderQ creates a wait-for cycle
        if (detectDeadlockCycle(s, q, holderQ)) {
          s.deadlocks++;
          say(s, "Deadlock scan: cycle txn " + q.txn + " ↔ txn " + holderQ.txn +
            " — txn " + q.txn + " rolled back.");
          finishTxn(s, q, true);
          q.phase = "rollback";
          q.dwell = 0.16;
          q.path = q.path.slice(0, q.idx + 1)
            .concat([wp("exec", 0.05), wp("yvalve", 0.05), wp("harbor", 0, "done")]);
          break;
        }
        // Queue behind the current lock holder on this table
        q.waiting = true;
        q.waitingOn = q.table;
        q.hadLockWait = true;
        if (lt.waiters.indexOf(q) === -1) lt.waiters.push(q);
        q.dwell += 0.85 + Math.min(1.5, lt.waiters.length * 0.28);
        break;
      }
      case "version": {
        var t = s.tables[q.table !== undefined ? q.table : Math.floor(Math.random() * TABLE_COUNT)];
        // Check whether a concurrent writer committed a newer version on this
        // table after our snapshot started (t.lastCommitCn > q.startCn).
        if (!q.traced && t.lastCommitCn > q.startCn) {
          if (s.isolationMode === "snapshot") {
            // SNAPSHOT (CONCURRENCY): cannot overwrite a version committed
            // after our transaction snapshot began (isc_update_conflict).
            if (q.hadLockWait || Math.random() < 0.45) {
              s.updateConflicts++;
              say(s, "Update conflict on T" + q.table + ": txn " + q.txn +
                " rolled back (committed CN " + t.lastCommitCn +
                " > snapshot CN " + q.startCn + ").");
              finishTxn(s, q, true);
              q.phase = "rollback";
              q.dwell = 0.06;
              q.path = q.path.slice(0, q.idx + 1)
                .concat([wp("exec", 0.05), wp("yvalve", 0.05), wp("harbor", 0, "done")]);
              break;
            }
          } else {
            // Firebird 4+ READ COMMITTED READ CONSISTENCY: refresh the
            // statement-level commit-order snapshot (CN) and restart the
            // write against the newly committed version without rolling back.
            s.writeRestarts++;
            q.stmtCn = s.commitNumber;
            q.startCn = s.commitNumber;
            q.dwell += 0.06;
          }
        }
        chaseVersionChain(s, q, t);
        if (t.versions < MAX_CHAIN) {
          t.chain.push(q.txn);
          t.versions++;
          s.totalVersions++;
        }
        // Firebird does not recompute RDB$STATISTICS automatically on every
        // write; heavy modifications drift cached selectivity until SET STATISTICS.
        t.statDrift = Math.min(0.85, +(t.statDrift + 0.015).toFixed(4));
        t.flash = 1;
        break;
      }
      case "commit":
        if (!q.traced && Math.random() < 0.08) {
          // Statement abort / client ROLLBACK: the version written at VIO
          // remains on the chain as dead baggage and the TIP marks this
          // transaction rolled back, pinning the OIT until sweep runs.
          var wasClean = s.rolledBack.length === 0 && holder(s) === null;
          var rbTxn = q.txn;
          finishTxn(s, q, true);
          q.phase = "rollback";
          if (wasClean) {
            say(s, "Transaction " + rbTxn + " rolled back — OIT pinned at " +
              s.oit + " until sweep.");
          }
          break;
        }
        finishTxn(s, q, false);
        s.commitNumber++;
        if (q.table !== undefined && s.tables[q.table]) {
          s.tables[q.table].lastCommitCn = s.commitNumber;
        }
        // Forced writes (MON$FORCED_WRITES): when enabled (default), the
        // commit waits for its dirtied page (and any careful-write
        // prerequisite in the precedence graph) to be flushed to disk.
        // When disabled, the commit returns as soon as the TIP bit flips in
        // memory, leaving dirty buffers for background flush or eviction.
        if (s.forcedWrites) {
          var flushed = flushDirty(s, 1);
          q.dwell += 0.10 + Math.max(0, flushed - 1) * 0.04;
        }
        replicateCommit(s, q);
        break;
      case "result":
        q.snap = null;
        if (q.phase !== "rollback") q.phase = "result";
        break;
      case "done":
        q.snap = null;
        q.dead = true;
        s.done++;      // reset every stats window
        s.completed++; // lifetime, so the qps readout can be checked against it
        recordLatency(s, q);
        break;
    }
    q.waiting = q.waiting && step.act === "lock";
    // step mode: a traced query parks at every station until "Next step"
    if (q.traced && s.traceStep && !q.dead) q.dwell = 1e9;
  }

  function moveParticles(s, dt) {
    var hadDead = false;
    for (var i = 0; i < s.particles.length; i++) {
      var q = s.particles[i];
      chargeLatency(q, dt);
      if (q.dwell > 0) { q.dwell -= dt; q.waiting = q.waiting && q.dwell > 0; continue; }
      if (q.waitingOn >= 0) {
        var wt = s.tables[q.waitingOn];
        var wi = wt.waiters.indexOf(q);
        if (wi >= 0) wt.waiters.splice(wi, 1);
        if (!wt.lockHolder) {
          wt.lockHolder = q;
          if (q.locksHeld.indexOf(q.waitingOn) === -1) q.locksHeld.push(q.waitingOn);
        }
        q.waitingOn = -1;
      }
      q.waiting = false;
      q.latBucket = "travel";   // moving between stations costs travel time
      var step = q.path[q.idx];
      var dx = step.x - q.x, dy = step.y - q.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var move = q.speed * dt;
      if (dist <= move || dist < 0.001) {
        q.x = step.x; q.y = step.y;
        q.dwell = step.dwell;
        arrive(s, q);
        q.idx++;
        if (q.idx >= q.path.length) q.dead = true;
        if (q.dead) hadDead = true;
      } else {
        q.x += dx / dist * move;
        q.y += dy / dist * move;
      }
    }
    if (hadDead) {
      s.particles = s.particles.filter(function (q) { return !q.dead; });
      pruneLocks(s);
      refreshMarkers(s);
    }
    if (s.tracedQ && s.tracedQ.dead) {
      s.tracedQ = null;
      s.traceStage = null;
      say(s, "Trace complete — the result made it home.");
    }
  }

  // ---- query trace -----------------------------------------------------

  function startTrace(s) {
    if (s.tracedQ) return;
    s.tracedQ = spawnQuery(s, true);
    s.traceStep = true;
    s.traceStage = "harbor";
    s.traceNote = "";
    say(s, "Tracing one UPDATE through the whole pipeline.");
  }

  function traceNext(s) {
    if (s.tracedQ && s.tracedQ.dwell > 100) s.tracedQ.dwell = 0.15;
  }

  function traceAuto(s) {
    s.traceStep = false;
    traceNext(s);
  }

  function tracePause(s) {
    s.traceStep = true;
  }

  function endTrace(s) {
    var q = s.tracedQ;
    if (q) {
      q.traced = false;
      if (q.dwell > 100) q.dwell = 0.1;
    }
    s.tracedQ = null;
    s.traceStage = null;
  }

  // ---- sweep -----------------------------------------------------------

  function startSweep(s, manual) {
    if (s.sweepActive) return;
    if (holder(s) !== null) {
      var alreadyBlocked = s.sweepBlocked;
      s.sweepBlocked = true;
      if (manual || !alreadyBlocked) {
        var why = s.pinned !== null ? "long-running transaction"
                                    : "gbak's snapshot";
        say(s, manual ? "Sweep requested — but " + why + " pins the OIT."
          : "Sweep skipped: " + why + " pins the OIT.");
      }
      return;
    }
    s.sweepBlocked = false;
    s.sweepActive = true;
    s.sweepProgress = 0;
    var gap = s.ost - s.oit;
    say(s, manual
      ? "Sweep started: demolishing versions older than OST " + s.ost +
        " (OIT " + s.oit + ")."
      : "Sweep started: OST − OIT gap reached " + gap +
        " (OIT " + s.oit + " → OST " + s.ost + ").");
  }

  function tickSweep(s, dt) {
    refreshMarkers(s);
    if (holder(s) === null) s.sweepBlocked = false;
    if (!s.sweepActive && s.sweepEnabled && s.sweepInterval > 0) {
      if ((s.ost - s.oit) >= s.sweepInterval ||
          (holder(s) !== null && (s.next - s.oit) >= s.sweepInterval)) {
        startSweep(s, false);
      }
    }
    if (!s.sweepActive) return;
    var before = Math.floor(s.sweepProgress * TABLE_COUNT);
    s.sweepProgress += dt / 4; // 4-second tour
    var upto = Math.min(TABLE_COUNT, Math.floor(s.sweepProgress * TABLE_COUNT));
    for (var i = before; i < upto; i++) {
      var t = s.tables[i];
      if (t.versions > 1) {
        // demolish all back-versions older than the Oldest Snapshot (OST);
        // always keep the current head version (last entry in t.chain)
        var head = t.chain[t.chain.length - 1];
        var kept = [];
        for (var j = 0; j < t.chain.length - 1; j++) {
          if (t.chain[j] >= s.ost) kept.push(t.chain[j]);
        }
        kept.push(head);
        var removed = t.versions - kept.length;
        if (removed > 0) {
          s.totalVersions -= removed;
          t.chain = kept;
          t.versions = kept.length;
          t.flash = 1;
        }
      }
    }
    if (s.sweepProgress >= 1.05) {
      s.sweepActive = false;
      var sweptTo = s.ost;
      s.rolledBack = s.rolledBack.filter(function (tx) { return tx > sweptTo; });
      refreshMarkers(s);
      say(s, "Sweep finished. OIT advanced to " + s.oit + ".");
    }
  }

  // ---- logical replication ---------------------------------------------
  //
  // Firebird has no WAL to ship, so replication is logical: the committed
  // changes themselves are journalled into segments and replayed on the
  // replica in commit order.

  var SEGMENT_SIZE = 20;      // changes per journal segment (scaled)
  var LAT_SAMPLE = 256;       // completed trips kept for the latency profile

  /* The buckets a query's time can land in. Everything a particle does is
   * charged to exactly one of these, so the parts sum to the whole and the
   * profile cannot quietly lose time. */
  var LAT_KEYS = ["compile", "cacheHit", "diskRead", "sortSpill", "lockWait",
                  "version", "commit", "repl", "travel"];

  /* "travel" is the time a particle spends moving between districts. That is
   * a property of drawing a city, not of running a database — a real query
   * does not walk anywhere. It is accounted for so the books balance, but it
   * is kept out of the reported decomposition, because a profile in which
   * 84% is the animation would be an authoritative-looking lie. */
  var LAT_WORK_KEYS = LAT_KEYS.filter(function (k) { return k !== "travel"; });

  function newLat() {
    var l = {};
    for (var i = 0; i < LAT_KEYS.length; i++) l[LAT_KEYS[i]] = 0;
    return l;
  }

  /* Charge elapsed time to whichever bucket the query is currently in. */
  function chargeLatency(q, dt) {
    if (!q.lat) return;
    q.lat[q.latBucket || "travel"] += dt;
  }

  function recordLatency(s, q) {
    if (!q.lat) return;
    var total = 0;
    for (var i = 0; i < LAT_KEYS.length; i++) total += q.lat[LAT_KEYS[i]];
    q.lat.total = total;
    s.lat.samples.push(q.lat);
    if (s.lat.samples.length > LAT_SAMPLE) s.lat.samples.shift();
    s.lat.totals = null;   // invalidate the cached aggregate
  }

  /* Aggregate the sample into mean seconds per bucket, plus p50/p95 totals.
   * Computed on demand so the simulation loop stays cheap. */
  function latencyProfile(s) {
    if (s.lat.totals) return s.lat.totals;
    var n = s.lat.samples.length;
    if (!n) return null;
    var sums = newLat(), i, k;
    for (i = 0; i < n; i++) {
      for (k = 0; k < LAT_KEYS.length; k++) {
        sums[LAT_KEYS[k]] += s.lat.samples[i][LAT_KEYS[k]];
      }
    }
    var mean = {}, grand = 0, workTotal = 0;
    for (k = 0; k < LAT_KEYS.length; k++) {
      mean[LAT_KEYS[k]] = sums[LAT_KEYS[k]] / n;
      grand += mean[LAT_KEYS[k]];
      if (LAT_KEYS[k] !== "travel") workTotal += mean[LAT_KEYS[k]];
    }
    var totals = s.lat.samples.map(function (x) { return x.total; })
      .sort(function (a, b) { return a - b; });
    s.lat.totals = {
      n: n, mean: mean,
      grand: grand,           // every bucket, including transit
      workTotal: workTotal,   // the part with a real-world counterpart
      p50: totals[Math.floor(n * 0.5)],
      p95: totals[Math.min(n - 1, Math.floor(n * 0.95))],
      keys: LAT_KEYS, workKeys: LAT_WORK_KEYS
    };
    return s.lat.totals;
  }

  /* A transaction committed.
   *
   * Asynchronous replication journals the change into a segment. Synchronous
   * replication has no journal — the change goes straight down a connection
   * to the replica, which costs the commit some latency.
   *
   * When a replica errors, Firebird does NOT block the commit. checkStatus()
   * in Publisher.cpp is called with canThrow=false on the commit path, and
   * disable_on_error (default true) tears replication down: TRA_replicating
   * and ATT_replicating are cleared, the replicator is disposed, and
   * STOP_ERROR is logged. The commit then succeeds normally.
   *
   * So a synchronous replica that dies does not hang anything — replication
   * disables itself and the primary carries on without it. There is no
   * durability guarantee being protected here, because Firebird's
   * synchronous replication is not two-phase commit and never promised one.
   *
   * Verified against FirebirdSQL/firebird master, src/jrd/replication/
   * Publisher.cpp and Config.cpp. Corrected after Dmitry Sibiryakov pointed
   * out that the earlier model had this backwards.
   */
  function replicateCommit(s, q) {
    var r = s.repl;
    if (r.mode === "off") return;

    if (r.health === "down") {
      if (r.mode === "sync") {
        // disable_on_error: replication stops, the commit does not
        selfDisable(s, "the synchronous replica is unreachable");
        return;
      }
      // asynchronous: the primary keeps journalling regardless
    }

    r.generated++;
    r.flash = 1;

    if (r.mode === "sync") {
      // sent straight to the replica; no journal segment is written
      r.applied++;                       // the replica has it as we commit
      if (q) {
        q.dwell += r.health === "slow" ? 0.9 : 0.25;
        q.latBucket = "repl";            // this wait belongs to replication
      }
    } else {
      r.pending++;
      if (r.pending >= SEGMENT_SIZE) {
        r.segments.push({ n: r.segNo++, changes: r.pending });
        r.pending = 0;
      }
    }
  }

  /* disable_on_error — the engine's own words are "STOP_ERROR". Replication
   * is torn down; everything else carries on as if it had never been on. */
  function selfDisable(s, why) {
    var r = s.repl;
    if (r.disabled) return;
    r.disabled = true;
    r.mode = "off";
    r.pending = 0;
    r.segments = [];
    r.stops++;
    say(s, "Replication STOPPED — " + why + ". disable_on_error tore it " +
      "down; commits are unaffected and the replica is now out of sync.");
  }

  function tickReplication(s, dt) {
    var r = s.repl;
    if (r.flash > 0) r.flash -= dt * 2.2;
    if (r.mode === "off" || r.health === "down") return;

    // apply rate on the replica, in changes per second
    var rate = r.health === "slow" ? 7 : 34;
    r.applyAcc += rate * dt;
    while (r.applyAcc >= 1 && r.segments.length) {
      var seg = r.segments[0];
      var take = Math.min(Math.floor(r.applyAcc), seg.changes);
      seg.changes -= take;
      r.applied += take;
      r.applyAcc -= take;
      if (seg.changes <= 0) r.segments.shift(); // commit order preserved
      if (take === 0) break;
    }
    if (!r.segments.length) r.applyAcc = 0;
  }

  function replLag(s) {
    return s.repl.generated - s.repl.applied;
  }

  function setReplMode(s, mode) {
    var r = s.repl;
    if (r.mode === mode) return;
    r.mode = mode;
    r.disabled = false;   // re-enabling is an operator action, as in reality
    if (mode === "off") {
      r.pending = 0;
      r.segments = [];
      say(s, "Replication switched off. Journalling stopped and the backlog " +
        "was discarded.");
    } else {
      say(s, "Replication set to " + mode + ".");
    }
  }

  function setReplHealth(s, health) {
    var r = s.repl;
    if (r.health === health) return;
    r.health = health;
    if (health === "down") {
      say(s, r.mode === "sync"
        ? "Replica unreachable — the next commit will stop replication."
        : "Replica unreachable. Segments will accumulate until it returns.");
    } else if (health === "slow") {
      say(s, "Replica is applying slowly; lag will build.");
    } else {
      say(s, r.disabled
        ? "Replica reachable again — but replication is still stopped. It " +
          "has to be switched back on deliberately."
        : "Replica healthy again — catching up from segment " +
          (r.segments.length ? r.segments[0].n : r.segNo) + ".");
    }
  }

  // ---- backup & recovery -----------------------------------------------
  //
  // Two very different tools, both real Firebird:
  //   gbak    — logical dump through a normal attachment. Runs online, but
  //             its snapshot transaction pins the OIT for the whole run.
  //   nbackup — physical, incremental by level. Level 0 is the whole file;
  //             each higher level copies only pages changed since the level
  //             below. Locking the database freezes the main file and sends
  //             new page writes to a difference (delta) file, which is
  //             merged back on unlock.

  function startGbak(s) {
    var b = s.backup;
    if (b.gbakActive) return;
    b.gbakActive = true;
    b.gbakProgress = 0;
    b.gbakTxn = s.next++;
    refreshMarkers(s);
    say(s, "gbak started — snapshot txn " + b.gbakTxn +
      " now pins the OIT until it finishes.");
  }

  function tickGbak(s, dt) {
    var b = s.backup;
    if (!b.gbakActive) return;
    b.gbakProgress += dt / 12; // a 12-second dump
    // reading every page of the database evicts the working set as it goes
    if (Math.random() < dt * 6) cacheAccess(s, false);
    if (b.gbakProgress >= 1) {
      b.gbakActive = false;
      b.gbakProgress = 0;
      b.gbakTxn = null;
      b.gbakRuns++;
      refreshMarkers(s);
      say(s, "gbak finished. Snapshot released — the OIT can advance again.");
    }
  }

  function startNbackup(s, level) {
    var b = s.backup;
    if (b.nbActive || b.merging) return;
    if (level > 0 && !b.levels.some(function (l) { return l.level === level - 1; })) {
      say(s, "nbackup level " + level + " needs a level " + (level - 1) +
        " first — the chain has to start somewhere.");
      return;
    }
    b.nbActive = true;
    b.nbProgress = 0;
    b.nbLevel = level;
    b.locked = true;      // -L : freeze the main file, divert writes to delta
    say(s, "nbackup level " + level + " — database locked, writes now go to " +
      "the delta file.");
  }

  function tickNbackup(s, dt) {
    var b = s.backup;
    if (b.nbActive) {
      // level 0 copies the whole file; higher levels only changed pages
      b.nbProgress += dt / (b.nbLevel === 0 ? 8 : 3);
      if (b.nbProgress >= 1) {
        var pages = b.nbLevel === 0 ? PAGE_SPACE
          : Math.max(1, Math.round(b.deltaPages + 20 + Math.random() * 40));
        b.levels = b.levels.filter(function (l) { return l.level < b.nbLevel; });
        b.levels.push({ level: b.nbLevel, at: Math.round(s.time), pages: pages });
        b.nbActive = false;
        b.nbProgress = 0;
        say(s, "nbackup level " + b.nbLevel + " copied " + pages +
          " pages. Unlocking and merging the delta back.");
        unlockNbackup(s);
      }
    }
    if (b.merging) {
      b.mergeProgress += dt / 2.5;
      b.deltaPages = Math.round(b.mergeFrom * (1 - Math.min(1, b.mergeProgress)));
      if (b.deltaPages > 0 && Math.random() < dt * 8) {
        s.diskFlash = 1;
        s.diskPos = Math.random();
      }
      if (b.mergeProgress >= 1) {
        b.merging = false;
        b.deltaPages = 0;
        say(s, "Delta merged into the database file. Main file live again.");
      }
    }
    if (b.deltaFlash > 0) b.deltaFlash -= dt * 2.2;
  }

  function lockNbackup(s) {
    var b = s.backup;
    if (b.locked || b.merging) return;
    b.locked = true;
    say(s, "Database locked (nbackup -L). The main file is frozen; every " +
      "new page write lands in the delta file.");
  }

  function unlockNbackup(s) {
    var b = s.backup;
    if (!b.locked) return;
    b.locked = false;
    if (b.deltaPages > 0) {
      b.merging = true;
      b.mergeProgress = 0;
      b.mergeFrom = b.deltaPages;
    }
  }

  function toggleLock(s) {
    if (s.backup.locked) unlockNbackup(s); else lockNbackup(s);
  }

  function restoreChain(s) {
    var b = s.backup;
    if (!b.levels.length) {
      say(s, "Nothing to restore — run an nbackup level 0 first.");
      return;
    }
    var chain = b.levels.slice().sort(function (x, y) { return x.level - y.level; });
    var total = chain.reduce(function (a, l) { return a + l.pages; }, 0);
    say(s, "Restore would apply " + chain.map(function (l) {
      return "L" + l.level;
    }).join(" → ") + " in order — " + total + " pages.");
  }

  // ---- operator decisions ----------------------------------------------
  //
  // Each situation is set up for real in the model, both answers cost
  // something, and the verdict is measured from what actually happened
  // rather than asserted.

  function snapshot(s) {
    return {
      time: s.time, versions: s.totalVersions, oit: s.oit,
      pageWrites: s.pageWrites, delta: s.backup.deltaPages,
      hitRatio: s.hitRatio, dirty: s.dirtyEvictions
    };
  }

  function startChallenge(s, id) {
    var def = null;
    FB.challenges.forEach(function (c) { if (c.id === id) def = c; });
    if (!def) return;

    // put the world into the situation
    if (id === "sweepblock") {
      s.queryRate = 10; s.updateRatio = 0.6;
      if (s.pinned === null) setLongTxn(s, true);
      for (var i = 0; i < 25 * 60; i++) tick(s, 1 / 60); // let it accumulate
    } else if (id === "gbakwindow") {
      s.queryRate = 10; s.updateRatio = 0.55;
      setLongTxn(s, false);
      if (!s.backup.gbakActive) startGbak(s);
      for (var j = 0; j < 4 * 60; j++) tick(s, 1 / 60);
    } else if (id === "deltagrowing") {
      s.queryRate = 11; s.updateRatio = 0.7;
      setLongTxn(s, false);
      if (!s.backup.locked) lockNbackup(s);
      for (var k = 0; k < 20 * 60; k++) tick(s, 1 / 60);
    } else if (id === "replicadown") {
      s.queryRate = 12; s.updateRatio = 0.75;
      setLongTxn(s, false);
      setReplMode(s, "async");
      setReplHealth(s, "down");
      for (var m = 0; m < 45 * 60; m++) tick(s, 1 / 60);
    }

    s.challenge = { id: id, at: s.time, snap: snapshot(s) };
    s.verdict = null;
    say(s, "Decision: " + def.title + ".");
  }

  function answerChallenge(s, choice) {
    var ch = s.challenge;
    if (!ch) return;
    var before = ch.snap, id = ch.id, lines = [];

    if (id === "sweepblock") {
      if (choice === "kill") {
        var lostTxn = s.pinned;
        setLongTxn(s, false);
        startSweep(s, true);
        runFor(s, 8);
        lines.push("Attachment terminated. Transaction " + lostTxn +
          " rolled back — whatever it had done is gone.");
        lines.push("The OIT advanced to " + s.oit + " and sweep collected " +
          (before.versions - s.totalVersions) + " versions. " +
          s.totalVersions + " remain.");
        lines.push("Cost: one rolled-back transaction, and an application " +
          "team who will ask why their session died.");
      } else {
        runFor(s, 30);
        lines.push("You waited 30 more seconds. The OIT never moved — still " +
          s.oit + ".");
        lines.push("Versions went from " + before.versions + " to " +
          s.totalVersions + ", and every sweep in that window was skipped.");
        lines.push("Cost: nothing was lost, and nothing was collected. " +
          "Waiting is only free if the session actually commits.");
      }
    } else if (id === "gbakwindow") {
      if (choice === "finish") {
        runUntil(s, function (x) { return !x.backup.gbakActive; }, 20);
        var atFinish = s.totalVersions;
        startSweep(s, true);
        runFor(s, 8);
        lines.push("Backup completed. You have tonight's gbak.");
        lines.push("Versions peaked at " + atFinish + " while the snapshot " +
          "held the OIT; sweep afterwards brought them back to " +
          s.totalVersions + ".");
        lines.push("Cost: a window of stalled GC, paid back once the backup " +
          "released the OIT. Usually the right trade — the backup is the " +
          "thing you cannot recreate.");
      } else {
        s.backup.gbakActive = false;
        s.backup.gbakProgress = 0;
        s.backup.gbakTxn = null;
        refreshMarkers(s);
        startSweep(s, true);
        runFor(s, 8);
        lines.push("gbak cancelled. The OIT advanced to " + s.oit +
          " and sweep collected immediately — " + s.totalVersions +
          " versions remain.");
        lines.push("Cost: there is no backup tonight. You traded a recoverable " +
          "problem (bloat, which sweep fixes) for an unrecoverable one " +
          "(no backup if the disk dies before tomorrow).");
      }
    } else if (id === "replicadown") {
      var segsWas = s.repl.segments.length, lagWas = replLag(s);
      if (choice === "drop") {
        setReplMode(s, "off");
        runFor(s, 20);
        lines.push("Replication stopped. " + segsWas + " unshipped segments " +
          "(" + lagWas + " changes) discarded — the volume stops filling now.");
        lines.push("The primary is unaffected and still committing.");
        lines.push("Cost: the replica is no longer a replica. Bringing it " +
          "back is a fresh backup and restore, not a resume — and until then " +
          "you have no second copy.");
      } else {
        runFor(s, 40);
        lines.push("You kept journalling. The backlog grew from " + segsWas +
          " to " + s.repl.segments.length + " segments — " + replLag(s) +
          " changes now waiting.");
        lines.push("Nothing is lost, and the replica could still resume from " +
          "segment " + (s.repl.segments.length ? s.repl.segments[0].n : s.repl.segNo) + ".");
        lines.push("Cost: you are betting free space against the replica " +
          "coming back, and the bet gets worse at a steady rate. If the " +
          "volume fills, the primary stops too — a much larger outage than " +
          "the one you were protecting against.");
      }
    } else if (id === "deltagrowing") {
      if (choice === "unlock") {
        var deltaWas = s.backup.deltaPages;
        unlockNbackup(s);
        runFor(s, 6);
        lines.push("Unlocked. " + deltaWas + " pages merged back into the " +
          "database file.");
        lines.push("That merge cost " + (s.pageWrites - before.pageWrites) +
          " page writes during peak, and the cache hit ratio sat at " +
          Math.round(s.hitRatio * 100) + "% while it ran.");
        lines.push("Cost: I/O at the worst hour. The delta is now zero and " +
          "the main file is live again.");
      } else {
        runFor(s, 30);
        lines.push("You waited. The delta grew from " + before.delta +
          " to " + s.backup.deltaPages + " pages.");
        lines.push("The main file is still frozen, so nothing was written to " +
          "it in that time — every one of those writes is sitting in the " +
          "difference file.");
        lines.push("Cost: you avoided merge I/O and bet the volume's free " +
          "space instead. That bet gets worse the longer the lock is held, " +
          "and the merge you deferred did not get smaller.");
      }
    }

    s.verdict = { id: id, choice: choice, lines: lines };
    s.challenge = null;
  }

  function endChallenge(s) {
    s.challenge = null;
    s.verdict = null;
  }

  /* deterministic fast-forward helpers used by the decision consequences */
  function runFor(s, seconds) {
    for (var i = 0; i < seconds * 60; i++) tick(s, 1 / 60);
  }

  function runUntil(s, pred, maxSeconds) {
    var n = maxSeconds * 60;
    while (n-- > 0 && !pred(s)) tick(s, 1 / 60);
  }

  // ---- public API ------------------------------------------------------

  function setServerMode(s, mode) {
    if (mode !== "super" && mode !== "superclassic" && mode !== "classic") return;
    if (s.serverMode === mode) return;
    s.serverMode = mode;
    s.astArcs = [];
    say(s, mode === "super"
      ? "Server mode set to SuperServer — unified shared page cache across all attachments."
      : "Server mode set to " + (mode === "classic" ? "Classic" : "SuperClassic") +
        " — cache partitioned per attachment; coherence enforced via Lock Manager ASTs.");
  }

  /* Route a query particle according to an actual Firebird execution plan
   * returned by firebird-wasm's db.explain(sql, { detailed: true }). */
  function spawnExplainedQuery(s, sql, planText) {
    var sqlStr = String(sql || "SELECT * FROM RDB$DATABASE");
    var planStr = String(planText || "");
    var isUpdate = /^\s*(insert|update|delete|merge)\b/i.test(sqlStr);
    var hasIndex = /\bindex\b/i.test(planStr);
    var hasSort = /\bsort\b/i.test(planStr);
    var tableIdx = pickTable(isUpdate);

    var path = [
      wp("harbor", 0.05),
      wp("yvalve", 0.10),
      wp("lexer", 0.12),
      wp("parser", 0.15),
      wp("blrgen", 0.12, "blr"),
      wp("security", 0.06),
      wp("cmp", 0.18, "compile"),
      wp("exec", 0.12, "execstart"),
      wp("cache", 0.08, "page")
    ];
    if (isUpdate) {
      if (hasIndex) {
        s.indexScans++;
        path.push(wp("btr", 0.12, "btr"));
      }
      path.push(wp("lock", 0.12, "lock"));
      path.push(wp("mvcc", 0.18, "version"));
      path.push(wp("cache", 0.08, "wpage"));
      path.push(wp("tra", 0.04, "commit"));
    } else {
      path.push(wp("mvcc", 0.04, "rversion"));
      if (hasIndex) {
        s.indexScans++;
        path.push(wp("btr", 0.14, "btr"));
      }
      if (hasSort) {
        s.naturalScans++;
        path.push(wp("sort", 0.15, "sort"));
      } else if (!hasIndex) {
        s.naturalScans++;
      }
    }
    path.push(wp("exec", 0.08));
    path.push(wp("yvalve", 0.06, "result"));
    path.push(wp("harbor", 0, "done"));

    var emptyFloor = s.next > 1000 ? s.next : 999;
    var activeFloor = s.active.length ? Math.min.apply(null, s.active) : emptyFloor;
    var q = {
      x: FB.stations.harbor.x, y: FB.stations.harbor.y,
      path: path, idx: 0, dwell: 0.05,
      speed: 13,
      kind: isUpdate ? "update" : "select",
      attachment: Math.floor(Math.random() * 4),
      table: tableIdx,
      firstTable: tableIdx,
      stmtCached: false,
      needsPlan: false,
      planApplied: true,
      plan: hasIndex && hasSort ? "INDEX+SORT"
        : hasIndex ? "INDEX"
        : hasSort ? "NATURAL+SORT" : "NATURAL",
      sql: sqlStr,
      planText: planStr,
      locksHeld: [],
      waitingOn: -1,
      hadLockWait: false,
      startCn: s.commitNumber,
      stmtCn: s.commitNumber,
      phase: "sql",
      txn: null,
      snap: null,
      traced: false,
      waiting: false,
      dead: false,
      lat: newLat(),
      latBucket: "travel"
    };
    if (isUpdate) {
      q.txn = s.next++;
      s.active.push(q.txn);
      q.snap = Math.min(activeFloor, q.txn);
    } else {
      q.snap = activeFloor;
    }
    s.particles.push(q);
    refreshMarkers(s);
    say(s, "Live engine plan (" + q.plan + "): " +
      sqlStr.replace(/\s+/g, " ").slice(0, 48));
    return q;
  }

  function ingestTelemetry(s, tel) {
    if (!tel || typeof tel !== "object") return null;
    s.telemetryEvents++;
    s.lastTelemetry = {
      sql: tel.sql || "",
      planText: tel.planText || "",
      info: tel.info || null
    };
    if (tel.sql || tel.planText) {
      return spawnExplainedQuery(s, tel.sql, tel.planText);
    }
    return null;
  }

  function setStmtCacheRatio(s, ratio) {
    var r = Math.max(0, Math.min(1, +ratio || 0));
    s.stmtCacheRatio = r;
  }

  function recomputeStatistics(s) {
    for (var i = 0; i < TABLE_COUNT; i++) {
      s.tables[i].statDrift = 0;
    }
    s.statsRecomputed++;
    say(s, "SET STATISTICS INDEX: recomputed RDB$STATISTICS across all " +
      TABLE_COUNT + " tables.");
  }

  function degradeStatistics(s) {
    for (var i = 0; i < TABLE_COUNT; i++) {
      s.tables[i].statDrift = 0.35;
    }
    say(s, "Index statistics drifted stale after bulk modifications — " +
      "optimizer shifting to NATURAL + SORT.");
  }

  function setIsolationMode(s, mode) {
    if (mode !== "read_consistency" && mode !== "snapshot") return;
    if (s.isolationMode === mode) return;
    s.isolationMode = mode;
    say(s, mode === "read_consistency"
      ? "Isolation set to READ COMMITTED READ CONSISTENCY — commit-order snapshots & write-conflict restarts."
      : "Isolation set to SNAPSHOT (CONCURRENCY) — concurrent updates to the same row raise update conflicts.");
  }

  function setLockMode(s, mode) {
    if (mode !== "wait" && mode !== "nowait") return;
    if (s.lockMode === mode) return;
    s.lockMode = mode;
    say(s, mode === "nowait"
      ? "Lock mode set to NO WAIT — conflicting writers abort immediately."
      : "Lock mode set to WAIT — conflicting writers queue at the Lock Manager Tower.");
  }

  function setForcedWrites(s, on) {
    var val = !!on;
    if (s.forcedWrites === val) return;
    s.forcedWrites = val;
    say(s, val
      ? "Forced writes ON — commits flush dirty pages synchronously in precedence order."
      : "Forced writes OFF — commits return fast in RAM; dirty pages buffer in cache.");
  }

  function setGcPolicy(s, policy) {
    if (policy !== "cooperative" && policy !== "background" && policy !== "combined") return;
    if (s.gcPolicy === policy) return;
    s.gcPolicy = policy;
    say(s, "GC policy set to " + policy + ".");
  }

  function setLongTxn(s, on) {
    if (on && s.pinned === null) {
      s.pinned = s.next++;
      refreshMarkers(s);
      say(s, "Transaction " + s.pinned + " started... and forgot to commit. OIT pinned.");
    } else if (!on && s.pinned !== null) {
      say(s, "Transaction " + s.pinned + " finally committed. OIT may advance; GC resumes.");
      s.pinned = null;
      refreshMarkers(s);
    }
    s.longTxn = on;
  }

  function burst(s, n) {
    s.burstQueue += n;
    say(s, n + " queries incoming — rush hour at the harbor.");
  }

  function tick(s, dt) {
    if (dt > 0.1) dt = 0.1;
    s.time += dt;

    // spawn
    s.spawnAcc += dt * s.queryRate;
    if (s.burstQueue > 0) {
      var b = Math.min(s.burstQueue, Math.ceil(dt * 40));
      for (var k = 0; k < b; k++) spawnQuery(s);
      s.burstQueue -= b;
    }
    while (s.spawnAcc >= 1) {
      s.spawnAcc -= 1;
      if (s.particles.length < 260) spawnQuery(s);
    }

    moveParticles(s, dt);
    tickBackgroundGC(s, dt);
    tickCacheWriter(s, dt);
    tickSweep(s, dt);
    tickGbak(s, dt);
    tickNbackup(s, dt);
    tickReplication(s, dt);

    // decay flashes
    var i;
    for (i = 0; i < s.cache.length; i++) {
      if (s.cache[i].flash > 0) s.cache[i].flash -= dt * 2.2;
    }
    for (i = 0; i < s.tables.length; i++) {
      if (s.tables[i].flash > 0) s.tables[i].flash -= dt * 1.8;
    }
    if (s.diskFlash > 0) s.diskFlash -= dt * 2.5;

    // 1-second stats window
    s.statTimer += dt;
    if (s.statTimer >= 1) {
      s.qps = s.qps * 0.5 + (s.done / s.statTimer) * 0.5;
      s.done = 0;
      var total = s.hits + s.misses;
      if (total > 0) {
        s.hitRatio = s.hitRatio * 0.6 + (s.hits / total) * 0.4;
      }
      s.hits = 0; s.misses = 0;
      s.statTimer = 0;
    }
  }

  return {
    create: create,
    tick: tick,
    warm: warm,
    setCacheSize: setCacheSize,
    setServerMode: setServerMode,
    setStmtCacheRatio: setStmtCacheRatio,
    spawnExplainedQuery: spawnExplainedQuery,
    ingestTelemetry: ingestTelemetry,
    recomputeStatistics: recomputeStatistics,
    degradeStatistics: degradeStatistics,
    setIsolationMode: setIsolationMode,
    setLockMode: setLockMode,
    setForcedWrites: setForcedWrites,
    setGcPolicy: setGcPolicy,
    setLongTxn: setLongTxn,
    startSweep: startSweep,
    burst: burst,
    startTrace: startTrace,
    traceNext: traceNext,
    traceAuto: traceAuto,
    tracePause: tracePause,
    endTrace: endTrace,
    startGbak: startGbak,
    startNbackup: startNbackup,
    toggleLock: toggleLock,
    restoreChain: restoreChain,
    startChallenge: startChallenge,
    answerChallenge: answerChallenge,
    endChallenge: endChallenge,
    setReplMode: setReplMode,
    setReplHealth: setReplHealth,
    replLag: replLag,
    latencyProfile: latencyProfile,
    LAT_KEYS: LAT_KEYS,
    LAT_WORK_KEYS: LAT_WORK_KEYS,
    SEGMENT_SIZE: SEGMENT_SIZE,
    TABLE_COUNT: TABLE_COUNT,
    PAGE_SPACE: PAGE_SPACE
  };
})();
