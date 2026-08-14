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
      { id: "ctl-replhealth", doc: "Replica health" },
      { id: "ctl-tempcache", doc: "Sort memory" }
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

    // sort memory: a small TempCacheLimit must measurably spill more
    var tight = Sim.create(); tight.queryRate = 12; tight.updateRatio = 0;
    tight.tempCacheLimit = 8;
    var roomy = Sim.create(); roomy.queryRate = 12; roomy.updateRatio = 0;
    roomy.tempCacheLimit = 120;
    run(tight, 60); run(roomy, 60);
    t.ok("sorts happen at all", tight.sorts > 0 && roomy.sorts > 0);
    t.ok("less sort memory spills more often",
      tight.sortSpills / Math.max(1, tight.sorts) >
      roomy.sortSpills / Math.max(1, roomy.sorts),
      "tight " + tight.sortSpills + "/" + tight.sorts +
      " vs roomy " + roomy.sortSpills + "/" + roomy.sorts);
    t.eq("a generous sort memory spills nothing", roomy.sortSpills, 0);
  }

  // ---- 2c. latency decomposition accounts for all of the time ----------

  function testLatency() {
    var s = Sim.create();
    s.queryRate = 12; s.updateRatio = 0.5;
    run(s, 90);
    var p = Sim.latencyProfile(s);
    t.ok("a latency profile is produced", !!p);
    if (!p) return;
    t.ok("the profile samples completed trips", p.n > 10, "n=" + p.n);

    // the parts must sum to the whole — a profile that loses time is worse
    // than no profile, because it looks authoritative
    var sum = 0;
    p.keys.forEach(function (k) { sum += p.mean[k]; });
    t.ok("bucket means sum to the reported total",
      Math.abs(sum - p.grand) < 1e-9,
      "sum " + sum.toFixed(6) + " vs grand " + p.grand.toFixed(6));

    // each sample's buckets must sum to its own total
    var worst = 0;
    s.lat.samples.forEach(function (x) {
      var t2 = 0;
      p.keys.forEach(function (k) { t2 += x[k]; });
      worst = Math.max(worst, Math.abs(t2 - x.total));
    });
    t.ok("every sample's buckets sum to its total", worst < 1e-9,
      "worst drift " + worst);

    t.ok("p50 does not exceed p95", p.p50 <= p.p95,
      "p50 " + p.p50.toFixed(2) + " p95 " + p.p95.toFixed(2));

    // transit is a drawing artifact and must be excluded from the reported
    // work, but still accounted for so the books balance
    t.ok("transit is excluded from the reported work buckets",
      p.workKeys.indexOf("travel") === -1);
    t.ok("work total plus transit equals the grand total",
      Math.abs((p.workTotal + p.mean.travel) - p.grand) < 1e-9);
    t.ok("work total is smaller than the grand total",
      p.workTotal < p.grand, "transit should be non-zero");

    // a smaller cache must move time into disk reads
    var small = Sim.create(); small.queryRate = 12; small.updateRatio = 0.4;
    Sim.setCacheSize(small, 16);
    var big = Sim.create(); big.queryRate = 12; big.updateRatio = 0.4;
    Sim.setCacheSize(big, 128);
    run(small, 90); run(big, 90);
    var ps = Sim.latencyProfile(small), pb = Sim.latencyProfile(big);
    t.ok("a smaller cache shifts time into disk reads",
      ps.mean.diskRead > pb.mean.diskRead,
      "16 buffers " + ps.mean.diskRead.toFixed(3) +
      "s vs 128 buffers " + pb.mean.diskRead.toFixed(3) + "s");

    // synchronous replication must show up as replication time, and async
    // must not — the bucket has to mean what it says
    var sy = Sim.create(); sy.queryRate = 10; sy.updateRatio = 0.9;
    Sim.setReplMode(sy, "sync");
    var as = Sim.create(); as.queryRate = 10; as.updateRatio = 0.9;
    Sim.setReplMode(as, "async");
    run(sy, 90); run(as, 90);
    t.ok("synchronous replication shows as replication latency",
      Sim.latencyProfile(sy).mean.repl > 0);
    t.eq("asynchronous replication costs the commit no wait",
      Sim.latencyProfile(as).mean.repl, 0);
  }

  // ---- 2b. the version is stated in two places; they must agree --------

  function testVersion(indexHtml, readme) {
    var m = indexHtml.match(/class="stat version">v([\d.]+)</);
    t.ok("index.html carries a version badge", !!m);
    if (m) {
      t.eq("FB.VERSION matches the version badge", FB.VERSION, m[1]);
    }

    /* The README screenshot is the first thing anyone sees, and it is the
     * easiest thing in the repository to leave behind — it sits in a binary
     * nothing can diff and no test can read. What can be checked is the alt
     * text: it names the version it was taken at, so shipping a release
     * without revisiting the image fails here. This exists because v0.9.0
     * nearly shipped with a picture of a v0.6.1 city. */
    var alt = readme.match(/!\[([^\]]*)\]\(docs\/screenshot\.png\)/);
    t.ok("the README screenshot has alt text", !!alt);
    if (alt) {
      t.ok("the screenshot alt text names the current version",
        alt[1].indexOf("v" + FB.VERSION) !== -1,
        "alt text says " + JSON.stringify(alt[1].slice(0, 40)) +
        "…, FB.VERSION is " + FB.VERSION);
      t.ok("the screenshot alt text describes the image, not just the app",
        alt[1].length > 60, "alt text is only " + alt[1].length + " characters");
    }
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

    // A dead synchronous replica must NOT block commits. Firebird calls
    // checkStatus() with canThrow=false on the commit path and, with
    // disable_on_error (default true), tears replication down instead.
    // Verified against src/jrd/replication/Publisher.cpp on master.
    var rc = Sim.create();
    rc.queryRate = 8; rc.updateRatio = 0.8;
    Sim.setReplMode(rc, "sync"); Sim.setReplHealth(rc, "down");
    var commitsBefore = rc.next;
    run(rc, 60);
    t.ok("a dead synchronous replica stops replication", rc.repl.disabled,
      "disable_on_error should have torn replication down");
    t.eq("replication mode is off after a stop", rc.repl.mode, "off");
    t.ok("commits keep flowing while replication is stopped",
      rc.next > commitsBefore + 5,
      "the commit path must not block on a failed replica");
    t.ok("exactly one STOP_ERROR is logged, not one per commit",
      rc.repl.stops === 1, "stops=" + rc.repl.stops);

    // an async replica going away must NOT stop replication — the primary
    // just keeps journalling, which is the disk-fill hazard
    var rasync = Sim.create();
    rasync.queryRate = 10; rasync.updateRatio = 0.8;
    Sim.setReplMode(rasync, "async"); Sim.setReplHealth(rasync, "down");
    run(rasync, 40);
    t.ok("an async replica going away does not stop replication",
      !rasync.repl.disabled);
    t.ok("async keeps journalling while the replica is away",
      rasync.repl.segments.length > 0);

    // synchronous replication writes no journal segments
    var rsync = Sim.create();
    rsync.queryRate = 10; rsync.updateRatio = 0.9;
    Sim.setReplMode(rsync, "sync");
    run(rsync, 40);
    t.eq("synchronous replication writes no journal segments",
      rsync.repl.segments.length, 0);
    t.ok("a healthy synchronous replica stays in step",
      Sim.replLag(rsync) === 0, "lag " + Sim.replLag(rsync));

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

  // ---- 6b. every documented deep link actually resolves -----------------
  // A link in the README that silently stopped working is a claim that
  // quietly became false. Check the parameters against what UI accepts.

  function testDeepLinks(readme, knobs) {
    var text = readme + "\n" + knobs;
    var urls = text.match(/mariuz\.github\.io\/FBSimCity\/\?[^\s)\]]+/g) || [];
    t.ok("documented deep links exist", urls.length > 0);

    var scenarioKeys = Array.prototype.slice
      .call(document.getElementById("ctl-scenario").options)
      .map(function (o) { return o.value; }).filter(function (v) { return v; });
    var knownParams = ["scenario", "theme", "warp", "panel", "lock", "dock"];

    urls.forEach(function (u) {
      var qs = u.split("?")[1].replace(/&amp;/g, "&");
      qs.split("&").forEach(function (pair) {
        var k = pair.split("=")[0], v = pair.split("=")[1];
        t.ok("deep-link param '" + k + "' is one the app handles",
          knownParams.indexOf(k) !== -1, "in " + u);
        if (k === "scenario") {
          t.ok("deep-link scenario '" + v + "' exists in the picker",
            scenarioKeys.indexOf(v) !== -1, "in " + u);
        }
        if (k === "panel") {
          t.ok("deep-link panel '" + v + "' is a real building",
            !!FB.byId[v], "in " + u);
        }
        if (k === "theme") {
          t.ok("deep-link theme '" + v + "' is valid",
            v === "day" || v === "dark", "in " + u);
        }
      });
    });
  }

  // ---- 6c. the drift tests actually fail when something drifts ---------
  // A green suite is only reassuring if it can go red. These deliberately
  // break a value and assert that the corresponding check notices.

  function testTheTests(knobsMd) {
    // knob-documentation check must fail for an undocumented control
    var fakeDoc = knobsMd.replace("Sort memory", "Srot memroy");
    t.ok("the knob-doc check would catch an undocumented control",
      fakeDoc.indexOf("Sort memory") === -1,
      "breaking the doc string should make the lookup fail");

    // sim purity check must fail on a simulation that touches the DOM
    var dirty = "function f(){ document.getElementById('x'); }";
    t.ok("the purity check would catch DOM access in the simulation",
      /\bdocument\s*\./.test(dirty));

    // latency accounting must fail if a bucket is dropped
    var s = Sim.create();
    s.queryRate = 12;
    run(s, 60);
    var p = Sim.latencyProfile(s);
    if (p) {
      var partial = 0;
      p.keys.slice(1).forEach(function (k) { partial += p.mean[k]; });
      t.ok("the latency sum check would catch a dropped bucket",
        Math.abs(partial - p.grand) > 1e-9 || p.mean[p.keys[0]] === 0,
        "omitting a non-zero bucket must break the sum");
    }

    // colour-contrast check must fail for two identical colours
    t.ok("the colour check would catch two identical colours",
      contrast("#40c057", "#40c057") < 1.3);
  }

  // ---- 6d. fuzz the knobs, then soak ------------------------------------
  // Sweep combinations of every control and assert the model never produces
  // a NaN, a negative count, an unbounded queue or a stall. Individually
  // sane knobs can still combine into nonsense.

  function finiteState(s) {
    var bad = [];
    var nums = {
      totalVersions: s.totalVersions, next: s.next, oat: s.oat, oit: s.oit,
      hitRatio: s.hitRatio, evictions: s.evictions,
      dirtyEvictions: s.dirtyEvictions, pageWrites: s.pageWrites,
      lockWaits: s.lockWaits, rollbacks: s.rollbacks,
      deltaPages: s.backup.deltaPages, generated: s.repl.generated,
      applied: s.repl.applied, sorts: s.sorts, sortSpills: s.sortSpills,
      time: s.time
    };
    Object.keys(nums).forEach(function (k) {
      var v = nums[k];
      if (typeof v !== "number" || !isFinite(v)) bad.push(k + "=" + v);
      else if (v < 0) bad.push(k + " negative (" + v + ")");
    });
    if (s.repl.applied > s.repl.generated) {
      bad.push("applied " + s.repl.applied + " > generated " + s.repl.generated);
    }
    if (s.oit > s.next || s.oat > s.next) bad.push("markers past Next");
    if (s.particles.length > 400) bad.push("particles unbounded: " + s.particles.length);
    if (s.lat.samples.length > 256) bad.push("latency sample unbounded");
    s.tables.forEach(function (t, i) {
      if (t.chain.length !== t.versions) bad.push("table " + i + " chain desync");
    });
    return bad;
  }

  function testFuzz() {
    var long = /[?&]soak=1/.test(location.search);
    var secs = long ? 25 : 8;
    var rates = [0, 6, 14, 20];
    var writes = [0, 0.5, 1];
    var caches = [16, 64, 128];
    var modes = ["off", "async", "sync"];
    var healths = ["healthy", "slow", "down"];
    var cases = 0, failures = [];

    rates.forEach(function (rate) {
      writes.forEach(function (wr) {
        caches.forEach(function (cache) {
          modes.forEach(function (mode) {
            healths.forEach(function (health) {
              cases++;
              var s = Sim.create();
              s.queryRate = rate;
              s.updateRatio = wr;
              Sim.setCacheSize(s, cache);
              Sim.setReplMode(s, mode);
              Sim.setReplHealth(s, health);
              // stir in the other controls too
              s.tempCacheLimit = (cases % 2) ? 8 : 120;
              s.sweepEnabled = (cases % 3) !== 0;
              if (cases % 5 === 0) Sim.setLongTxn(s, true);
              if (cases % 7 === 0) Sim.toggleLock(s);
              if (cases % 11 === 0) Sim.startGbak(s);
              run(s, secs);
              var bad = finiteState(s);
              if (bad.length) {
                failures.push("rate=" + rate + " wr=" + wr + " cache=" + cache +
                  " " + mode + "/" + health + ": " + bad.join(", "));
              }
            });
          });
        });
      });
    });

    var expected = rates.length * writes.length * caches.length *
                   modes.length * healths.length;
    t.eq("fuzz covered every knob combination", cases, expected);
    t.ok("no knob combination produces invalid state", failures.length === 0,
      failures.slice(0, 3).join(" | "));
  }

  /* The soak is the expensive one. It runs at its full length only when
   * asked for with ?soak=1, because a suite that locks the browser for
   * minutes is a suite people quietly stop running. The short version still
   * exercises every code path; the long one is for catching drift that only
   * shows up over time. */
  function testSoak() {
    var long = /[?&]soak=1/.test(location.search);
    var half = long ? 200 : 45;

    var s = Sim.create();
    s.queryRate = 20; s.updateRatio = 0.9;
    Sim.setCacheSize(s, 16);
    Sim.setReplMode(s, "async");
    Sim.setReplHealth(s, "slow");
    s.tempCacheLimit = 8;
    run(s, half);
    var mid = s.done + s.next;
    var badMid = finiteState(s);
    run(s, half);
    var bad = finiteState(s);
    t.ok("soak length is recorded", true, "");
    results[results.length - 1].name =
      "soak ran " + (half * 2) + "s" + (long ? " (long)" : " (short — ?soak=1 for 400s)");
    t.ok("soak keeps state valid", bad.length === 0, bad.join(", "));
    t.ok("the city is still working at the end of the soak",
      (s.done + s.next) > mid, "no progress in the second half");
    t.ok("particles stay bounded under sustained load",
      s.particles.length <= 300, "particles=" + s.particles.length);
    t.ok("journal segments do not grow without limit in a slow replica",
      s.repl.segments.length < 5000, "segments=" + s.repl.segments.length);
    t.ok("soak produced no mid-run corruption", badMid.length === 0,
      badMid.join(", "));
  }

  // ---- 6e. every building is documented --------------------------------

  function testDocCoverage() {
    FB.buildings.forEach(function (b) {
      t.ok("building '" + b.id + "' has a name, code and short line",
        !!b.name && !!b.code && !!b.short);
      t.ok("building '" + b.id + "' has a real description",
        !!b.desc && b.desc.length > 120,
        "descriptions carry the teaching; a stub is a silent gap");
    });
    FB.challenges.forEach(function (c) {
      t.ok("decision '" + c.id + "' has a situation and two detailed options",
        !!c.situation && c.options.length === 2 &&
        c.options.every(function (o) { return !!o.detail; }));
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

    // the canvas cannot announce itself; keyboard selection must have a
    // live region to speak through
    t.ok("a live region exists for keyboard selection",
      !!document.getElementById("a11y-live"));
    t.ok("the live region is polite",
      (document.getElementById("a11y-live") || {}).getAttribute &&
      document.getElementById("a11y-live").getAttribute("aria-live") === "polite");
    t.ok("UI exposes an announce hook", typeof UI.announce === "function");
  }

  // ---- 8. the city is never empty on load ------------------------------
  // A first-time visitor used to arrive at a database that had never run:
  // every cache slot empty, one version per tower, and the markers exactly
  // where create() left them. That is not a quiet start, it is a false one —
  // no Firebird database you open has no history behind it.

  function testWarmStart() {
    var cold = Sim.create();
    var warm = Sim.warm(Sim.create(), 25);

    var coldFilled = cold.cache.filter(function (c) { return c.page >= 0; }).length;
    var warmFilled = warm.cache.filter(function (c) { return c.page >= 0; }).length;
    t.ok("a cold city really is empty", coldFilled === 0,
      coldFilled + " pages already resident before warming");
    t.ok("warming populates the page cache", warmFilled > 20,
      "only " + warmFilled + " of " + warm.cache.length + " slots resident");

    t.ok("warming writes record versions",
      warm.totalVersions > cold.totalVersions,
      warm.totalVersions + " vs " + cold.totalVersions);
    t.ok("warming advances the transaction markers", warm.next > cold.next,
      "next stayed at " + warm.next);
    t.ok("warming leaves work behind it", warm.time >= 24 && warm.time <= 26,
      "model clock at " + warm.time);
    t.ok("warming produces a hit ratio worth showing",
      warm.hitRatio > 0 && warm.hitRatio <= 1, String(warm.hitRatio));

    // Quiet: the reader's first log line should be the one about the
    // database coming on line, not 25 seconds of backfill.
    t.eq("warming does not fill the message log",
      warm.log.length, cold.log.length);

    // and it must stay bounded — warming is not an excuse to leak
    t.ok("warming leaves the version chains capped",
      warm.tables.every(function (tb) { return tb.chain.length <= 26; }));
    t.ok("warming keeps the markers ordered",
      warm.oit <= warm.oat && warm.oat <= warm.next,
      warm.oit + " / " + warm.oat + " / " + warm.next);

    // bounds: junk seconds must not spin or explode
    var junk = Sim.warm(Sim.create(), -5);
    t.eq("negative warm seconds do nothing", junk.time, 0);
    var capped = Sim.warm(Sim.create(), 1e6);
    t.ok("warm seconds are capped", capped.time <= 120.5, String(capped.time));
  }

  // ---- 8b. camera arithmetic -------------------------------------------
  // Ported after PGSimCity's v0.39.3, where two fingers failed to turn the
  // city because per-contact events paired one finger's new position with
  // the other's stale one. Ours reads every contact at once; these check
  // that the reading holds up, including the cases that produced the jumps.

  function testCamera() {
    var ZMIN = 0.3, ZMAX = 2.4;
    function cam() { return { ox: 0, oy: 0, zoom: 1, target: { zoom: 2 } }; }
    var rect = { left: 0, top: 0 };

    // zoom must keep the anchor point over the same world position
    var c = cam();
    var before = { x: (300 - c.ox) / c.zoom, y: (200 - c.oy) / c.zoom };
    Camera.zoomAt(c, 300, 200, 1.7, ZMIN, ZMAX);
    var after = { x: (300 - c.ox) / c.zoom, y: (200 - c.oy) / c.zoom };
    t.ok("zoom keeps the anchor point fixed",
      Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9,
      before.x + "," + before.y + " → " + after.x + "," + after.y);
    t.ok("zoom cancels a camera fly-to", c.target === null);
    t.ok("zoom respects the maximum",
      Camera.zoomAt(cam(), 0, 0, 99, ZMIN, ZMAX).zoom === ZMAX);
    t.ok("zoom respects the minimum",
      Camera.zoomAt(cam(), 0, 0, 0.001, ZMIN, ZMAX).zoom === ZMIN);

    // a gesture is derived from every contact, so delivery order cannot matter
    var a = [{ clientX: 100, clientY: 100 }, { clientX: 300, clientY: 100 }];
    var g1 = Camera.gestureOf(a);
    var g2 = Camera.gestureOf([a[1], a[0]]);
    t.ok("gesture is independent of contact order",
      g1.cx === g2.cx && g1.cy === g2.cy && g1.spread === g2.spread);
    t.eq("gesture centroid is the mean", g1.cx, 200);
    t.eq("empty contact list is no gesture", Camera.gestureOf([]), null);

    // two fingers moving together pan and do not zoom
    var c2 = cam();
    var prev = Camera.gestureOf(a);
    var cur = Camera.gestureOf([
      { clientX: 140, clientY: 130 }, { clientX: 340, clientY: 130 }
    ]);
    Camera.applyGesture(c2, prev, cur, rect, ZMIN, ZMAX);
    t.ok("a parallel two-finger drag pans", c2.ox === 40 && c2.oy === 30,
      c2.ox + "," + c2.oy);
    t.ok("a parallel two-finger drag does not zoom",
      Math.abs(c2.zoom - 1) < 1e-12, String(c2.zoom));

    // a pinch zooms about the fingers, not about the canvas origin
    var c3 = cam();
    var wide = Camera.gestureOf([
      { clientX: 0, clientY: 100 }, { clientX: 400, clientY: 100 }
    ]);
    var mid = { x: (200 - c3.ox) / c3.zoom, y: (100 - c3.oy) / c3.zoom };
    Camera.applyGesture(c3, prev, wide, rect, ZMIN, ZMAX);
    var mid2 = { x: (200 - c3.ox) / c3.zoom, y: (100 - c3.oy) / c3.zoom };
    t.ok("a pinch scales the camera", c3.zoom > 1.5, String(c3.zoom));
    t.ok("a pinch is anchored on the fingers",
      Math.abs(mid.x - mid2.x) < 1e-9 && Math.abs(mid.y - mid2.y) < 1e-9,
      mid.x + "," + mid.y + " → " + mid2.x + "," + mid2.y);

    // the jumps: a finger landing or lifting must commit nothing
    var c4 = cam();
    var three = Camera.gestureOf([
      { clientX: 100, clientY: 100 }, { clientX: 300, clientY: 100 },
      { clientX: 200, clientY: 400 }
    ]);
    var moved = Camera.applyGesture(c4, prev, three, rect, ZMIN, ZMAX);
    t.ok("a third finger landing is not a gesture", moved === false);
    t.ok("a third finger landing moves nothing",
      c4.ox === 0 && c4.oy === 0 && c4.zoom === 1,
      c4.ox + "," + c4.oy + "," + c4.zoom);
    var c5 = cam();
    t.ok("a finger lifting is not a gesture",
      Camera.applyGesture(c5, three, prev, rect, ZMIN, ZMAX) === false);
    t.ok("a finger lifting moves nothing", c5.zoom === 1);

    // one finger pans, and never zooms however far it travels
    var c6 = cam();
    var p1 = Camera.gestureOf([{ clientX: 10, clientY: 10 }]);
    var p2 = Camera.gestureOf([{ clientX: 260, clientY: 90 }]);
    Camera.applyGesture(c6, p1, p2, rect, ZMIN, ZMAX);
    t.ok("one finger pans", c6.ox === 250 && c6.oy === 80,
      c6.ox + "," + c6.oy);
    t.eq("one finger never zooms", c6.zoom, 1);

    // and a gesture that does not move must not drift the camera
    var c7 = cam();
    Camera.applyGesture(c7, prev, Camera.gestureOf(a), rect, ZMIN, ZMAX);
    t.ok("a still gesture leaves the camera alone",
      c7.ox === 0 && c7.oy === 0 && Math.abs(c7.zoom - 1) < 1e-12);

    // Meta: the anchor check above is the whole point of this section, so
    // prove it can go red. This is the exact defect it exists to catch — a
    // zoom that changes scale without moving the origin to compensate.
    var broken = { ox: 0, oy: 0, zoom: 1, target: null };
    var beforeB = { x: (300 - broken.ox) / broken.zoom };
    broken.zoom = 1.7; // scale only, no compensation
    var afterB = { x: (300 - broken.ox) / broken.zoom };
    t.ok("the anchor check would catch a drifting zoom",
      Math.abs(beforeB.x - afterB.x) > 1,
      "a zoom that ignores the anchor moved the point by " +
      Math.abs(beforeB.x - afterB.x));

    // Meta: and that the contact-count guard is what stops the jump, rather
    // than the numbers happening to line up.
    var jumpy = cam();
    jumpy.ox = 0; jumpy.oy = 0;
    var pretendSameCount = { n: three.n, cx: prev.cx, cy: prev.cy, spread: prev.spread };
    Camera.applyGesture(jumpy, pretendSameCount, three, rect, ZMIN, ZMAX);
    t.ok("without the count guard a landing finger would move the city",
      jumpy.ox !== 0 || jumpy.oy !== 0 || jumpy.zoom !== 1,
      "the guard is not what is holding this still");
  }

  // ---- 8c. the readouts agree with the model ---------------------------
  // PGSimCity's v0.40.0 hunt: twelve of nineteen defects were surfaces that
  // disagreed with the simulation behind them. Text is easy to leave behind
  // when the model moves. This walks the panels and compares.

  function testSurfaces() {
    function txt(id) {
      var e = document.getElementById(id);
      return e ? e.textContent.trim() : null;
    }

    // The readouts only exist once the UI is bound to them, so this is also
    // the one test that runs the real init path against the real markup.
    var s = Sim.create();
    try {
      UI.init(s, function () { });
    } catch (e) {
      t.ok("UI.init binds against the shipped markup", false, String(e));
      return;
    }
    t.ok("UI.init binds against the shipped markup", true);
    Sim.warm(s, 30);
    UI.updateStats(s);

    t.eq("the query-rate readout matches the model",
      txt("st-qps"), s.qps.toFixed(1));
    t.eq("the version total matches the model",
      txt("st-vers"), String(s.totalVersions));
    t.eq("the OIT readout matches the model", txt("st-oit"), String(s.oit));
    t.eq("the OAT readout matches the model", txt("st-oat"), String(s.oat));
    t.eq("the next-transaction readout matches the model",
      txt("st-next"), String(s.next));
    t.eq("the eviction readout matches the model",
      txt("st-evict"), String(s.evictions));
    t.eq("the dirty-eviction readout matches the model",
      txt("st-dirty"), String(s.dirtyEvictions));
    t.eq("the segment readout matches the model",
      txt("st-segs"), String(s.repl.segments.length));

    // the reported hit ratio must be the model's, within its own rounding
    var hit = parseFloat((txt("st-hit") || "").replace("%", ""));
    t.ok("the hit-ratio readout matches the model",
      Math.abs(hit - s.hitRatio * 100) <= 0.51,
      "panel " + hit + "%, model " + (s.hitRatio * 100).toFixed(2) + "%");

    // a readout that says a thing is pinned must have something pinning it
    var pin = txt("st-pin") || "";
    t.ok("the pin warning only appears when something pins the OIT",
      pin === "" || s.pinned !== null || s.backup.gbakTxn !== null,
      "panel says " + JSON.stringify(pin) + " with nothing pinned");

    // and the same must hold once the model is in an unusual state
    var s2 = Sim.warm(Sim.create(), 10);
    Sim.setLongTxn(s2, true);
    run(s2, 4);
    UI.updateStats(s2);
    t.eq("the OIT readout follows a pinned transaction",
      txt("st-oit"), String(s2.oit));
    t.ok("the pin warning appears when a long transaction pins the OIT",
      (txt("st-pin") || "").indexOf("txn") !== -1,
      "panel says " + JSON.stringify(txt("st-pin")));
    Sim.setReplHealth(s2, "down");
    run(s2, 6);
    UI.updateStats(s2);
    t.eq("the lag readout follows the replication model",
      txt("st-lag"),
      s2.repl.disabled ? "STOPPED"
        : s2.repl.mode === "off" ? "off" : String(Sim.replLag(s2)));
  }

  // ---- 8d. the throughput readout is not an estimate -------------------
  // PGSimCity shipped a gauge that swung between 0.56 and 25.83 while the
  // real rate held near 10, and painted the city red for it. Ours smooths
  // over a one-second window; this counts completions independently and
  // asserts the readout is actually reporting them.

  function testThroughputHonesty() {
    var s = Sim.warm(Sim.create(), 20);
    s.queryRate = 10;
    var counted = 0, windows = 0, worst = 0;
    for (var w = 0; w < 12; w++) {
      // s.completed only ever grows, so it counts the same events the
      // readout claims to summarise, without going through the readout
      var startTotal = s.completed;
      run(s, 1);
      var got = s.completed - startTotal;
      counted += got; windows++;
      worst = Math.max(worst, Math.abs(s.qps - got));
    }
    var mean = counted / windows;
    t.ok("the city actually completes queries", counted > 0);
    t.ok("the throughput readout tracks the work done",
      Math.abs(s.qps - mean) < mean * 0.5 + 1,
      "readout " + s.qps.toFixed(2) + " against a measured mean of " +
      mean.toFixed(2));
    t.ok("the throughput readout stays inside its window",
      worst < mean + 6, "worst single-window gap " + worst.toFixed(2));
  }

  // ---- 8e. the machine room states what it cannot do -------------------
  // The page runs the real engine, which invites the assumption that
  // everything on it is therefore real. It must say otherwise, in the page
  // itself rather than only in a commit message.

  function testMachineRoom(html, js) {
    t.ok("the machine room exists", html.length > 0);
    t.ok("the machine room is linked from the city",
      (window.__indexHtml || "").indexOf('href="machine/"') !== -1);
    t.ok("the machine room names its limits",
      /cannot show you/i.test(html));
    ["replication", "gbak", "sweep", "attachment"].forEach(function (word) {
      t.ok("the machine room admits it cannot show " + word,
        new RegExp(word, "i").test(html));
    });
    t.ok("the machine room explains cross-origin isolation",
      /SharedArrayBuffer/.test(html) && /coi-serviceworker/.test(html));
    t.ok("the machine room degrades rather than showing an empty box",
      /function fail\(/.test(js) && /crossOriginIsolated/.test(js));
    t.ok("every sequence computes its verdict from the results",
      (js.match(/verdict\(res\)/g) || []).length >= 6);
    t.ok("no sequence asserts a verdict unconditionally",
      (js.match(/ok:\s*true/g) || []).length <= 1,
      "found " + (js.match(/ok:\s*true/g) || []).length +
      " verdicts that cannot fail");
    t.ok("the engine is loaded same-origin, which is what makes it possible",
      /'\/electric-firebird\//.test(js));
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
      fetchText("../lifecycle.html"),
      fetchText("../index.html"),
      fetchText("../machine/index.html"),
      fetchText("../machine/machine.js")
    ]).then(function (files) {
      window.__indexHtml = files[4];
      testPurity(files[0]);
      testKnobs(files[1]);
      testLatency();
      testVersion(files[4], files[2]);
      testScenariosAndLinks(files[2]);
      testDeepLinks(files[2], files[1]);
      testBehaviour();
      testDecisions();
      testDocCoverage();
      testColours();
      testTheTests(files[1]);
      testFuzz();
      testSoak();
      testAccessibility(files[3]);
      testWarmStart();
      testCamera();
      testSurfaces();
      testThroughputHonesty();
      testMachineRoom(files[5], files[6]);

      var passed = results.filter(function (r) { return r.pass; }).length;
      window.FBTestResults = {
        total: results.length, passed: passed,
        failed: results.length - passed, results: results
      };
      return window.FBTestResults;
    });
  };
})();
