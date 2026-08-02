/* FBSimCity — control panel, stats + sparklines, info panel, guided tour,
 * scenarios, query trace, theme switcher, help & page-anatomy overlays. */
var UI = (function () {
  "use strict";

  var els = {};
  var tourIdx = -1;
  var onFocus = null; // callback(buildingId, zoom)
  var simRef = null;
  var hist = { qps: [], hit: [], vers: [] };
  var lastHistPush = -1;

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
      text: "Before modifying, a lock on the resource is requested in the shared-memory lock table. Contending writers queue here." },
    mvcc: { name: "Record Version Towers (VIO)",
      text: "The UPDATE does not overwrite the row: a new version is written and the old one is chained behind it as a delta. Older snapshots can still read the old version." },
    tra: { name: "Transaction Hall (TRA)",
      text: "COMMIT: the transaction's state bits flip on a Transaction Inventory Page. The new record version is now the committed truth." },
    btr: { name: "B-Tree Gardens (BTR)",
      text: "An index walk resolves the search condition to record numbers without scanning the table." },
    sort: { name: "Sort Yard (SORT)",
      text: "No index supplies the required order — the sorter builds sorted runs and merges them." }
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
      msg: "Heavy writes with an aggressive 10-second sweep interval. The truck barely rests."
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
    bindRange("ctl-sweepint", function (v) { sim.sweepInterval = +v; },
      function (v) { return "every " + v + "s"; });

    $("ctl-longtxn").addEventListener("change", function () {
      Sim.setLongTxn(sim, this.checked);
    });
    $("ctl-sweepon").addEventListener("change", function () {
      sim.sweepEnabled = this.checked;
    });
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
    });
    $("btn-gbak").addEventListener("click", function () { Sim.startGbak(sim); });
    $("btn-nb0").addEventListener("click", function () { Sim.startNbackup(sim, 0); });
    $("btn-nb1").addEventListener("click", function () { Sim.startNbackup(sim, 1); });
    $("btn-lock").addEventListener("click", function () { Sim.toggleLock(sim); });
    $("btn-restore").addEventListener("click", function () { Sim.restoreChain(sim); });
    $("btn-burst").addEventListener("click", function () {
      Sim.burst(sim, 60);
    });
    $("btn-tour").addEventListener("click", function () { startTour(); });
    $("tour-next").addEventListener("click", function () { stepTour(1); });
    $("tour-prev").addEventListener("click", function () { stepTour(-1); });
    $("tour-close").addEventListener("click", function () { endTour(); });
    $("info-close").addEventListener("click", function () {
      els.info.classList.add("hidden");
      infoSelectedId = null;
    });
    $("btn-about").addEventListener("click", function () { showAbout(); });

    // run control
    $("btn-pause").addEventListener("click", togglePause);
    $("btn-speed").addEventListener("click", cycleSpeed);

    // trace
    $("btn-trace").addEventListener("click", startTraceUI);
    $("trace-step").addEventListener("click", function () { Sim.traceNext(sim); });
    $("trace-auto").addEventListener("click", function () {
      if (sim.traceStep) { Sim.traceAuto(sim); this.textContent = "Pause steps"; }
      else { Sim.tracePause(sim); this.textContent = "Auto play"; }
    });
    $("trace-end").addEventListener("click", endTraceUI);

    // theme
    $("btn-theme").addEventListener("click", toggleTheme);
    var saved = null;
    try { saved = localStorage.getItem("fbsimcity-theme"); } catch (e) { }
    applyTheme(saved === "day" ? "day" : "dark");

    // overlays
    $("btn-decide").addEventListener("click", function () { openDecisions(); });
    $("decide-close").addEventListener("click", function () {
      Sim.endChallenge(simRef);
      $("decide-dock").classList.add("hidden");
    });

    $("btn-help").addEventListener("click", function () { toggleOverlay("help-overlay"); });
    $("help-close").addEventListener("click", function () { toggleOverlay("help-overlay", false); });
    $("btn-anatomy").addEventListener("click", function () { toggleOverlay("anatomy-overlay"); });
    $("anatomy-close").addEventListener("click", function () { toggleOverlay("anatomy-overlay", false); });

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
      var pn = params.get("panel");
      if (pn && FB.byId[pn]) showBuilding(pn);
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

  // ---- overlays --------------------------------------------------------

  function toggleOverlay(id, force) {
    var el = $(id);
    var show = force !== undefined ? force : el.classList.contains("hidden");
    el.classList.toggle("hidden", !show);
  }

  // ---- trace -----------------------------------------------------------

  function startTraceUI() {
    if (simRef.tracedQ) return;
    Sim.startTrace(simRef);
    $("trace-auto").textContent = "Auto play";
    els.trace.classList.remove("hidden");
    updateTrace();
  }

  function endTraceUI() {
    Sim.endTrace(simRef);
    els.trace.classList.add("hidden");
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
    // the dock and the info panel share the right-hand corner, so they take
    // turns; the decision itself is kept in the model, not in the DOM, so
    // reopening returns to wherever you were
    els.info.classList.add("hidden");
    infoSelectedId = null;
    var dock = $("decide-dock");
    dock.classList.remove("hidden");
    renderDecisions();
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
      html += "<p class='fine'>Three situations where Firebird hands you a " +
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
        Sim.answerChallenge(simRef, b.getAttribute("data-choice"));
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

  // ---- info panel ------------------------------------------------------

  var infoSelectedId = null;

  function showBuilding(id) {
    var b = FB.byId[id];
    if (!b) return;
    $("decide-dock").classList.add("hidden");
    infoSelectedId = id;
    els.infoTitle.textContent = b.name;
    els.infoCode.textContent = b.code;
    els.infoCode.style.display = "";
    els.infoBody.innerHTML = "<p>" + b.desc + "</p>" +
      (id === "mvcc" ? "<div id='chain-live'></div>" : "") +
      actionsFor(id);
    if (id === "mvcc") renderChain(simRef);
    wireActions();
    els.info.classList.remove("hidden");
  }

  // Walk up to a building and operate it: the controls that belong to a
  // subsystem live on the subsystem, not only in the control room.
  var ACTIONS = {
    gc: [
      { id: "act-sweep", label: "Sweep now", fn: function (s) { Sim.startSweep(s, true); } },
      { id: "act-autosweep", label: function (s) {
          return (s.sweepEnabled ? "Switch off" : "Switch on") + " automatic sweep";
        }, fn: function (s) {
          setCheck("ctl-sweepon", !s.sweepEnabled);
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
        }, fn: function (s) { setCheck("ctl-longtxn", s.pinned === null); } }
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

  // live version-chain inspector: the busiest table's chain, with each
  // version's writing transaction and its visibility against the OIT
  function renderChain(s) {
    var el = $("chain-live");
    if (!el) return;
    var t = s.tables[0];
    for (var i = 1; i < s.tables.length; i++) {
      if (s.tables[i].chain.length > t.chain.length) t = s.tables[i];
    }
    var html = "<h3>Busiest table — live version chain</h3>";
    var chain = t.chain, shown = Math.min(chain.length, 10);
    for (var j = 0; j < shown; j++) {
      var idx = chain.length - 1 - j; // newest first
      var txn = chain[idx];
      var cls, label;
      if (j === 0) { cls = "ver-new"; label = "current version"; }
      else if (txn < s.oit) { cls = "ver-dead"; label = "garbage — below OIT " + s.oit; }
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

  function showAbout() {
    $("decide-dock").classList.add("hidden");
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
      "<p class='fine'>FBSimCity is an independent educational project, not " +
      "affiliated with or endorsed by the Firebird Project. Firebird&reg; is " +
      "a registered trademark of the Firebird Foundation Incorporated.</p>";
    els.info.classList.remove("hidden");
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

  function handleKey(key) {
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

  // ---- stats + sparklines ----------------------------------------------

  function pushHist(s) {
    if (Math.floor(s.time) === lastHistPush) return;
    lastHistPush = Math.floor(s.time);
    hist.qps.push(s.qps);
    hist.hit.push(s.hitRatio);
    hist.vers.push(s.totalVersions);
    ["qps", "hit", "vers"].forEach(function (k) {
      if (hist[k].length > 60) hist[k].shift();
    });
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
    var oitEl = $("st-oit");
    oitEl.textContent = s.oit;
    var pinnedBy = s.pinned !== null ? "txn " + s.pinned
      : s.backup.gbakTxn !== null ? "gbak (txn " + s.backup.gbakTxn + ")" : null;
    cls(oitEl, pinnedBy ? "bad" : "good");
    $("st-pin").textContent = pinnedBy ? "⚠ pinned by " + pinnedBy : "";
    var vEl = $("st-vers");
    vEl.textContent = s.totalVersions;
    cls(vEl, s.totalVersions > 60 ? "bad" : s.totalVersions > 25 ? "warn" : "good");
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

    spark("sp-qps", hist.qps, "#4dabf7");
    spark("sp-hit", hist.hit, "#69db7c", 1);
    spark("sp-vers", hist.vers, "#ff8787");

    var html = "";
    for (var i = s.log.length - 1; i >= 0; i--) {
      html += "<div>" + s.log[i].msg + "</div>";
    }
    els.log.innerHTML = html;

    if (infoSelectedId === "mvcc" && !els.info.classList.contains("hidden")) {
      renderChain(s);
    }
    refreshActionLabels();
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

  return {
    init: init,
    showBuilding: showBuilding,
    updateStats: updateStats,
    handleKey: handleKey
  };
})();
