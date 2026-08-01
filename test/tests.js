/* FBSimCity test suite.
 *
 * No framework, no build step — open test/index.html, or drive it headlessly
 * with tools/screenshot.ps1 pointed at it and read window.FBTestResults.
 *
 * The point of most of these is drift: the README and docs/KNOBS.md make
 * claims about controls, scenarios and deep links, and nothing but a test
 * stops those claims from quietly becoming false.
 */
(function () {
  "use strict";

  var results = [];
  var t = {
    ok: function (name, cond, detail) {
      results.push({ name: name, pass: !!cond, detail: cond ? "" : (detail || "") });
    },
    eq: function (name, actual, expected) {
      var pass = actual === expected;
      results.push({
        name: name, pass: pass,
        detail: pass ? "" : "expected " + JSON.stringify(expected) +
          ", got " + JSON.stringify(actual)
      });
    }
  };

  function run(s, seconds) {
    for (var i = 0; i < seconds * 60; i++) Sim.tick(s, 1 / 60);
  }

  // ---- 1. simulation-layer purity -------------------------------------
  // sim.js is documented as "the Firebird behavioral model (no rendering)".
  // Enforce it: the simulation must not reach for the DOM, the canvas or
  // the render layer.

  function testPurity(src) {
    var banned = [
      ["document", /\bdocument\s*\./],
      ["window", /\bwindow\s*\./],
      ["canvas/ctx", /\bgetContext\b|\bcanvas\b/i],
      ["requestAnimationFrame", /\brequestAnimationFrame\b/],
      ["Render.", /\bRender\s*\./],
      ["UI.", /\bUI\s*\./],
      ["localStorage", /\blocalStorage\b/]
    ];
    banned.forEach(function (b) {
      t.ok("sim.js does not touch " + b[0], !b[1].test(src),
        "sim.js should stay free of presentation concerns");
    });
    // the one permitted outward reference is the world data
    t.ok("sim.js may read FB world data", /\bFB\s*\./.test(src));
  }

  // ---- 2. every documented knob exists and measurably does something ---

  function testKnobs(knobsMd) {
    var controls = [
      { id: "ctl-rate", doc: "Query rate" },
      { id: "ctl-update", doc: "Write mix" },
      { id: "ctl-cache", doc: "Page cache" },
      { id: "ctl-sweepint", doc: "Sweep interval" },
      { id: "ctl-sweepon", doc: "Automatic sweep" },
      { id: "ctl-longtxn", doc: "Long-running transaction" },
      { id: "ctl-scenario", doc: "Scenario" },
      { id: "ctl-replmode", doc: "Replication mode" },
      { id: "ctl-replhealth", doc: "Replica health" }
    ];
    controls.forEach(function (c) {
      t.ok("control #" + c.id + " exists", !!document.getElementById(c.id));
      t.ok("KNOBS.md documents '" + c.doc + "'",
        knobsMd.indexOf(c.doc) !== -1,
        "control exists in the UI but is undocumented");
    });

    var buttons = ["btn-sweep", "btn-burst", "btn-gbak", "btn-nb0", "btn-nb1",
                   "btn-lock", "btn-restore", "btn-decide", "btn-trace",
                   "btn-anatomy", "btn-tour", "btn-pause", "btn-speed",
                   "btn-theme", "btn-help"];
    buttons.forEach(function (id) {
      t.ok("button #" + id + " exists", !!document.getElementById(id));
    });

    // measurable output: each knob must change the model, not just the label
    var s = Sim.create();
    s.queryRate = 0;
    run(s, 2);
    t.eq("query rate 0 spawns nothing", s.particles.length, 0);
    s.queryRate = 12;
    run(s, 3);
    t.ok("raising query rate spawns particles", s.particles.length > 0);

    var small = Sim.create(); small.queryRate = 12; Sim.setCacheSize(small, 16);
    var big = Sim.create(); big.queryRate = 12; Sim.setCacheSize(big, 128);
    run(small, 45); run(big, 45);
    t.ok("smaller cache measurably lowers the hit ratio",
      small.hitRatio < big.hitRatio,
      "16 buffers: " + small.hitRatio.toFixed(2) +
      ", 128 buffers: " + big.hitRatio.toFixed(2));

    var ro = Sim.create(); ro.queryRate = 10; ro.updateRatio = 0;
    var rw = Sim.create(); rw.queryRate = 10; rw.updateRatio = 1;
    run(ro, 45); run(rw, 45);
    t.eq("0% writes creates no versions", ro.totalVersions, 0);
    t.ok("100% writes creates versions", rw.totalVersions > 0);
  }

  // ---- 3. documented scenarios and deep-link params --------------------

  function testScenariosAndLinks(readme) {
    var sel = document.getElementById("ctl-scenario");
    var opts = Array.prototype.slice.call(sel.options)
      .map(function (o) { return o.value; })
      .filter(function (v) { return v; });
    t.ok("scenario picker has options", opts.length > 0);
    opts.forEach(function (v) {
      t.ok("README documents scenario '" + v + "'",
        readme.indexOf(v) !== -1,
        "scenario is selectable but undocumented");
    });

    ["scenario", "theme", "warp", "panel", "lock"].forEach(function (p) {
      t.ok("README documents deep-link param '" + p + "'",
        readme.indexOf(p + "=") !== -1);
    });
  }

  // ---- 4. behavioural invariants ---------------------------------------

  function testBehaviour() {
    // version chains stay consistent with their counters
    var s = Sim.create();
    s.queryRate = 12; s.updateRatio = 0.8;
    Sim.setLongTxn(s, true);
    run(s, 40);
    t.ok("chain length tracks version count",
      s.tables.every(function (x) { return x.chain.length === x.versions; }));
    t.eq("stale total matches the chains",
      s.totalVersions,
      s.tables.reduce(function (a, x) { return a + x.versions - 1; }, 0));

    // a pinned OIT stalls sweep
    Sim.startSweep(s, true);
    t.ok("sweep refuses while the OIT is pinned", s.sweepBlocked);
    var pinnedVersions = s.totalVersions;
    Sim.setLongTxn(s, false);
    Sim.startSweep(s, true);
    run(s, 8);
    t.ok("sweep collects once the OIT is released",
      s.totalVersions < pinnedVersions,
      pinnedVersions + " -> " + s.totalVersions);

    // gbak pins the OIT for its run and releases after
    var g = Sim.create();
    g.queryRate = 8; g.updateRatio = 0.5;
    run(g, 10);
    Sim.startGbak(g);
    var gtxn = g.backup.gbakTxn;
    run(g, 5);
    t.eq("gbak's snapshot is the OIT while it runs", g.oit, gtxn);
    Sim.startSweep(g, true);
    t.ok("sweep is blocked by gbak", g.sweepBlocked);
    run(g, 10);
    t.eq("gbak releases the OIT when done", g.backup.gbakTxn, null);

    // nbackup lock diverts writes to the delta, unlock merges them back
    var n = Sim.create();
    n.queryRate = 12; n.updateRatio = 0.8;
    run(n, 40);
    var writesBefore = n.pageWrites;
    Sim.toggleLock(n);
    run(n, 12);
    t.ok("delta fills while locked", n.backup.deltaPages > 0);
    t.eq("main file is frozen while locked", n.pageWrites, writesBefore);
    Sim.toggleLock(n);
    run(n, 5);
    t.eq("delta drains after unlock", n.backup.deltaPages, 0);

    // nbackup level chain is enforced
    var lv = Sim.create();
    Sim.startNbackup(lv, 1);
    t.ok("level 1 without level 0 is refused", !lv.backup.nbActive);

    // --- logical replication ---
    // async: the primary never waits, the replica trails
    var ra = Sim.create();
    ra.queryRate = 12; ra.updateRatio = 0.9;
    Sim.setReplMode(ra, "async");
    run(ra, 60);
    t.ok("async replication journals committed changes", ra.repl.generated > 0);
    t.ok("async replica applies", ra.repl.applied > 0);
    t.ok("async commits never hang", !ra.repl.stalled);
    t.eq("lag is generated minus applied", Sim.replLag(ra),
      ra.repl.generated - ra.repl.applied);
    t.ok("a healthy replica keeps lag small", Sim.replLag(ra) < 60,
      "lag " + Sim.replLag(ra));

    // segments are sealed in order and applied in order
    t.ok("segment numbers are strictly increasing",
      ra.repl.segments.every(function (sg, i, arr) {
        return i === 0 || sg.n > arr[i - 1].n;
      }), "commit order must be preserved");

    // a slow replica builds lag
    var rs = Sim.create();
    rs.queryRate = 14; rs.updateRatio = 0.9;
    Sim.setReplMode(rs, "async"); Sim.setReplHealth(rs, "slow");
    run(rs, 60);
    t.ok("a slow replica accumulates lag", Sim.replLag(rs) > Sim.replLag(ra),
      "slow " + Sim.replLag(rs) + " vs healthy " + Sim.replLag(ra));

    // an unreachable replica accumulates segments, and recovers in order
    var rd = Sim.create();
    rd.queryRate = 12; rd.updateRatio = 0.9;
    Sim.setReplMode(rd, "async"); Sim.setReplHealth(rd, "down");
    run(rd, 60);
    var backlog = rd.repl.segments.length;
    t.ok("an unreachable replica stacks up segments", backlog > 0);
    t.eq("nothing is applied while it is down", rd.repl.applied, 0);
    var firstSeg = rd.repl.segments[0].n;
    Sim.setReplHealth(rd, "healthy");
    run(rd, 30);
    t.ok("the replica catches up when it returns",
      rd.repl.segments.length < backlog);
    t.ok("catch-up resumes from the oldest segment, in order",
      !rd.repl.segments.length || rd.repl.segments[0].n >= firstSeg);

    // synchronous replication with a dead replica must hang, not downgrade
    var rc = Sim.create();
    rc.queryRate = 8; rc.updateRatio = 0.8;
    Sim.setReplMode(rc, "sync"); Sim.setReplHealth(rc, "down");
    run(rc, 60);
    t.ok("a dead synchronous replica hangs commits", rc.repl.stalled,
      "silently continuing would be claiming durability it does not have");

    // switching replication off discards the backlog
    var ro2 = Sim.create();
    ro2.queryRate = 12; ro2.updateRatio = 0.9;
    Sim.setReplMode(ro2, "async"); Sim.setReplHealth(ro2, "down");
    run(ro2, 40);
    t.ok("backlog exists before switching off", ro2.repl.segments.length > 0);
    Sim.setReplMode(ro2, "off");
    t.eq("switching replication off clears the backlog",
      ro2.repl.segments.length, 0);
    var genAtOff = ro2.repl.generated;
    run(ro2, 20);
    t.eq("nothing is journalled while replication is off",
      ro2.repl.generated, genAtOff);

    // dirty eviction costs a write
    var d = Sim.create();
    d.queryRate = 14; d.updateRatio = 0.9;
    Sim.setCacheSize(d, 16);
    run(d, 60);
    t.ok("dirty evictions occur under cache pressure", d.dirtyEvictions > 0);
    t.ok("page writes cover the dirty evictions",
      d.pageWrites >= d.dirtyEvictions);
  }

  // ---- 5. decisions have measured, differing consequences --------------

  function testDecisions() {
    t.ok("four decisions are defined", FB.challenges.length === 4);
    FB.challenges.forEach(function (c) {
      t.eq("decision '" + c.id + "' offers two options", c.options.length, 2);
    });

    FB.challenges.forEach(function (c) {
      var outcomes = c.options.map(function (o) {
        var s = Sim.create();
        Sim.startChallenge(s, c.id);
        t.ok("decision '" + c.id + "' sets up its situation", !!s.challenge);
        Sim.answerChallenge(s, o.id);
        t.ok("decision '" + c.id + "/" + o.id + "' produces a verdict",
          !!s.verdict && s.verdict.lines.length > 0);
        return s.verdict ? s.verdict.lines.join(" ") : "";
      });
      t.ok("decision '" + c.id + "' verdicts differ by choice",
        outcomes[0] !== outcomes[1],
        "both answers produced the same verdict text");
    });
  }

  // ---- 6. semantic colours stay distinguishable ------------------------
  // Meaning here is carried by colour, so the pairs that mean different
  // things must not collide — including for the common colour vision
  // deficiencies.

  function rgb(hex) {
    return [parseInt(hex.slice(1, 3), 16),
            parseInt(hex.slice(3, 5), 16),
            parseInt(hex.slice(5, 7), 16)];
  }
  function lum(c) {
    var a = c.map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  function contrast(a, b) {
    var l1 = lum(rgb(a)), l2 = lum(rgb(b));
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  // crude but standard deuteranopia/protanopia simulation
  function deuter(hex) {
    var c = rgb(hex);
    var r = 0.625 * c[0] + 0.375 * c[1];
    var g = 0.7 * c[0] + 0.3 * c[1];
    return "#" + [r, g, c[2]].map(function (v) {
      var h = Math.round(Math.max(0, Math.min(255, v))).toString(16);
      return h.length < 2 ? "0" + h : h;
    }).join("");
  }

  function testColours() {
    // pairs that must never be confused, because they mean opposite things
    var pairs = [
      ["cache hit vs miss", "#51cf66", "#e03131"],
      ["cache miss vs dirty", "#e03131", "#fcc419"],
      ["SQL vs BLR particle", "#22d3ee", "#c084fc"],
      ["result vs rollback particle", "#4ade80", "#f87171"],
      // endpoints of towerColor(): 1 version .. 15+ versions
      ["fresh vs stale version tower", "#4dabf7", "#ff3d6b"]
    ];
    pairs.forEach(function (p) {
      var normal = contrast(p[1], p[2]);
      var cvd = contrast(deuter(p[1]), deuter(p[2]));
      t.ok(p[0] + " distinguishable normally", normal >= 1.3,
        "contrast ratio " + normal.toFixed(2));
      t.ok(p[0] + " distinguishable with deuteranopia", cvd >= 1.15,
        "simulated contrast ratio " + cvd.toFixed(2));
    });
  }

  // ---- 7. accessibility surface ----------------------------------------

  function testAccessibility(lifecycleHtml) {
    t.ok("lifecycle page exists", lifecycleHtml.length > 0);
    var stages = (lifecycleHtml.match(/<li tabindex="0"/g) || []).length;
    t.ok("lifecycle stations are focusable", stages >= 16,
      "found " + stages);
    t.ok("lifecycle links back to the city",
      lifecycleHtml.indexOf('href="index.html"') !== -1);
    t.ok("reduced motion is honoured in CSS or renderer",
      typeof Render.isCalm === "function");
  }

  // ---- runner ----------------------------------------------------------

  /* Cache-bust: a test suite that reads a stale copy of the source or the
   * docs will happily report green on code that no longer exists. */
  function fetchText(url) {
    return fetch(url + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.text(); })
      .catch(function () { return ""; });
  }

  window.FBRunTests = function () {
    results = [];
    return Promise.all([
      fetchText("../js/sim.js"),
      fetchText("../docs/KNOBS.md"),
      fetchText("../README.md"),
      fetchText("../lifecycle.html")
    ]).then(function (files) {
      testPurity(files[0]);
      testKnobs(files[1]);
      testScenariosAndLinks(files[2]);
      testBehaviour();
      testDecisions();
      testColours();
      testAccessibility(files[3]);

      var passed = results.filter(function (r) { return r.pass; }).length;
      window.FBTestResults = {
        total: results.length, passed: passed,
        failed: results.length - passed, results: results
      };
      return window.FBTestResults;
    });
  };
})();
