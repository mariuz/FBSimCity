/* FBSimCity — control panel, stats + sparklines, info panel, guided tour,
 * scenarios, query trace, theme switcher, help & page-anatomy overlays. */
var UI = (function () {
  "use strict";

  var els = {};
  var tourIdx = -1;
  var onFocus = null; // callback(buildingId, zoom)
  var simRef = null;
  var hist = { t: [], qps: [], hit: [], gap: [], vers: [], p50: [], p95: [], events: [] };
  var lastHistPush = -1;
  var prevSweepActive = false;
  var telemHoverIdx = -1;

  function recordTelemetryEvent(label, color) {
    if (!simRef) return;
    hist.events.push({
      t: Math.floor(simRef.time),
      label: label,
      color: color || "#74c0fc"
    });
    if (hist.events.length > 24) hist.events.shift();
  }

  function $(id) { return document.getElementById(id); }

  // ---- trace narration -------------------------------------------------

  var TRACE_STAGES = {
    harbor: { name: "Client Harbor (REMOTE)",
      text: "The statement leaves the client application. The remote layer packages it for the wire — TCP/IP or XNET shared memory." },
    yvalve: { name: "Y-Valve Gate",
      text: "The Y-valve dispatches the call to the right provider. On the way back it routes result batches to the client." },
    lexer: { name: "Lexer (DSQL)",
      text: "The lexical analyzer splits the SQL text into tokens: keywords, identifiers, literals, operators." },
    parser: { name: "Parser (DSQL)",
      text: "The parser builds a syntax tree from the tokens, checking the statement is well-formed SQL." },
    blrgen: { name: "BLR Generator (DSQL)",
      text: "The code generator emits BLR — Binary Language Representation, the engine's native language. The particle turns violet: it no longer speaks SQL." },
    security: { name: "Security Gatehouse (SCL)",
      text: "Privileges on every object the statement touches are checked against the security database." },
    cmp: { name: "Compiler & Optimizer (CMP)",
      text: "CMP compiles BLR into an execution tree. The optimizer consults the Metadata Library (RDB$ tables) and picks indexes and join order." },
    exec: { name: "Execution Hall (EXE)",
      text: "The execution engine interprets the request tree, pulling rows through record streams and coordinating every other subsystem." },
    cache: { name: "Page Cache Plaza (CCH)",
      text: "A page is requested from the buffer cache.",
      hit: "Cache HIT — the page is already buffered; no disk trip needed.",
      miss: "Cache MISS — the page is not buffered. Down to the database file we go." },
    pio: { name: "Database File (PIO)",
      text: "Physical I/O reads the page from the database file and hauls it up into a cache buffer, evicting the least-recently-used page if the cache is full." },
    lock: { name: "Lock Manager Tower (LOCK)",
      text: "Before modifying, a lock on the resource is requested in the shared-memory lock table. Contending writers queue here.",
      deadlock: "Deadlock victim — the Lock Manager detected a wait-for cycle and rolled back this transaction, sending an error back to the client." },
    mvcc: { name: "Record Version Towers (VIO)",
      text: "Record version check / write: UPDATE chains a new version on top of the old delta; SELECT walks the chain until it finds a version visible to its snapshot." },
    tra: { name: "Transaction Hall (TRA)",
      text: "COMMIT: the transaction's state bits flip on a Transaction Inventory Page. The new record version is now the committed truth." },
    btr: { name: "B-Tree Gardens (BTR)",
      text: "An index walk resolves the search condition to record numbers without scanning the table." },
    sort: { name: "Sort Yard (SORT)",
      text: "No index supplies the required order — the sorter builds sorted runs and merges them.",
      inmemory: "In-memory sort — the working set fits inside TempCacheLimit, so runs merge in RAM.",
      spill: "Sort spill — the working set exceeded TempCacheLimit and spilled scratch runs to disk." }
  };

  // ---- scenarios -------------------------------------------------------

  var SCENARIOS = {
    steady: {
      label: "Steady state",
      set: { rate: 6, writes: 35, cache: 64, sweepint: 25, sweepon: true, longtxn: false },
      focus: "exec", zoom: 0.9,
      msg: "Steady state: a healthy OLTP day. Everything hums."
    },
    thrash: {
      label: "Cache thrash",
      set: { rate: 14, writes: 20, cache: 16, sweepint: 25, sweepon: true, longtxn: false },
      focus: "cache", zoom: 1.3,
      msg: "Cache thrash: 16 buffers against a hot set of 40 pages. Watch the misses and the disk traffic."
    },
    stuckoit: {
      label: "Stuck OIT / version bloat",
      set: { rate: 8, writes: 60, cache: 64, sweepint: 25, sweepon: true, longtxn: true },
      focus: "mvcc", zoom: 1.2,
      msg: "A transaction forgot to commit. The OIT is pinned, GC is stalled — watch the towers grow and redden."
    },
    locks: {
      label: "Lock contention",
      set: { rate: 12, writes: 85, cache: 64, sweepint: 25, sweepon: true, longtxn: false },
      focus: "lock", zoom: 1.3,
      msg: "Write-heavy load: writers pile up at the lock tower, and the deadlock scanner starts choosing victims."
    },
    rush: {
      label: "Rush hour",
      set: { rate: 12, writes: 40, cache: 64, sweepint: 25, sweepon: true, longtxn: false },
      burst: 120,
      focus: "harbor", zoom: 1.1,
      msg: "Rush hour: 120 queries flood the harbor at once, on top of a high steady rate."
    },
    sweepstorm: {
      label: "Sweep storm",
      set: { rate: 10, writes: 70, cache: 64, sweepint: 10, sweepon: true, longtxn: false },
      focus: "gc", zoom: 1.2,
      msg: "Heavy writes with an aggressive 10-transaction sweep interval. The truck barely rests."
    },
    nightlygbak: {
      label: "Nightly gbak on a busy DB",
      set: { rate: 10, writes: 55, cache: 64, sweepint: 25, sweepon: true, longtxn: false },
      run: function (s) { Sim.startGbak(s); },
      focus: "gbak", zoom: 1.1,
      msg: "The nightly backup starts against a live workload. Watch the OIT pin itself for the whole run."
    },
    replicalag: {
      label: "Replica falling behind",
      set: { rate: 14, writes: 80, cache: 64, sweepint: 25, sweepon: true, longtxn: false },
      run: function (s) {
        Sim.setReplMode(s, "async");
        Sim.setReplHealth(s, "slow");
        setSelect("ctl-replmode", "async");
        setSelect("ctl-replhealth", "slow");
      },
      focus: "journal", zoom: 1.1,
      msg: "Heavy writes against a replica that applies slowly. Segments seal faster than they drain."
    },
    syncstall: {
      label: "Synchronous replica dies",
      set: { rate: 8, writes: 70, cache: 64, sweepint: 25, sweepon: true, longtxn: false },
      run: function (s) {
        Sim.setReplMode(s, "sync");
        Sim.setReplHealth(s, "down");
        setSelect("ctl-replmode", "sync");
        setSelect("ctl-replhealth", "down");
      },
      focus: "replicator", zoom: 1.2,
      msg: "Synchronous replica unreachable: disable_on_error stops replication. Commits carry on — nobody is blocked, and nobody is told."
    },
    nbackup: {
      label: "nbackup with delta",
      set: { rate: 10, writes: 70, cache: 64, sweepint: 25, sweepon: true, longtxn: false },
      run: function (s) { Sim.startNbackup(s, 0); },
      focus: "delta", zoom: 1.15,
      msg: "nbackup level 0 locks the file — every write now lands in the delta pit until it merges back."
    }
  };

  function applyScenario(key, noFly) {
    var sc = SCENARIOS[key];
    if (!sc) return;
    setRange("ctl-rate", sc.set.rate);
    setRange("ctl-update", sc.set.writes);
    setRange("ctl-cache", sc.set.cache);
    setRange("ctl-sweepint", sc.set.sweepint);
    setCheck("ctl-sweepon", sc.set.sweepon);
    setCheck("ctl-longtxn", sc.set.longtxn);
    if (sc.burst) Sim.burst(simRef, sc.burst);
    if (sc.run) sc.run(simRef);
    simRef.log.push({ t: simRef.time, msg: sc.msg });
    if (simRef.log.length > 6) simRef.log.shift();
    recordTelemetryEvent(sc.label, "#74c0fc");
    if (onFocus && !noFly) onFocus(sc.focus, sc.zoom);
  }

  function setRange(id, v) {
    var el = $(id);
    el.value = v;
    el.dispatchEvent(new Event("input"));
  }

  function setSelect(id, v) {
    var el = $(id);
    if (el && el.value !== v) el.value = v;
  }

  function setCheck(id, v) {
    var el = $(id);
    if (el.checked !== v) {
      el.checked = v;
      el.dispatchEvent(new Event("change"));
    }
  }

  // ---- init ------------------------------------------------------------

  function init(sim, focusCb) {
    simRef = sim;
    onFocus = focusCb;
    hist = { t: [], qps: [], hit: [], gap: [], vers: [], p50: [], p95: [], events: [] };
    lastHistPush = -1;
    prevSweepActive = false;
    telemHoverIdx = -1;
    els.info = $("info-panel");
    els.infoBody = $("info-body");
    els.infoTitle = $("info-title");
    els.infoCode = $("info-code");
    els.log = $("event-log");
    els.tour = $("tour");
    els.tourTitle = $("tour-title");
    els.tourText = $("tour-text");
    els.tourStep = $("tour-step");
    els.trace = $("trace-panel");
    els.traceStage = $("trace-stage");
    els.traceText = $("trace-text");

    bindRange("ctl-rate", function (v) { sim.queryRate = +v; },
      function (v) { return v + " q/s"; });
    bindRange("ctl-update", function (v) { sim.updateRatio = v / 100; },
      function (v) { return v + "% writes"; });
    bindRange("ctl-cache", function (v) { Sim.setCacheSize(sim, +v); },
      function (v) { return v + " pages"; });
    bindRange("ctl-tempcache", function (v) { sim.tempCacheLimit = +v; },
      function (v) { return v + " units"; });
    if ($("ctl-stmtcache")) {
      bindRange("ctl-stmtcache", function (v) { Sim.setStmtCacheRatio(sim, +v / 100); },
        function (v) { return +v === 0 ? "off" : v + "% hit"; });
    }
    bindRange("ctl-sweepint", function (v) { sim.sweepInterval = +v; },
      function (v) { return v + " txns"; });

    $("ctl-longtxn").addEventListener("change", function () {
      Sim.setLongTxn(sim, this.checked);
    });
    $("ctl-sweepon").addEventListener("change", function () {
      sim.sweepEnabled = this.checked;
    });
    if ($("ctl-forcedwrites")) {
      $("ctl-forcedwrites").addEventListener("change", function () {
        Sim.setForcedWrites(sim, this.checked);
      });
    }
    if ($("ctl-servermode")) {
      $("ctl-servermode").addEventListener("change", function () {
        Sim.setServerMode(sim, this.value);
      });
    }
    if ($("ctl-gcpolicy")) {
      $("ctl-gcpolicy").addEventListener("change", function () {
        Sim.setGcPolicy(sim, this.value);
      });
    }
    if ($("ctl-lockmode")) {
      $("ctl-lockmode").addEventListener("change", function () {
        Sim.setLockMode(sim, this.value);
      });
    }
    if ($("ctl-isolation")) {
      $("ctl-isolation").addEventListener("change", function () {
        Sim.setIsolationMode(sim, this.value);
      });
    }
    $("ctl-scenario").addEventListener("change", function () {
      if (this.value) applyScenario(this.value);
    });
    $("ctl-replmode").addEventListener("change", function () {
      Sim.setReplMode(sim, this.value);
    });
    $("ctl-replhealth").addEventListener("change", function () {
      Sim.setReplHealth(sim, this.value);
    });
    $("btn-sweep").addEventListener("click", function () {
      Sim.startSweep(sim, true);
      recordTelemetryEvent("Sweep", "#ffa94d");
    });
    $("btn-gbak").addEventListener("click", function () { Sim.startGbak(sim); });
    $("btn-nb0").addEventListener("click", function () { Sim.startNbackup(sim, 0); });
    $("btn-nb1").addEventListener("click", function () { Sim.startNbackup(sim, 1); });
    $("btn-lock").addEventListener("click", function () { Sim.toggleLock(sim); });
    $("btn-restore").addEventListener("click", function () { Sim.restoreChain(sim); });
    $("btn-burst").addEventListener("click", function () {
      Sim.burst(sim, 60);
    });
    if ($("btn-setstats")) {
      $("btn-setstats").addEventListener("click", function () {
        Sim.recomputeStatistics(sim);
      });
    }
    $("btn-tour").addEventListener("click", function () { startTour(); });
    $("tour-next").addEventListener("click", function () { stepTour(1); });
    $("tour-prev").addEventListener("click", function () { stepTour(-1); });
    $("tour-close").addEventListener("click", function () { endTour(); });
    $("info-close").addEventListener("click", function () {
      els.info.classList.add("hidden");
      infoSelectedId = null;
      syncInspectorTabs();
    });
    $("btn-about").addEventListener("click", function () { showAbout(); });

    // run control
    $("btn-pause").addEventListener("click", togglePause);
    $("btn-speed").addEventListener("click", cycleSpeed);

    // trace
    $("btn-trace").addEventListener("click", startTraceUI);
    if ($("trace-profile")) {
      $("trace-profile").addEventListener("change", function () {
        Sim.startTrace(sim, this.value);
        $("trace-auto").textContent = "Auto play";
        lastStageShown = null;
        lastNoteShown = null;
        updateTrace();
      });
    }
    if ($("trace-prev")) {
      $("trace-prev").addEventListener("click", function () {
        Sim.tracePrev(sim);
        $("trace-auto").textContent = "Auto play";
        lastStageShown = null;
        lastNoteShown = null;
        updateTrace();
        if (onFocus && sim.traceStage && FB.byId[sim.traceStage]) {
          onFocus(sim.traceStage, 1.2);
        }
      });
    }
    if ($("trace-inspect")) {
      $("trace-inspect").addEventListener("click", function () {
        if (sim.traceStage && FB.byId[sim.traceStage]) {
          showBuilding(sim.traceStage);
          if (onFocus) onFocus(sim.traceStage, 1.25);
        }
      });
    }
    $("trace-step").addEventListener("click", function () { Sim.traceNext(sim); });
    $("trace-auto").addEventListener("click", function () {
      if (sim.traceStep) { Sim.traceAuto(sim); this.textContent = "Pause steps"; }
      else { Sim.tracePause(sim); this.textContent = "Auto play"; }
    });
    $("trace-end").addEventListener("click", endTraceUI);

    // theme & shareable link
    $("btn-theme").addEventListener("click", toggleTheme);
    if ($("btn-share")) {
      $("btn-share").addEventListener("click", shareCurrentState);
    }
    var saved = null;
    try { saved = localStorage.getItem("fbsimcity-theme"); } catch (e) { }
    applyTheme(saved === "day" ? "day" : "dark");

    // overlays & inspector rail
    $("btn-decide").addEventListener("click", function () { openDecisions(); });
    $("btn-latency").addEventListener("click", function () {
      expandInspectorRail();
      $("latency-dock").classList.toggle("hidden");
      renderLatency();
      syncInspectorTabs();
    });
    $("latency-close").addEventListener("click", function () {
      $("latency-dock").classList.add("hidden");
      syncInspectorTabs();
    });
    $("decide-close").addEventListener("click", function () {
      Sim.endChallenge(simRef);
      $("decide-dock").classList.add("hidden");
      syncInspectorTabs();
    });

    var inspRail = $("inspector-rail");
    var inspToggle = $("inspector-toggle");
    if (inspToggle && inspRail) {
      inspToggle.addEventListener("click", function () {
        var c = !inspRail.classList.contains("collapsed");
        inspRail.classList.toggle("collapsed", c);
        inspToggle.textContent = c ? "+" : "−";
      });
    }
    var inspTabs = $("inspector-tabs");
    if (inspTabs) {
      inspTabs.querySelectorAll("[data-tab]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          expandInspectorRail();
          var tab = btn.getAttribute("data-tab");
          if (tab === "info") {
            if (els.info.classList.contains("hidden")) {
              if (infoSelectedId) showBuilding(infoSelectedId);
              else showAbout();
            } else {
              els.info.classList.add("hidden");
            }
          } else if (tab === "decisions") {
            if ($("decide-dock").classList.contains("hidden")) openDecisions();
            else $("decide-dock").classList.add("hidden");
          } else if (tab === "latency") {
            $("latency-dock").classList.toggle("hidden");
            renderLatency();
          } else if (tab === "trace") {
            if (els.trace.classList.contains("hidden")) startTraceUI();
            else endTraceUI();
          }
          syncInspectorTabs();
        });
      });
    }

    $("btn-help").addEventListener("click", function () { toggleOverlay("help-overlay"); });
    $("help-close").addEventListener("click", function () { toggleOverlay("help-overlay", false); });
    $("btn-anatomy").addEventListener("click", function () { toggleOverlay("anatomy-overlay"); });
    $("anatomy-close").addEventListener("click", function () { toggleOverlay("anatomy-overlay", false); });

    // expandable time-series telemetry drawer (#telemetry-drawer)
    var telemDrawer = $("telemetry-drawer");
    var telemClose = $("telemetry-close");
    var telemCanvas = $("telemetry-canvas");
    if (telemClose && telemDrawer) {
      telemClose.addEventListener("click", function () {
        telemDrawer.classList.add("hidden");
      });
    }
    var statsBar = $("stats");
    if (statsBar && telemDrawer) {
      statsBar.querySelectorAll(".stat").forEach(function (stEl) {
        if (stEl.classList.contains("version")) return;
        stEl.addEventListener("click", function () {
          telemDrawer.classList.toggle("hidden");
          renderTelemetryDrawer();
        });
      });
    }
    if (telemCanvas) {
      telemCanvas.addEventListener("mousemove", function (ev) {
        if (!hist.t.length) return;
        var r = telemCanvas.getBoundingClientRect();
        var relX = (ev.clientX - r.left) / Math.max(1, r.width) * telemCanvas.width;
        var padL = 94, padR = 12;
        var plotW = telemCanvas.width - padL - padR;
        var frac = Math.max(0, Math.min(1, (relX - padL) / Math.max(1, plotW)));
        telemHoverIdx = Math.round(frac * Math.max(0, hist.t.length - 1));
        renderTelemetryDrawer();
      });
      telemCanvas.addEventListener("mouseleave", function () {
        telemHoverIdx = -1;
        renderTelemetryDrawer();
      });
    }

    // district quick-jump pill bar (#district-jump)
    var jumpBar = $("district-jump");
    if (jumpBar) {
      var jHtml = "";
      FB.buildings.forEach(function (b) {
        var shortName = b.name.replace(/\s*\([^)]*\)\s*/g, "");
        jHtml += "<button type='button' class='jump-pill' data-jump='" + b.id +
          "' title='" + b.name + " (" + b.code + ")'>" + shortName + "</button>";
      });
      jumpBar.innerHTML = jHtml;
      jumpBar.querySelectorAll("[data-jump]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-jump");
          showBuilding(id);
          if (onFocus) onFocus(id, 1.3);
        });
      });
    }

    // collapsible control room — the city gets the screen back
    var ctrl = $("controls");
    var setCollapsed = function (c) {
      ctrl.classList.toggle("collapsed", c);
      $("controls-toggle").textContent = c ? "+" : "−";
      try { localStorage.setItem("fbsimcity-controls", c ? "closed" : "open"); } catch (e) { }
    };
    $("controls-toggle").addEventListener("click", function () {
      setCollapsed(!ctrl.classList.contains("collapsed"));
    });
    var savedCtl = null;
    try { savedCtl = localStorage.getItem("fbsimcity-controls"); } catch (e) { }
    if (savedCtl === "closed" ||
        (savedCtl === null && window.innerWidth < 900)) {
      setCollapsed(true);
    }

    // first-visit gesture hint, dismissed by the first gesture
    try {
      if (typeof BroadcastChannel !== "undefined") {
        var bc = new BroadcastChannel("fbsimcity-telemetry");
        bc.onmessage = function (ev) {
          if (ev && ev.data) Sim.ingestTelemetry(sim, ev.data);
        };
      }
    } catch (e) { }
    var hinted = null;
    try { hinted = localStorage.getItem("fbsimcity-hinted"); } catch (e) { }
    if (!hinted) {
      var hint = $("gesture-hint");
      hint.classList.remove("hidden");
      var dismiss = function () {
        hint.classList.add("hidden");
        try { localStorage.setItem("fbsimcity-hinted", "1"); } catch (e) { }
        window.removeEventListener("pointerdown", dismiss);
        window.removeEventListener("wheel", dismiss);
      };
      window.addEventListener("pointerdown", dismiss);
      window.addEventListener("wheel", dismiss);
      setTimeout(dismiss, 9000);
    }

    showAbout();

    // deep links: ?scenario=stuckoit&theme=day
    try {
      var params = new URLSearchParams(location.search);
      var th = params.get("theme");
      if (th === "day" || th === "dark") applyTheme(th);
      var sc = params.get("scenario");
      if (sc && SCENARIOS[sc]) {
        $("ctl-scenario").value = sc;
        applyScenario(sc, true); // stay on the city-wide view
        els.info.classList.add("hidden");
      }
      // ?lock=1 — leave the database locked, the way a forgotten
      // "nbackup -L" does. The delta then grows for as long as you watch.
      if (params.get("lock") === "1") Sim.toggleLock(simRef);
      if (params.get("rate") !== null) setRange("ctl-rate", +params.get("rate"));
      if (params.get("writes") !== null) setRange("ctl-update", +params.get("writes"));
      if (params.get("cache") !== null) setRange("ctl-cache", +params.get("cache"));
      var pn = params.get("panel");
      if (pn && FB.byId[pn]) showBuilding(pn);
      // ?dock=latency|decisions — open a side dock directly
      var dk = params.get("dock");
      if (dk === "latency") {
        $("latency-dock").classList.remove("hidden");
        renderLatency();
      } else if (dk === "decisions") {
        openDecisions();
      }
      syncInspectorTabs();
    } catch (e) { }
  }

  function bindRange(id, setter, fmt) {
    var el = $(id), out = $(id + "-val");
    var update = function () {
      setter(el.value);
      out.textContent = fmt(el.value);
    };
    el.addEventListener("input", update);
    update();
  }

  // ---- run control -----------------------------------------------------

  function togglePause() {
    simRef.paused = !simRef.paused;
    $("btn-pause").textContent = simRef.paused ? "▶ Resume" : "⏸ Pause";
  }

  function cycleSpeed() {
    var seq = [1, 2, 4, 0.5];
    var i = seq.indexOf(simRef.speed);
    simRef.speed = seq[(i + 1) % seq.length];
    $("btn-speed").textContent = simRef.speed + "×";
  }

  // ---- theme -----------------------------------------------------------

  function applyTheme(name) {
    Render.setTheme(name);
    document.body.classList.toggle("day", name === "day");
    $("btn-theme").textContent = name === "day" ? "🌙 Night" : "☀ Day";
    try { localStorage.setItem("fbsimcity-theme", name); } catch (e) { }
  }

  function toggleTheme() {
    applyTheme(document.body.classList.contains("day") ? "dark" : "day");
  }

  function buildShareUrl(s) {
    var st = s || simRef;
    var parts = [];
    var scEl = $("ctl-scenario");
    var sc = scEl ? scEl.value : "";
    if (sc && SCENARIOS[sc]) parts.push("scenario=" + encodeURIComponent(sc));
    if (document.body.classList.contains("day")) parts.push("theme=day");
    if (infoSelectedId && els.info && !els.info.classList.contains("hidden")) {
      parts.push("panel=" + encodeURIComponent(infoSelectedId));
    }
    if ($("decide-dock") && !$("decide-dock").classList.contains("hidden")) {
      parts.push("dock=decisions");
    } else if ($("latency-dock") && !$("latency-dock").classList.contains("hidden")) {
      parts.push("dock=latency");
    }
    if (st && st.backup && st.backup.locked) parts.push("lock=1");
    if (st) {
      var defRate = (sc && SCENARIOS[sc]) ? SCENARIOS[sc].set.rate : 6;
      var defWrites = (sc && SCENARIOS[sc]) ? SCENARIOS[sc].set.writes : 35;
      var defCache = (sc && SCENARIOS[sc]) ? SCENARIOS[sc].set.cache : 64;
      var curWrites = Math.round(st.updateRatio * 100);
      var curCache = st.cache ? st.cache.length : 64;
      if (st.queryRate !== defRate) parts.push("rate=" + st.queryRate);
      if (curWrites !== defWrites) parts.push("writes=" + curWrites);
      if (curCache !== defCache) parts.push("cache=" + curCache);
    }
    var base = location.origin + location.pathname;
    return parts.length ? (base + "?" + parts.join("&")) : base;
  }

  function shareCurrentState() {
    var url = buildShareUrl(simRef);
    try {
      if (location.pathname.indexOf("/test/") === -1 && history.replaceState) {
        history.replaceState(null, "", url);
      }
    } catch (e) { }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url);
      }
    } catch (e) { }
    var btn = $("btn-share");
    if (btn) {
      btn.textContent = "✓ Copied";
      setTimeout(function () { btn.textContent = "🔗 Share"; }, 1800);
    }
    announce("Shareable link copied to clipboard");
    return url;
  }

  // ---- overlays --------------------------------------------------------

  function toggleOverlay(id, force) {
    var el = $(id);
    var show = force !== undefined ? force : el.classList.contains("hidden");
    el.classList.toggle("hidden", !show);
  }

  function expandInspectorRail() {
    var rail = $("inspector-rail");
    var tog = $("inspector-toggle");
    if (rail && rail.classList.contains("collapsed")) {
      rail.classList.remove("collapsed");
      if (tog) tog.textContent = "−";
    }
  }

  function syncInspectorTabs() {
    var tabs = $("inspector-tabs");
    if (tabs) {
      var map = {
        info: els.info && !els.info.classList.contains("hidden"),
        decisions: $("decide-dock") && !$("decide-dock").classList.contains("hidden"),
        latency: $("latency-dock") && !$("latency-dock").classList.contains("hidden"),
        trace: els.trace && !els.trace.classList.contains("hidden")
      };
      tabs.querySelectorAll("[data-tab]").forEach(function (btn) {
        var k = btn.getAttribute("data-tab");
        btn.classList.toggle("active", !!map[k]);
      });
    }
    var jumpBar = $("district-jump");
    if (jumpBar) {
      var activeId = (els.info && !els.info.classList.contains("hidden")) ? infoSelectedId : null;
      jumpBar.querySelectorAll("[data-jump]").forEach(function (btn) {
        btn.classList.toggle("active", btn.getAttribute("data-jump") === activeId);
      });
    }
  }

  // ---- trace -----------------------------------------------------------

  function startTraceUI() {
    expandInspectorRail();
    var prof = $("trace-profile") ? $("trace-profile").value : "update";
    if (!simRef.tracedQ) {
      Sim.startTrace(simRef, prof);
      $("trace-auto").textContent = "Auto play";
      lastStageShown = null;
      lastNoteShown = null;
    }
    els.trace.classList.remove("hidden");
    updateTrace();
    syncInspectorTabs();
  }

  function endTraceUI() {
    Sim.endTrace(simRef);
    els.trace.classList.add("hidden");
    syncInspectorTabs();
  }

  var lastStageShown = null, lastNoteShown = null;

  function updateTrace() {
    if (!els.trace || els.trace.classList.contains("hidden")) return;
    if (!simRef.tracedQ) {
      // trace finished on its own
      els.traceStage.textContent = "Trace complete";
      els.traceText.textContent =
        "The result reached the client. Run another trace, or keep exploring.";
      return;
    }
    var stage = simRef.traceStage, note = simRef.traceNote;
    if (stage === lastStageShown && note === lastNoteShown) return;
    lastStageShown = stage; lastNoteShown = note;
    var st = TRACE_STAGES[stage];
    if (!st) return;
    els.traceStage.textContent = st.name;
    var text = st.text;
    if (note && st[note]) text = st[note];
    els.traceText.textContent = text;
  }

  // ---- operator decisions ----------------------------------------------
  //
  // Non-modal: the city keeps running behind the dock, because the whole
  // point is that the situation is getting worse while you decide.

  function openDecisions() {
    // Inside #inspector-rail, #decide-dock and #info-panel stack vertically
    // so you can read a building's src/jrd/ notes while evaluating a decision.
    expandInspectorRail();
    var dock = $("decide-dock");
    dock.classList.remove("hidden");
    renderDecisions();
    syncInspectorTabs();
  }

  function renderDecisions() {
    var body = $("decide-body"), s = simRef;
    var html = "";

    if (s.verdict) {
      var vdef = challengeById(s.verdict.id);
      var chosen = null;
      vdef.options.forEach(function (o) {
        if (o.id === s.verdict.choice) chosen = o;
      });
      html += "<p class='decide-chose'>You chose: <b>" + chosen.label + "</b></p>";
      html += "<div class='verdict'>";
      s.verdict.lines.forEach(function (l) { html += "<p>" + l + "</p>"; });
      html += "</div>";
      html += "<div class='panel-actions'><button class='act' data-back='1'>" +
        "Back to the list</button></div>";
    } else if (s.challenge) {
      var def = challengeById(s.challenge.id);
      html += "<h4>" + def.title + "</h4>";
      html += "<p>" + def.situation + "</p>";
      html += "<p class='fine decide-live'>The city is still running while " +
        "you decide.</p>";
      html += "<div class='decide-options'>";
      def.options.forEach(function (o) {
        html += "<button class='decide-opt' data-choice='" + o.id + "'>" +
          "<b>" + o.label + "</b><span>" + o.detail + "</span></button>";
      });
      html += "</div>";
    } else {
      html += "<p class='fine'>Seven situations where Firebird hands you a " +
        "genuinely hard call. Both answers cost something, and the verdict " +
        "is measured from what actually happens in the model.</p>";
      html += "<div class='decide-options'>";
      FB.challenges.forEach(function (c) {
        html += "<button class='decide-opt' data-start='" + c.id + "'>" +
          "<b>" + c.title + "</b></button>";
      });
      html += "</div>";
    }
    body.innerHTML = html;

    body.querySelectorAll("[data-start]").forEach(function (b) {
      b.addEventListener("click", function () {
        Sim.startChallenge(simRef, b.getAttribute("data-start"));
        renderDecisions();
      });
    });
    body.querySelectorAll("[data-choice]").forEach(function (b) {
      b.addEventListener("click", function () {
        var ch = b.getAttribute("data-choice");
        Sim.answerChallenge(simRef, ch);
        recordTelemetryEvent("Decision: " + ch, "#fcc419");
        renderDecisions();
      });
    });
    var back = body.querySelector("[data-back]");
    if (back) {
      back.addEventListener("click", function () {
        Sim.endChallenge(simRef);
        renderDecisions();
      });
    }
  }

  function challengeById(id) {
    var found = null;
    FB.challenges.forEach(function (c) { if (c.id === id) found = c; });
    return found;
  }

  // ---- latency decomposition -------------------------------------------
  //
  // Measured from completed trips, not asserted. Every bucket is charged
  // from real elapsed time in the model, so the parts sum to the whole.

  var LAT_LABELS = {
    compile: "Parse &amp; compile (DSQL, CMP)",
    cacheHit: "Page cache",
    diskRead: "Disk reads (cache misses)",
    sortSpill: "Sorting (incl. spills)",
    lockWait: "Lock waits",
    version: "Record versions (write + chain walk)",
    commit: "Commit (TIP + forced write)",
    repl: "Replication send (sync only)",
    travel: "Everything else in flight"
  };

  function renderLatency() {
    var dock = $("latency-dock");
    if (dock.classList.contains("hidden")) return;
    var p = Sim.latencyProfile(simRef);
    var body = $("latency-body");
    if (!p) {
      body.innerHTML = "<p class='fine'>No completed queries yet — let the " +
        "city run for a moment.</p>";
      return;
    }
    var html = "<p class='fine'>Mean work per query over the last <b>" + p.n +
      "</b> completed trips — <b>" + p.workTotal.toFixed(2) + "s</b> of " +
      "engine work each.</p><div class='latbars'>";
    // biggest contributor first — that is the one worth arguing with
    var keys = p.workKeys.slice().sort(function (a, b) {
      return p.mean[b] - p.mean[a];
    });
    keys.forEach(function (k) {
      var v = p.mean[k];
      var pct = p.workTotal > 0 ? (v / p.workTotal) * 100 : 0;
      if (v < 0.001) return;
      html += "<div class='latrow'>" +
        "<span class='latname'>" + LAT_LABELS[k] + "</span>" +
        "<span class='latbar'><i style='width:" + pct.toFixed(1) + "%'></i></span>" +
        "<span class='latval'>" + v.toFixed(2) + "s <b>" +
        pct.toFixed(0) + "%</b></span></div>";
    });
    html += "</div>";
    html += "<p class='fine'>Shrink the page cache and watch disk reads take " +
      "over. Drop sort memory and the sort bar grows. Switch replication to " +
      "synchronous and a new bar appears that was not there before.</p>";
    html += "<p class='fine excluded'><b>Excluded:</b> " +
      p.mean.travel.toFixed(2) + "s per query is spent moving between " +
      "districts. That is a property of drawing a city, not of running a " +
      "database — a real query does not walk anywhere — so it is kept out " +
      "of the percentages above rather than allowed to dominate them.</p>";
    html += correctionLink("the latency model");
    body.innerHTML = html;
  }

  // ---- correction links ------------------------------------------------
  //
  // Every announcement says corrections are welcome; this makes acting on
  // that a single click rather than a research project. No tracking of any
  // kind is attached to these links.

  function correctionLink(what) {
    var title = encodeURIComponent("Model correction: " + what);
    var body = encodeURIComponent(
      "**What FBSimCity shows**\n\n(what the model does today)\n\n" +
      "**What Firebird actually does**\n\n(the real behaviour)\n\n" +
      "**Source**\n\n(a file in FirebirdSQL/firebird, a doc, or your own " +
      "experience — all welcome)\n\n---\n" +
      "Subject: " + what + "\nVersion: v" + FB.VERSION + "\n");
    return "<p class='fine correction'><a href='https://github.com/mariuz/" +
      "FBSimCity/issues/new?title=" + title + "&body=" + body +
      "' target='_blank' rel='noopener'>Something wrong here? Report it &rarr;</a></p>";
  }

  // ---- info panel ------------------------------------------------------

  var infoSelectedId = null;
  var selectedTowerIdx = null;

  function showBuilding(id, towerIdx) {
    var b = FB.byId[id];
    if (!b) return;
    expandInspectorRail();
    infoSelectedId = id;
    if (id === "mvcc") {
      selectedTowerIdx = (towerIdx !== undefined && towerIdx !== null && towerIdx >= 0)
        ? towerIdx : null;
    } else {
      selectedTowerIdx = null;
    }
    els.infoTitle.textContent = b.name;
    els.infoCode.textContent = b.code;
    els.infoCode.style.display = "";
    els.infoBody.innerHTML = "<p>" + b.desc + "</p>" +
      (id === "mvcc" ? "<div id='chain-live'></div>" : "") +
      (id === "lock" ? "<div id='lock-live'></div>" : "") +
      (id === "harbor" ? "<div id='wq-live'></div>" : "") +
      (id === "cmp" || id === "btr" || id === "met" ? "<div id='opt-live'></div>" : "") +
      actionsFor(id) +
      correctionLink(b.name + " (" + b.code + ")");
    if (id === "mvcc") renderChain(simRef);
    if (id === "lock") renderLocks(simRef);
    if (id === "harbor") renderWriteQueue(simRef);
    if (id === "cmp" || id === "btr" || id === "met") renderOptimizer(simRef);
    wireActions();
    els.info.classList.remove("hidden");
    syncInspectorTabs();
  }

  // Walk up to a building and operate it: the controls that belong to a
  // subsystem live on the subsystem, not only in the control room.
  var ACTIONS = {
    harbor: [
      { id: "act-wq-mode", label: function (s) {
          return "Local-first write queue (FB_WRITE_QUEUE$): " + (s.writeQueueMode ? "ON" : "OFF");
        }, fn: function (s) { Sim.setWriteQueueMode(s, !s.writeQueueMode); } },
      { id: "act-wq-stage", label: "Stage 4 offline mutations (createWriteQueue)",
        fn: function (s) { Sim.enqueueWrite(s, 4); } },
      { id: "act-wq-flush", label: function (s) {
          return "Flush FB_WRITE_QUEUE$ batch (" + (s.writeQueue ? s.writeQueue.length : 0) + " staged)";
        }, fn: function (s) { Sim.flushWriteQueue(s, 4); } }
    ],
    gc: [
      { id: "act-sweep", label: "Sweep now", fn: function (s) { Sim.startSweep(s, true); } },
      { id: "act-autosweep", label: function (s) {
          return (s.sweepEnabled ? "Switch off" : "Switch on") + " automatic sweep";
        }, fn: function (s) {
          setCheck("ctl-sweepon", !s.sweepEnabled);
        } },
      { id: "act-gcpolicy", label: function (s) {
          return "GC policy: " + s.gcPolicy;
        }, fn: function (s) {
          var order = ["combined", "cooperative", "background"];
          var next = order[(order.indexOf(s.gcPolicy) + 1) % order.length];
          Sim.setGcPolicy(s, next);
          setSelect("ctl-gcpolicy", next);
        } }
    ],
    gbak: [
      { id: "act-gbak", label: function (s) {
          return s.backup.gbakActive ? "gbak running…" : "Run gbak (logical backup)";
        }, fn: function (s) { Sim.startGbak(s); } }
    ],
    nbackup: [
      { id: "act-nb0", label: "nbackup level 0", fn: function (s) { Sim.startNbackup(s, 0); } },
      { id: "act-nb1", label: "nbackup level 1", fn: function (s) { Sim.startNbackup(s, 1); } },
      { id: "act-lock", label: function (s) {
          return s.backup.locked ? "Unlock & merge delta" : "Lock database (-L)";
        }, fn: function (s) { Sim.toggleLock(s); } }
    ],
    delta: [
      { id: "act-lock2", label: function (s) {
          return s.backup.locked ? "Unlock & merge delta" : "Lock database (-L)";
        }, fn: function (s) { Sim.toggleLock(s); } }
    ],
    replica: [
      { id: "act-replhealth", label: function (s) {
          return s.repl.health === "down" ? "Bring the replica back"
                                          : "Break the replica";
        }, fn: function (s) {
          var next = s.repl.health === "down" ? "healthy" : "down";
          Sim.setReplHealth(s, next);
          setSelect("ctl-replhealth", next);
        } }
    ],
    replicator: [
      { id: "act-replmode", label: function (s) {
          return s.repl.mode === "sync" ? "Switch to asynchronous"
                                        : "Switch to synchronous";
        }, fn: function (s) {
          var next = s.repl.mode === "sync" ? "async" : "sync";
          Sim.setReplMode(s, next);
          setSelect("ctl-replmode", next);
        } }
    ],
    tra: [
      { id: "act-longtxn", label: function (s) {
          return s.pinned !== null ? "Commit the forgotten transaction"
                                   : "Forget to commit a transaction";
        }, fn: function (s) { setCheck("ctl-longtxn", s.pinned === null); } },
      { id: "act-isolation", label: function (s) {
          return "Isolation: " + (s.isolationMode === "snapshot"
            ? "SNAPSHOT (CONCURRENCY)"
            : "READ CONSISTENCY");
        }, fn: function (s) {
          var next = s.isolationMode === "snapshot" ? "read_consistency" : "snapshot";
          Sim.setIsolationMode(s, next);
          setSelect("ctl-isolation", next);
        } }
    ],
    mvcc: [
      { id: "act-isolation-mvcc", label: function (s) {
          return "Isolation: " + (s.isolationMode === "snapshot"
            ? "SNAPSHOT (CONCURRENCY)"
            : "READ CONSISTENCY");
        }, fn: function (s) {
          var next = s.isolationMode === "snapshot" ? "read_consistency" : "snapshot";
          Sim.setIsolationMode(s, next);
          setSelect("ctl-isolation", next);
        } }
    ],
    pio: [
      { id: "act-fw", label: function (s) {
          return (s.forcedWrites ? "Switch off" : "Switch on") + " forced writes";
        }, fn: function (s) { setCheck("ctl-forcedwrites", !s.forcedWrites); } },
      { id: "act-blob-pio", label: "Stream segmented BLOB (createBlobStream)",
        fn: function (s) { Sim.spawnBlobStream(s, true, 4); } }
    ],
    exec: [
      { id: "act-cursor-exec", label: "Stream cursor batches (queryStream)",
        fn: function (s) { Sim.spawnCursorStream(s, 3); } },
      { id: "act-blob-exec", label: "Read segmented BLOB (openBlobStream)",
        fn: function (s) { Sim.spawnBlobStream(s, false, 4); } }
    ],
    yvalve: [
      { id: "act-cursor-yvalve", label: "Stream cursor batches (queryStream)",
        fn: function (s) { Sim.spawnCursorStream(s, 3); } }
    ],
    cache: [
      { id: "act-fw-cache", label: function (s) {
          return (s.forcedWrites ? "Switch off" : "Switch on") + " forced writes";
        }, fn: function (s) { setCheck("ctl-forcedwrites", !s.forcedWrites); } },
      { id: "act-servermode-cache", label: function (s) {
          return "ServerMode: " + s.serverMode;
        }, fn: function (s) {
          var order = ["super", "superclassic", "classic"];
          var next = order[(order.indexOf(s.serverMode) + 1) % order.length];
          Sim.setServerMode(s, next);
          setSelect("ctl-servermode", next);
        } }
    ],
    lock: [
      { id: "act-lockmode", label: function (s) {
          return "Lock mode: " + (s.lockMode === "nowait" ? "NO WAIT" : "WAIT");
        }, fn: function (s) {
          var next = s.lockMode === "nowait" ? "wait" : "nowait";
          Sim.setLockMode(s, next);
          setSelect("ctl-lockmode", next);
        } },
      { id: "act-servermode-lock", label: function (s) {
          return "ServerMode: " + s.serverMode;
        }, fn: function (s) {
          var order = ["super", "superclassic", "classic"];
          var next = order[(order.indexOf(s.serverMode) + 1) % order.length];
          Sim.setServerMode(s, next);
          setSelect("ctl-servermode", next);
        } }
    ],
    cmp: [
      { id: "act-setstats", label: "SET STATISTICS INDEX (recompute)",
        fn: function (s) { Sim.recomputeStatistics(s); } },
      { id: "act-degradestats", label: "Simulate stale RDB$STATISTICS",
        fn: function (s) { Sim.degradeStatistics(s); } },
      { id: "act-stmtcache", label: function (s) {
          return s.stmtCacheRatio > 0
            ? "Statement cache: " + Math.round(s.stmtCacheRatio * 100) + "% (turn off)"
            : "Enable statement cache (80% hit)";
        }, fn: function (s) {
          var next = s.stmtCacheRatio > 0 ? 0 : 80;
          setRange("ctl-stmtcache", next);
        } },
      { id: "act-explain-idx", label: "Dispatch explained SELECT (PLAN INDEX)",
        fn: function (s) {
          Sim.ingestTelemetry(s, {
            sql: "SELECT ID, NAME FROM MGA_DEMO WHERE ID = 1",
            planText: "Select Expression\n  -> Filter\n    -> Table \"MGA_DEMO\" Access By ID\n      -> Bitmap\n        -> Index \"RDB$PRIMARY1\" Unique Scan"
          });
        } },
      { id: "act-explain-sort", label: "Dispatch explained SELECT (PLAN SORT)",
        fn: function (s) {
          Sim.ingestTelemetry(s, {
            sql: "SELECT ID, NAME FROM MGA_DEMO ORDER BY NAME",
            planText: "Select Expression\n  -> Sort (record length: 68, key length: 44)\n    -> Table \"MGA_DEMO\" Full Scan"
          });
        } }
    ],
    btr: [
      { id: "act-setstats-btr", label: "SET STATISTICS INDEX (recompute)",
        fn: function (s) { Sim.recomputeStatistics(s); } }
    ],
    met: [
      { id: "act-setstats-met", label: "SET STATISTICS INDEX (recompute)",
        fn: function (s) { Sim.recomputeStatistics(s); } },
      { id: "act-introspect-met", label: "Simulate db.introspect() catalog scan",
        fn: function (s) {
          Sim.ingestTelemetry(s, {
            schema: {
              tables: [
                { name: "MGA_DEMO", columns: [{ name: "ID" }, { name: "NAME" }], indexes: [{ name: "RDB$PRIMARY1" }] },
                { name: "PLAN_DEMO", columns: [{ name: "ID" }, { name: "NAME" }], indexes: [{ name: "RDB$PRIMARY2" }] }
              ]
            }
          });
        } }
    ]
  };

  function labelOf(a) {
    return typeof a.label === "function" ? a.label(simRef) : a.label;
  }

  function actionsFor(id) {
    var list = ACTIONS[id];
    if (!list) return "";
    var html = "<div class='panel-actions'>";
    list.forEach(function (a) {
      html += "<button class='act' data-act='" + a.id + "'>" +
        labelOf(a) + "</button>";
    });
    return html + "</div>";
  }

  function wireActions() {
    var list = ACTIONS[infoSelectedId];
    if (!list) return;
    list.forEach(function (a) {
      var el = els.infoBody.querySelector("[data-act='" + a.id + "']");
      if (el) {
        el.addEventListener("click", function () {
          a.fn(simRef);
          refreshActionLabels();
        });
      }
    });
  }

  function refreshActionLabels() {
    var list = ACTIONS[infoSelectedId];
    if (!list || els.info.classList.contains("hidden")) return;
    list.forEach(function (a) {
      var el = els.infoBody.querySelector("[data-act='" + a.id + "']");
      if (el) el.textContent = labelOf(a);
    });
  }

  // live version-chain inspector: either a clicked tower (T0..T11) or the
  // busiest table's chain, with each version's writing transaction and
  // visibility against OST / OIT
  function renderChain(s) {
    var el = $("chain-live");
    if (!el) return;
    var tblIdx = 0, t = s.tables[0];
    if (selectedTowerIdx !== null && s.tables[selectedTowerIdx]) {
      tblIdx = selectedTowerIdx;
      t = s.tables[tblIdx];
    } else {
      for (var i = 1; i < s.tables.length; i++) {
        if (s.tables[i].chain.length > t.chain.length) {
          t = s.tables[i];
          tblIdx = i;
        }
      }
    }
    var minTx = t.chain.length ? t.chain[0] : s.next;
    var gcEligible = 0;
    for (var gi = 0; gi < t.chain.length - 1; gi++) {
      if (t.chain[gi] < s.ost) gcEligible++;
    }
    var titlePrefix = selectedTowerIdx !== null
      ? "Tower T" + tblIdx + " — live version chain"
      : "Busiest table (T" + tblIdx + ") — live version chain";
    var html = "<h3>" + titlePrefix + "</h3>" +
      "<p class='fine'>Versions: <b>" + t.versions +
      "</b> &middot; Oldest <code>minTx</code>: <b>" + minTx +
      "</b> &middot; Eligible for GC (<code>&lt; OST</code>): <b>" + gcEligible + "</b></p>" +
      "<p class='fine'>Back-version reads (<code>MON$BACKVERSION_READS</code>): <b>" +
      s.backversionReads + "</b> &middot; Purges (<code>MON$RECORD_PURGES</code>): <b>" +
      s.purges + "</b> &middot; <code>GCPolicy</code>: <b>" + s.gcPolicy + "</b></p>" +
      "<p class='fine'>Commit CN: <b>" + s.commitNumber +
      "</b> &middot; Write restarts (<code>READ CONSISTENCY</code>): <b>" + s.writeRestarts +
      "</b> &middot; Update conflicts (<code>SNAPSHOT</code>): <b>" + s.updateConflicts + "</b></p>";
    var chain = t.chain, shown = Math.min(chain.length, 10);
    for (var j = 0; j < shown; j++) {
      var idx = chain.length - 1 - j; // newest first
      var txn = chain[idx];
      var cls, label;
      if (j === 0) { cls = "ver-new"; label = "current version"; }
      else if (txn < s.oit) { cls = "ver-dead"; label = "garbage — below OIT " + s.oit; }
      else if (txn < s.ost) { cls = "ver-dead"; label = "unreachable — below OST " + s.ost; }
      else { cls = "ver-ok"; label = "kept for snapshots ≥ txn " + txn; }
      html += "<div class='chainrow " + cls + "'><span>txn " + txn +
        "</span>" + label + "</div>";
    }
    if (chain.length > shown) {
      html += "<div class='chainrow more'>… " + (chain.length - shown) +
        " older version" + (chain.length - shown > 1 ? "s" : "") + "</div>";
    }
    if (chain.length === 1) {
      html += "<p class='fine'>One version — nothing for GC to do. Raise the " +
        "write mix or pin the OIT and watch the chain grow.</p>";
    }
    el.innerHTML = html;
  }

  function renderLocks(s) {
    var el = $("lock-live");
    if (!el) return;
    var html = "<h3>Live relation lock table</h3>" +
      "<p class='fine'>Mode: <b>" + (s.lockMode === "nowait" ? "NO WAIT" : "WAIT") +
      "</b> &middot; Waits: <b>" + s.lockWaits +
      "</b> &middot; Deadlocks: <b>" + s.deadlocks +
      "</b> &middot; NO WAIT aborts: <b>" + s.noWaitAborts + "</b></p>" +
      "<p class='fine'>ServerMode: <b>" + s.serverMode +
      "</b> &middot; Blocking ASTs (<code>blocking_ast_bdb</code>): <b>" +
      s.astCount + "</b></p>";
    var activeRows = 0;
    for (var i = 0; i < s.tables.length; i++) {
      var t = s.tables[i];
      if (!t.lockHolder && !t.waiters.length) continue;
      activeRows++;
      var holderTxt = t.lockHolder && t.lockHolder.txn
        ? "held by txn " + t.lockHolder.txn : "free";
      var waitTxt = t.waiters.length
        ? " &larr; queued: " + t.waiters.map(function (w) { return "txn " + w.txn; }).join(", ")
        : "";
      html += "<div class='chainrow " + (t.waiters.length ? "ver-dead" : "ver-ok") +
        "'><span>T" + i + "</span>" + holderTxt + waitTxt + "</div>";
    }
    if (!activeRows) {
      html += "<p class='fine'>No active write locks held right now. Raise " +
        "the write mix or pick Lock contention to watch writers queue.</p>";
    }
    el.innerHTML = html;
  }

  function renderOptimizer(s) {
    var el = $("opt-live");
    if (!el) return;
    var html = "<h3>Optimizer plans &amp; <code>RDB$STATISTICS</code></h3>" +
      "<p class='fine'>Index scans: <b>" + s.indexScans +
      "</b> &middot; Natural + Sort: <b>" + s.naturalScans +
      "</b> &middot; <code>SET STATISTICS</code> runs: <b>" + s.statsRecomputed +
      "</b> &middot; Statement cache hits: <b>" + s.stmtCacheHits + "</b></p>";
    for (var i = 0; i < Math.min(6, s.tables.length); i++) {
      var t = s.tables[i];
      var eff = Math.min(1, t.selectivity + t.statDrift);
      var plan = eff < 0.12 ? "PLAN (T" + i + " INDEX)" : "PLAN (T" + i + " NATURAL) + SORT";
      var cls = eff < 0.12 ? "ver-ok" : "ver-dead";
      html += "<div class='chainrow " + cls + "'><span>T" + i + " (" +
        eff.toFixed(3) + ")</span>" + plan +
        (t.statDrift > 0.02 ? " <em>(drift +" + t.statDrift.toFixed(2) + ")</em>" : "") +
        "</div>";
    }
    if (s.lastTelemetry && (s.lastTelemetry.sql || s.lastTelemetry.planText)) {
      html += "<p class='fine'>Last <code>db.explain()</code> telemetry: <code>" +
        s.lastTelemetry.sql.slice(0, 44) + "</code></p>";
    }
    if (s.lastTelemetry && s.lastTelemetry.schema && Array.isArray(s.lastTelemetry.schema.tables)) {
      var tblNames = s.lastTelemetry.schema.tables.map(function (tb) { return tb.name; }).join(", ");
      html += "<p class='fine'>Last <code>db.introspect()</code> catalog: <b>" +
        s.lastTelemetry.schema.tables.length + "</b> table(s) (" + (tblNames || "none") + ")</p>";
    }
    el.innerHTML = html;
  }

  function renderWriteQueue(s) {
    var el = $("wq-live");
    if (!el || !s) return;
    var qLen = s.writeQueue ? s.writeQueue.length : 0;
    el.innerHTML = "<div class='chainbox'><div class='chainhead'>" +
      "FB_WRITE_QUEUE$ (createWriteQueue) — " + (s.writeQueueMode ? "ACTIVE" : "IDLE") +
      "</div><p class='fine'>Staged pending mutations: <b>" + qLen + "</b> · " +
      "Flushed batches: <b>" + (s.writeQueueFlushed || 0) + "</b> · " +
      "Pre-image rollbacks: <b>" + (s.preimageRollbacks || 0) + "</b></p></div>";
  }

  function showAbout() {
    expandInspectorRail();
    infoSelectedId = null;
    els.infoTitle.textContent = "FBSimCity";
    els.infoCode.textContent = "";
    els.infoCode.style.display = "none";
    els.infoBody.innerHTML =
      "<p>An explorable city that shows how the <strong>Firebird</strong> " +
      "relational database actually works. Buildings are subsystems, glowing " +
      "particles are queries, and the excavation at the bottom is the " +
      "database file itself.</p>" +
      "<p><strong>Drag</strong> to pan, <strong>scroll</strong> to zoom, " +
      "<strong>click a building</strong> for its story, take the " +
      "<strong>guided tour</strong>, or <strong>trace one query</strong> " +
      "step by step. Press <strong>?</strong> for all shortcuts.</p>" +
      "<p>Cyan particles speak SQL; they turn violet once DSQL compiles them " +
      "to BLR, and green when they carry results home. Try a scenario from " +
      "the control room — or flip on the long-running transaction and watch " +
      "the OIT pin the garbage collector.</p>" +
      "<p class='fine'>Block base: <a href='https://github.com/mariuz/conceptual-architecture-for-firebird-paper' " +
      "target='_blank' rel='noopener'>Conceptual Architecture for Firebird</a> " +
      "(Chan &amp; Yashkir, Univ. of Waterloo; extended by Popa Adrian Marius). " +
      "Inspired by <a href='https://github.com/NikolayS/PGSimCity' " +
      "target='_blank' rel='noopener'>PGSimCity</a>. This is a scaled model " +
      "for intuition, not an emulator.</p>" +
      "<p class='fine'>Found something it gets wrong? Every panel has a " +
      "report link, and corrections are taken seriously — the replication " +
      "model was rewritten after one.</p>" +
      "<p class='fine'>Want the real thing? The <a href='machine/'>machine " +
      "room</a> runs actual Firebird in this browser, compiled to WebAssembly " +
      "by <a href='https://github.com/mariuz/electric-firebird' " +
      "target='_blank' rel='noopener'>Electric Firebird</a>. Type SQL at it " +
      "and check the city against the engine itself.</p>" +
      "<p class='fine'>FBSimCity is an independent educational project, not " +
      "affiliated with or endorsed by the Firebird Project. Firebird&reg; is " +
      "a registered trademark of the Firebird Foundation Incorporated.</p>";
    els.info.classList.remove("hidden");
    syncInspectorTabs();
  }

  // ---- tour ------------------------------------------------------------

  function startTour() {
    tourIdx = -1;
    els.tour.classList.remove("hidden");
    stepTour(1);
  }

  function endTour() {
    tourIdx = -1;
    els.tour.classList.add("hidden");
  }

  function stepTour(dir) {
    tourIdx += dir;
    if (tourIdx < 0) tourIdx = 0;
    if (tourIdx >= FB.tour.length) { endTour(); return; }
    var st = FB.tour[tourIdx];
    els.tourTitle.textContent = st.title;
    els.tourText.textContent = st.text;
    els.tourStep.textContent = (tourIdx + 1) + " / " + FB.tour.length;
    if (onFocus) onFocus(st.focus, st.zoom);
  }

  // ---- hotkeys ---------------------------------------------------------

  var HOTKEY_DISTRICTS = [
    "harbor", "yvalve", "blrgen", "cmp", "exec", "cache", "lock", "mvcc", "tra"
  ];

  function handleKey(key) {
    if (key >= "1" && key <= "9") {
      var targetId = HOTKEY_DISTRICTS[parseInt(key, 10) - 1];
      if (targetId && FB.byId[targetId]) {
        showBuilding(targetId);
        if (onFocus) onFocus(targetId, 1.3);
        return true;
      }
    }
    switch (key) {
      case " ": togglePause(); return true;
      case "t": case "T": startTour(); return true;
      case "d": case "D": toggleTheme(); return true;
      case "g": case "G": startTraceUI(); return true;
      case "p": case "P": toggleOverlay("anatomy-overlay"); return true;
      case "?": case "h": case "H": toggleOverlay("help-overlay"); return true;
      case "Escape":
        toggleOverlay("help-overlay", false);
        toggleOverlay("anatomy-overlay", false);
        return true;
    }
    return false;
  }

  // ---- stats + sparklines + telemetry drawer ---------------------------

  function pushHist(s) {
    if (Math.floor(s.time) === lastHistPush) return;
    lastHistPush = Math.floor(s.time);
    var lp = Sim.latencyProfile(s);
    hist.t.push(lastHistPush);
    hist.qps.push(s.qps);
    hist.hit.push(s.hitRatio);
    hist.gap.push(Math.max(0, s.ost - s.oit));
    hist.vers.push(s.totalVersions);
    hist.p50.push(lp ? lp.p50 : 0);
    hist.p95.push(lp ? lp.p95 : 0);
    if (s.sweepActive && !prevSweepActive) {
      recordTelemetryEvent("Sweep", "#ffa94d");
    }
    prevSweepActive = !!s.sweepActive;
    ["t", "qps", "hit", "gap", "vers", "p50", "p95"].forEach(function (k) {
      if (hist[k].length > 180) hist[k].shift();
    });
    if (hist.t.length) {
      var minT = hist.t[0];
      hist.events = hist.events.filter(function (ev) { return ev.t >= minT; });
    }
  }

  function renderTelemetryDrawer() {
    var drawer = $("telemetry-drawer");
    if (!drawer || drawer.classList.contains("hidden")) return;
    var c = $("telemetry-canvas");
    var readout = $("telemetry-readout");
    if (!c) return;
    var ctx = c.getContext("2d");
    var w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    var n = hist.t.length;
    if (n < 1) return;

    var padL = 94, padR = 12, padT = 14, padB = 6;
    var plotW = w - padL - padR;
    var lanes = [
      { key: "qps", label: "QPS", color: "#4dabf7", arr: hist.qps, fmt: function (v) { return v.toFixed(1); } },
      { key: "hit", label: "Cache hit %", color: "#69db7c", arr: hist.hit, max: 1, fmt: function (v) { return (v * 100).toFixed(0) + "%"; } },
      { key: "gap", label: "OST − OIT", color: "#fcc419", arr: hist.gap, fmt: function (v) { return String(Math.round(v)); } },
      { key: "vers", label: "Stale vers", color: "#ff8787", arr: hist.vers, fmt: function (v) { return String(Math.round(v)); } },
      { key: "lat", label: "p50 / p95 (s)", color: "#c084fc", arr: hist.p50, arr2: hist.p95, color2: "#f783ac", fmt: function (v, i) { return v.toFixed(2) + "/" + hist.p95[i].toFixed(2) + "s"; } }
    ];
    var laneH = (h - padT - padB) / lanes.length;
    var isDay = document.body.classList.contains("day");

    for (var li = 0; li < lanes.length; li++) {
      var ln = lanes[li];
      var y0 = padT + li * laneH;
      var y1 = y0 + laneH - 4;
      ctx.fillStyle = isDay ? "rgba(210,220,245,0.35)" : "rgba(30,38,70,0.45)";
      ctx.fillRect(padL, y0, plotW, laneH - 4);
      ctx.fillStyle = ln.color;
      ctx.font = "600 10.5px 'Segoe UI', sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(ln.label, 4, y0 + laneH * 0.62);

      var maxV = ln.max || Math.max.apply(null, ln.arr2 ? ln.arr.concat(ln.arr2) : ln.arr);
      if (maxV <= 0) maxV = 1;
      if (n >= 2) {
        ctx.strokeStyle = ln.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (var i = 0; i < n; i++) {
          var px = padL + (i / (n - 1)) * plotW;
          var py = y1 - 2 - (ln.arr[i] / maxV) * (laneH - 8);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        if (ln.arr2) {
          ctx.strokeStyle = ln.color2;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          for (var j = 0; j < n; j++) {
            var px2 = padL + (j / (n - 1)) * plotW;
            var py2 = y1 - 2 - (ln.arr2[j] / maxV) * (laneH - 8);
            if (j === 0) ctx.moveTo(px2, py2); else ctx.lineTo(px2, py2);
          }
          ctx.stroke();
        }
      }
    }

    // Event vertical markers (scenario changes, sweeps, operator decisions)
    if (n >= 2 && hist.events.length) {
      var t0 = hist.t[0], tSpan = Math.max(1, hist.t[n - 1] - t0);
      ctx.save();
      ctx.setLineDash([3, 3]);
      for (var ei = 0; ei < hist.events.length; ei++) {
        var ev = hist.events[ei];
        var ex = padL + Math.max(0, Math.min(1, (ev.t - t0) / tSpan)) * plotW;
        ctx.strokeStyle = ev.color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(ex, padT - 2);
        ctx.lineTo(ex, h - padB);
        ctx.stroke();
        ctx.fillStyle = ev.color;
        ctx.font = "600 9.5px 'Segoe UI', sans-serif";
        ctx.fillText(ev.label.slice(0, 18), Math.min(w - 90, ex + 3), 10);
      }
      ctx.restore();
    }

    var idx = (telemHoverIdx >= 0 && telemHoverIdx < n) ? telemHoverIdx : (n - 1);
    if (telemHoverIdx >= 0 && n >= 2) {
      var hx = padL + (idx / (n - 1)) * plotW;
      ctx.strokeStyle = isDay ? "rgba(20,28,54,0.65)" : "rgba(255,255,255,0.65)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, h - padB);
      ctx.stroke();
    }
    if (readout) {
      var ts = hist.t[idx];
      var mm = Math.floor(ts / 60), ss = ts % 60;
      readout.textContent = "t=" + mm + ":" + (ss < 10 ? "0" : "") + ss +
        " · " + hist.qps[idx].toFixed(1) + " q/s" +
        " · hit " + (hist.hit[idx] * 100).toFixed(0) + "%" +
        " · OST−OIT " + hist.gap[idx] +
        " · " + hist.vers[idx] + " vers" +
        " · p50 " + hist.p50[idx].toFixed(2) + "s / p95 " + hist.p95[idx].toFixed(2) + "s";
    }
  }

  function spark(id, arr, color, fixedMax) {
    var c = $(id);
    if (!c) return;
    var ctx = c.getContext("2d");
    var w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    if (arr.length < 2) return;
    var max = fixedMax || Math.max.apply(null, arr);
    if (max <= 0) max = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (var i = 0; i < arr.length; i++) {
      var x = i / (arr.length - 1) * (w - 2) + 1;
      var y = h - 2 - (arr[i] / max) * (h - 4);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function cls(el, name) {
    el.className = name;
  }

  function fmtPct(x) { return (x * 100).toFixed(0) + "%"; }

  function updateStats(s) {
    pushHist(s);
    $("st-qps").textContent = s.qps.toFixed(1);
    var hitEl = $("st-hit");
    hitEl.textContent = fmtPct(s.hitRatio);
    cls(hitEl, s.hitRatio > 0.8 ? "good" : s.hitRatio > 0.5 ? "warn" : "bad");
    $("st-evict").textContent = s.evictions;
    $("st-next").textContent = s.next;
    $("st-oat").textContent = s.oat;
    if ($("st-ost")) $("st-ost").textContent = s.ost;
    var oitEl = $("st-oit");
    oitEl.textContent = s.oit;
    var pinnedBy = s.pinned !== null ? "txn " + s.pinned
      : s.backup.gbakTxn !== null ? "gbak (txn " + s.backup.gbakTxn + ")" : null;
    cls(oitEl, pinnedBy ? "bad" : (s.ost - s.oit > 0 ? "warn" : "good"));
    $("st-pin").textContent = pinnedBy ? "⚠ pinned by " + pinnedBy : "";
    var vEl = $("st-vers");
    vEl.textContent = s.totalVersions;
    cls(vEl, s.totalVersions > 60 ? "bad" : s.totalVersions > 25 ? "warn" : "good");
    if ($("st-bvreads")) $("st-bvreads").textContent = s.backversionReads;
    $("st-locks").textContent = s.lockWaits;
    $("st-rb").textContent = s.rollbacks;
    $("st-dirty").textContent = s.dirtyEvictions;
    var bk = s.backup, bs = "idle", bcls = "";
    if (bk.gbakActive) {
      bs = "gbak " + Math.round(bk.gbakProgress * 100) + "%"; bcls = "warn";
    } else if (bk.nbActive) {
      bs = "nbackup L" + bk.nbLevel + " " + Math.round(bk.nbProgress * 100) + "%";
      bcls = "warn";
    } else if (bk.merging) {
      bs = "merging delta"; bcls = "warn";
    } else if (bk.locked) {
      bs = "LOCKED"; bcls = "bad";
    } else if (bk.levels.length) {
      bs = bk.levels.map(function (l) { return "L" + l.level; }).join("+");
      bcls = "good";
    }
    var bEl = $("st-backup");
    bEl.textContent = bs;
    cls(bEl, bcls);
    $("st-delta").textContent = bk.deltaPages;
    cls($("st-delta"), bk.deltaPages > 250 ? "bad" : bk.deltaPages > 0 ? "warn" : "");

    var rp = s.repl, lag = Sim.replLag(s);
    var lagEl = $("st-lag");
    lagEl.textContent = rp.disabled ? "STOPPED"
      : rp.mode === "off" ? "off" : lag;
    cls(lagEl, rp.disabled ? "bad" : rp.mode === "off" ? "" :
      lag > 400 ? "bad" : lag > 80 ? "warn" : "good");
    $("st-segs").textContent = rp.segments.length;
    cls($("st-segs"), rp.segments.length > 16 ? "bad" :
      rp.segments.length > 4 ? "warn" : "");

    // Model time, not wall time: the city runs on its own clock, which warp
    // and the speed control move faster than yours.
    var t = Math.floor(s.time);
    var mm = Math.floor(t / 60), ss = t % 60;
    $("st-clock").textContent = mm + ":" + (ss < 10 ? "0" : "") + ss +
      (s.speed !== 1 ? " @" + s.speed + "×" : "") + (s.paused ? " ⏸" : "");

    spark("sp-qps", hist.qps.slice(-60), "#4dabf7");
    spark("sp-hit", hist.hit.slice(-60), "#69db7c", 1);
    spark("sp-vers", hist.vers.slice(-60), "#ff8787");
    renderTelemetryDrawer();

    var html = "";
    for (var i = s.log.length - 1; i >= 0; i--) {
      html += "<div>" + s.log[i].msg + "</div>";
    }
    els.log.innerHTML = html;

    if (infoSelectedId === "mvcc" && !els.info.classList.contains("hidden")) {
      renderChain(s);
    }
    if (infoSelectedId === "lock" && !els.info.classList.contains("hidden")) {
      renderLocks(s);
    }
    if (infoSelectedId === "harbor" && !els.info.classList.contains("hidden")) {
      renderWriteQueue(s);
    }
    if ((infoSelectedId === "cmp" || infoSelectedId === "btr") &&
        !els.info.classList.contains("hidden")) {
      renderOptimizer(s);
    }
    refreshActionLabels();
    renderLatency();
    if (!$("decide-dock").classList.contains("hidden") &&
        (s.challenge || s.verdict)) {
      // keep the situation's live numbers honest while the dock is open
      var live = $("decide-body").querySelector(".decide-live");
      if (live) {
        live.textContent = "Right now: " + s.totalVersions +
          " stale versions, OIT " + s.oit +
          (s.backup.deltaPages ? ", delta " + s.backup.deltaPages + " pages" : "");
      }
    }

    updateTrace();
  }

  /* Speak a change to assistive technology. The canvas cannot announce
   * anything on its own, so keyboard selection routes through here. */
  function announce(msg) {
    var el = $("a11y-live");
    if (el) el.textContent = msg;
  }

  return {
    init: init,
    showBuilding: showBuilding,
    updateStats: updateStats,
    handleKey: handleKey,
    announce: announce,
    buildShareUrl: buildShareUrl,
    getTelemetryHistory: function () { return hist; }
  };
})();
