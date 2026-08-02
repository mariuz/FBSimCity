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
      sweepInterval: 25,     // seconds
      longTxn: false,

      // transaction counters
      next: 1000,
      oat: 999,
      oit: 999,
      pinned: null,          // id of the long-running txn, when active
      active: [],            // ids of in-flight write txns

      // MVCC towers
      tables: [],
      totalVersions: 0,

      // page cache: slots of {page, lastUse, flash, state}
      cache: [],
      hits: 0, misses: 0,
      hitRatio: 1,

      // stats
      qps: 0, done: 0, statTimer: 0,
      lockWaits: 0, rollbacks: 0,

      // sweep
      sweepTimer: 0, sweepActive: false, sweepProgress: 0, sweepBlocked: false,

      // run control
      paused: false, speed: 1,

      // cache bookkeeping
      evictions: 0, dirtyEvictions: 0, pageWrites: 0,

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
        syncWaits: 0,         // commits that paid synchronous send latency
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
      // well below the initial markers, like rows loaded long ago)
      s.tables.push({ versions: 1, flash: 0, chain: [960 + i] });
    }
    setCacheSize(s, s.cacheSize);
    say(s, "Database on line. Cache " + s.cacheSize + " pages, sweep every " +
      s.sweepInterval + "s.");
    return s;
  }

  function say(s, msg) {
    s.log.push({ t: s.time, msg: msg });
    if (s.log.length > 6) s.log.shift();
  }

  function setCacheSize(s, n) {
    s.cacheSize = n;
    s.cache = [];
    for (var i = 0; i < n; i++) {
      // state drives the flash colour only; `dirty` is the real bookkeeping
      s.cache.push({ page: -1, lastUse: 0, flash: 0, state: 0, dirty: false });
    }
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
  function cacheAccess(s, isWrite) {
    var page = pickPage();
    var slot = null, lru = null, i;
    for (i = 0; i < s.cache.length; i++) {
      var c = s.cache[i];
      if (c.page === page) { slot = c; break; }
      if (!lru || c.lastUse < lru.lastUse) lru = c;
    }
    if (slot) {
      slot.lastUse = s.time;
      slot.flash = 1;
      slot.state = isWrite ? 3 : 1; // 1 hit, 3 dirty
      if (isWrite) slot.dirty = true;
      s.hits++;
      return true;
    }
    if (lru.page >= 0) {
      s.evictions++;
      // Evicting a DIRTY buffer is not free: the page must be written out
      // before its frame can be reused, so the reader pays for someone
      // else's write. This is where "my SELECT got slow" often comes from.
      if (lru.dirty) {
        s.dirtyEvictions++;
        pageWrite(s, lru.page);
      }
    }
    lru.page = page;
    lru.lastUse = s.time;
    lru.flash = 1;
    lru.state = 2; // miss / freshly faulted
    // faulting a page in to modify it leaves it dirty straight away
    lru.dirty = !!isWrite;
    s.misses++;
    s.diskFlash = 1;
    s.diskPos = page / PAGE_SPACE;
    return false;
  }

  /* Forced writes (the Firebird default): a commit does not return until its
   * pages are safely on disk, so committing cleans buffers as it goes. This
   * is what keeps most evictions cheap on a healthy database. */
  function flushDirty(s, n) {
    for (var i = 0; i < s.cache.length && n > 0; i++) {
      var c = s.cache[i];
      if (c.dirty) {
        c.dirty = false;
        pageWrite(s, c.page);
        n--;
      }
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
    // versions older than this may be garbage collected
    return s.pinned !== null ? s.pinned : s.next;
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
    var floor = s.active.length ? Math.min.apply(null, s.active) : s.next;
    var h = holder(s);
    s.oat = h !== null ? Math.min(h, floor) : floor;
    // OIT trails OAT; a pinned txn freezes it hard.
    s.oit = h !== null ? h : s.oat;
  }

  function coopGC(s) {
    // a reader tidies one chain it walked through, if allowed
    if (holder(s) !== null) return;
    var t = s.tables[Math.floor(Math.random() * TABLE_COUNT)];
    if (t.versions > 1) {
      t.chain.shift();
      t.versions--;
      s.totalVersions--;
      t.flash = 0.6;
    }
  }

  // ---- query particles -------------------------------------------------

  function wp(id, dwell, act) {
    var p = FB.stations[id];
    return { x: p.x, y: p.y, dwell: dwell || 0, act: act || null, at: id };
  }

  function spawnQuery(s, traced) {
    var isUpdate = traced ? true : Math.random() < s.updateRatio;
    var reads = traced ? 2 : 1 + Math.floor(Math.random() * 3);
    var path = [
      wp("harbor", 0.05),
      wp("yvalve", 0.12),
      wp("lexer", 0.15),
      wp("parser", 0.2),
      wp("blrgen", 0.15, "blr"),
      wp("security", 0.08),
      wp("cmp", 0.25, "compile"),
      wp("exec", 0.15)
    ];
    for (var i = 0; i < reads; i++) path.push(wp("cache", 0.1, "page"));
    if (isUpdate) {
      path.push(wp("lock", 0.12, "lock"));
      path.push(wp("mvcc", 0.18, "version"));
      path.push(wp("cache", 0.08, "wpage"));
      path.push(wp("tra", 0.12, "commit"));
    } else if (Math.random() < 0.45) {
      path.push(wp(Math.random() < 0.5 ? "btr" : "sort", 0.15));
    }
    path.push(wp("exec", 0.08));
    path.push(wp("yvalve", 0.06, "result"));
    path.push(wp("harbor", 0, "done"));

    var q = {
      x: FB.stations.harbor.x, y: FB.stations.harbor.y,
      path: path, idx: 0, dwell: 0.05,
      speed: traced ? 8 : 12 + Math.random() * 5,
      kind: isUpdate ? "update" : "select",
      phase: "sql",           // sql -> blr -> result
      txn: null,
      traced: !!traced,
      waiting: false,
      dead: false
    };
    if (isUpdate) {
      q.txn = s.next++;
      s.active.push(q.txn);
      refreshMarkers(s);
    }
    s.particles.push(q);
    return q;
  }

  function finishTxn(s, q, rolledBack) {
    if (q.txn === null) return;
    var i = s.active.indexOf(q.txn);
    if (i >= 0) s.active.splice(i, 1);
    if (rolledBack) s.rollbacks++;
    q.txn = null;
    refreshMarkers(s);
  }

  function arrive(s, q) {
    var step = q.path[q.idx];
    if (q.traced) {
      s.traceStage = step.at;
      s.traceNote = "";
    }
    switch (step.act) {
      case "blr":
        q.phase = "blr";
        break;
      case "page":
        if (cacheAccess(s, false)) {
          if (q.traced) s.traceNote = "hit";
          if (Math.random() < 0.35) coopGC(s);
        } else {
          if (q.traced) s.traceNote = "miss";
          // miss: detour down to the database file and back
          q.path.splice(q.idx + 1, 0, wp("pio", 0.22), wp("cache", 0.05));
        }
        break;
      case "wpage": {
        var wHit = cacheAccess(s, true);
        if (q.traced) s.traceNote = wHit ? "hit" : "miss";
        break;
      }
      case "lock":
        // contention: some writers queue at the tower (traced queries are
        // spared, so the guided walk stays predictable)
        if (!q.traced && Math.random() < 0.22) {
          q.waiting = true;
          q.dwell += 0.5 + Math.random() * 1.6;
          s.lockWaits++;
          if (Math.random() < 0.06 && !q.traced) {
            // deadlock victim: rollback, go home early
            say(s, "Deadlock scan: txn " + q.txn + " rolled back.");
            finishTxn(s, q, true);
            q.phase = "rollback";
            q.path = q.path.slice(0, q.idx + 1)
              .concat([wp("exec", 0.05), wp("yvalve", 0.05), wp("harbor", 0, "done")]);
          }
        }
        break;
      case "version": {
        var t = s.tables[Math.floor(Math.random() * TABLE_COUNT)];
        if (t.versions < MAX_CHAIN) {
          t.chain.push(q.txn);
          t.versions++;
          s.totalVersions++;
        }
        t.flash = 1;
        break;
      }
      case "commit":
        finishTxn(s, q, false);
        // Forced writes: this update dirtied one page, so its commit takes
        // one page to disk. Dirty evictions stay rare on a healthy database
        // for exactly this reason — the cost lands at commit instead.
        flushDirty(s, 1);
        replicateCommit(s, q);
        break;
      case "result":
        if (q.phase !== "rollback") q.phase = "result";
        break;
      case "done":
        q.dead = true;
        s.done++;
        break;
    }
    q.waiting = q.waiting && step.act === "lock";
    // step mode: a traced query parks at every station until "Next step"
    if (q.traced && s.traceStep && !q.dead) q.dwell = 1e9;
  }

  function moveParticles(s, dt) {
    for (var i = 0; i < s.particles.length; i++) {
      var q = s.particles[i];
      if (q.dwell > 0) { q.dwell -= dt; q.waiting = q.waiting && q.dwell > 0; continue; }
      q.waiting = false;
      var step = q.path[q.idx];
      var dx = step.x - q.x, dy = step.y - q.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var move = q.speed * dt;
      if (dist <= move || dist < 0.001) {
        q.x = step.x; q.y = step.y;
        arrive(s, q);
        q.dwell = Math.max(q.dwell, step.dwell);
        q.idx++;
        if (q.idx >= q.path.length) q.dead = true;
      } else {
        q.x += dx / dist * move;
        q.y += dy / dist * move;
      }
    }
    s.particles = s.particles.filter(function (q) { return !q.dead; });
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
      s.sweepBlocked = true;
      var why = s.pinned !== null ? "long-running transaction"
                                  : "gbak's snapshot";
      say(s, manual ? "Sweep requested — but " + why + " pins the OIT."
        : "Sweep skipped: " + why + " pins the OIT.");
      return;
    }
    s.sweepBlocked = false;
    s.sweepActive = true;
    s.sweepProgress = 0;
    say(s, "Sweep started: demolishing versions older than OIT " + s.oit + ".");
  }

  function tickSweep(s, dt) {
    s.sweepTimer += dt;
    if (s.sweepEnabled && s.sweepTimer >= s.sweepInterval) {
      s.sweepTimer = 0;
      startSweep(s, false);
    }
    if (!s.sweepActive) return;
    var before = Math.floor(s.sweepProgress * TABLE_COUNT);
    s.sweepProgress += dt / 4; // 4-second tour
    var upto = Math.min(TABLE_COUNT, Math.floor(s.sweepProgress * TABLE_COUNT));
    for (var i = before; i < upto; i++) {
      var t = s.tables[i];
      if (t.versions > 1) {
        s.totalVersions -= (t.versions - 1);
        t.chain = [t.chain[t.chain.length - 1]];
        t.versions = 1;
        t.flash = 1;
      }
    }
    if (s.sweepProgress >= 1.05) {
      s.sweepActive = false;
      say(s, "Sweep finished. City is clean.");
    }
  }

  // ---- logical replication ---------------------------------------------
  //
  // Firebird has no WAL to ship, so replication is logical: the committed
  // changes themselves are journalled into segments and replayed on the
  // replica in commit order.

  var SEGMENT_SIZE = 20;      // changes per journal segment (scaled)

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
      r.syncWaits++;
      r.applied++;                       // the replica has it as we commit
      if (q) q.dwell += r.health === "slow" ? 0.9 : 0.25;
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
    setCacheSize: setCacheSize,
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
    SEGMENT_SIZE: SEGMENT_SIZE,
    TABLE_COUNT: TABLE_COUNT,
    PAGE_SPACE: PAGE_SPACE
  };
})();
