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
      s.tables.push({ versions: 1, flash: 0 });
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
      s.cache.push({ page: -1, lastUse: 0, flash: 0, state: 0 }); // 0 empty
    }
  }

  // Skewed page access — hot pages get most traffic.
  function pickPage() {
    return Math.floor(Math.pow(Math.random(), 2.8) * PAGE_SPACE);
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
      s.hits++;
      return true;
    }
    lru.page = page;
    lru.lastUse = s.time;
    lru.flash = 1;
    lru.state = 2; // miss / freshly faulted
    s.misses++;
    s.diskFlash = 1;
    s.diskPos = page / PAGE_SPACE;
    return false;
  }

  function oldestVisible(s) {
    // versions older than this may be garbage collected
    return s.pinned !== null ? s.pinned : s.next;
  }

  function refreshMarkers(s) {
    var floor = s.active.length ? Math.min.apply(null, s.active) : s.next;
    s.oat = s.pinned !== null ? Math.min(s.pinned, floor) : floor;
    // OIT trails OAT; a pinned txn freezes it hard.
    s.oit = s.pinned !== null ? s.pinned : s.oat;
  }

  function coopGC(s) {
    // a reader tidies one chain it walked through, if allowed
    if (s.pinned !== null) return;
    var t = s.tables[Math.floor(Math.random() * TABLE_COUNT)];
    if (t.versions > 1) {
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

  function spawnQuery(s) {
    var isUpdate = Math.random() < s.updateRatio;
    var reads = 1 + Math.floor(Math.random() * 3);
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
      speed: 12 + Math.random() * 5,
      kind: isUpdate ? "update" : "select",
      phase: "sql",           // sql -> blr -> result
      txn: null,
      waiting: false,
      dead: false
    };
    if (isUpdate) {
      q.txn = s.next++;
      s.active.push(q.txn);
      refreshMarkers(s);
    }
    s.particles.push(q);
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
    switch (step.act) {
      case "blr":
        q.phase = "blr";
        break;
      case "page":
        if (cacheAccess(s, false)) {
          if (Math.random() < 0.35) coopGC(s);
        } else {
          // miss: detour down to the database file and back
          q.path.splice(q.idx + 1, 0, wp("pio", 0.22), wp("cache", 0.05));
        }
        break;
      case "wpage":
        cacheAccess(s, true);
        break;
      case "lock":
        // contention: some writers queue at the tower
        if (Math.random() < 0.22) {
          q.waiting = true;
          q.dwell += 0.5 + Math.random() * 1.6;
          s.lockWaits++;
          if (Math.random() < 0.06) {
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
          t.versions++;
          s.totalVersions++;
        }
        t.flash = 1;
        break;
      }
      case "commit":
        finishTxn(s, q, false);
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
  }

  // ---- sweep -----------------------------------------------------------

  function startSweep(s, manual) {
    if (s.sweepActive) return;
    if (s.pinned !== null) {
      s.sweepBlocked = true;
      say(s, manual ? "Sweep requested — but the OIT is pinned; nothing to do."
        : "Sweep skipped: long-running transaction pins the OIT.");
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
        t.versions = 1;
        t.flash = 1;
      }
    }
    if (s.sweepProgress >= 1.05) {
      s.sweepActive = false;
      say(s, "Sweep finished. City is clean.");
    }
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
    TABLE_COUNT: TABLE_COUNT,
    PAGE_SPACE: PAGE_SPACE
  };
})();
