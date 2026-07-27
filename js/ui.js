/* FBSimCity — control panel, stats, info panel, guided tour. */
var UI = (function () {
  "use strict";

  var els = {};
  var tourIdx = -1;
  var onFocus = null; // callback(buildingId, zoom)

  function $(id) { return document.getElementById(id); }

  function init(sim, focusCb) {
    onFocus = focusCb;
    els.stats = $("stats");
    els.info = $("info-panel");
    els.infoBody = $("info-body");
    els.infoTitle = $("info-title");
    els.infoCode = $("info-code");
    els.log = $("event-log");
    els.tour = $("tour");
    els.tourTitle = $("tour-title");
    els.tourText = $("tour-text");
    els.tourStep = $("tour-step");

    bindRange("ctl-rate", sim, function (v) { sim.queryRate = +v; },
      function (v) { return v + " q/s"; });
    bindRange("ctl-update", sim, function (v) { sim.updateRatio = v / 100; },
      function (v) { return v + "% writes"; });
    bindRange("ctl-cache", sim, function (v) { Sim.setCacheSize(sim, +v); },
      function (v) { return v + " pages"; });
    bindRange("ctl-sweepint", sim, function (v) { sim.sweepInterval = +v; },
      function (v) { return "every " + v + "s"; });

    $("ctl-longtxn").addEventListener("change", function () {
      Sim.setLongTxn(sim, this.checked);
    });
    $("ctl-sweepon").addEventListener("change", function () {
      sim.sweepEnabled = this.checked;
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

    showAbout();
  }

  function bindRange(id, sim, setter, fmt) {
    var el = $(id), out = $(id + "-val");
    var update = function () {
      setter(el.value);
      out.textContent = fmt(el.value);
    };
    el.addEventListener("input", update);
    update();
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
      "<strong>click a building</strong> for its story, or take the " +
      "<strong>guided tour</strong>.</p>" +
      "<p>Cyan particles speak SQL; they turn violet once DSQL compiles them " +
      "to BLR, and green when they carry results home. Yellow-ringed towers " +
      "grow as UPDATEs stack record versions — try the long-running " +
      "transaction switch and watch the OIT pin the garbage collector.</p>" +
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

  // ---- stats -----------------------------------------------------------

  function fmtPct(x) { return (x * 100).toFixed(0) + "%"; }

  function updateStats(s) {
    var pinnedNote = s.pinned !== null ?
      " <span class='bad'>&#9888; pinned by txn " + s.pinned + "</span>" : "";
    els.stats.innerHTML =
      "<span class='stat'><b>" + s.qps.toFixed(1) + "</b> queries/s</span>" +
      "<span class='stat'>cache hit <b class='" +
        (s.hitRatio > 0.8 ? "good" : s.hitRatio > 0.5 ? "warn" : "bad") + "'>" +
        fmtPct(s.hitRatio) + "</b></span>" +
      "<span class='stat'>Next <b>" + s.next + "</b></span>" +
      "<span class='stat'>OAT <b>" + s.oat + "</b></span>" +
      "<span class='stat'>OIT <b class='" + (s.pinned !== null ? "bad" : "good") +
        "'>" + s.oit + "</b>" + pinnedNote + "</span>" +
      "<span class='stat'>stale versions <b class='" +
        (s.totalVersions > 60 ? "bad" : s.totalVersions > 25 ? "warn" : "good") +
        "'>" + s.totalVersions + "</b></span>" +
      "<span class='stat'>lock waits <b>" + s.lockWaits + "</b></span>" +
      "<span class='stat'>deadlock rollbacks <b>" + s.rollbacks + "</b></span>";

    var html = "";
    for (var i = s.log.length - 1; i >= 0; i--) {
      html += "<div>" + s.log[i].msg + "</div>";
    }
    els.log.innerHTML = html;
  }

  return {
    init: init,
    showBuilding: showBuilding,
    updateStats: updateStats
  };
})();
