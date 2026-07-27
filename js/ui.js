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
    simRef.log.push({ t: simRef.time, msg: sc.msg });
    if (simRef.log.length > 6) simRef.log.shift();
    if (onFocus && !noFly) onFocus(sc.focus, sc.zoom);
  }

  function setRange(id, v) {
    var el = $(id);
    el.value = v;
    el.dispatchEvent(new Event("input"));
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
    $("btn-sweep").addEventListener("click", function () {
      Sim.startSweep(sim, true);
    });
    $("btn-burst").addEventListener("click", function () {
      Sim.burst(sim, 60);
    });
    $("btn-tour").addEventListener("click", function () { startTour(); });
    $("tour-next").addEventListener("click", function () { stepTour(1); });
    $("tour-prev").addEventListener("click", function () { stepTour(-1); });
    $("tour-close").addEventListener("click", function () { endTour(); });
    $("info-close").addEventListener("click", function () {
      els.info.classList.add("hidden");
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
    $("btn-help").addEventListener("click", function () { toggleOverlay("help-overlay"); });
    $("help-close").addEventListener("click", function () { toggleOverlay("help-overlay", false); });
    $("btn-anatomy").addEventListener("click", function () { toggleOverlay("anatomy-overlay"); });
    $("anatomy-close").addEventListener("click", function () { toggleOverlay("anatomy-overlay", false); });

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

  // ---- info panel ------------------------------------------------------

  function showBuilding(id) {
    var b = FB.byId[id];
    if (!b) return;
    els.infoTitle.textContent = b.name;
    els.infoCode.textContent = b.code;
    els.infoCode.style.display = "";
    els.infoBody.innerHTML = "<p>" + b.desc + "</p>";
    els.info.classList.remove("hidden");
  }

  function showAbout() {
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
      "for intuition, not an emulator.</p>";
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
    cls(oitEl, s.pinned !== null ? "bad" : "good");
    $("st-pin").textContent = s.pinned !== null ? "⚠ pinned by txn " + s.pinned : "";
    var vEl = $("st-vers");
    vEl.textContent = s.totalVersions;
    cls(vEl, s.totalVersions > 60 ? "bad" : s.totalVersions > 25 ? "warn" : "good");
    $("st-locks").textContent = s.lockWaits;
    $("st-rb").textContent = s.rollbacks;

    spark("sp-qps", hist.qps, "#4dabf7");
    spark("sp-hit", hist.hit, "#69db7c", 1);
    spark("sp-vers", hist.vers, "#ff8787");

    var html = "";
    for (var i = s.log.length - 1; i >= 0; i--) {
      html += "<div>" + s.log[i].msg + "</div>";
    }
    els.log.innerHTML = html;

    updateTrace();
  }

  return {
    init: init,
    showBuilding: showBuilding,
    updateStats: updateStats,
    handleKey: handleKey
  };
})();
