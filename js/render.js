/* FBSimCity — isometric canvas renderer.
 * Structure is matte, meaning is neon: static geometry stays dim, anything
 * that carries information (particles, flashes, counters) glows.
 */
var Render = (function () {
  "use strict";

  var TW = 24, TH = 12, TZ = 16; // tile metrics

  var THEMES = {
    dark: {
      bgTop: "#0b0e1a", bgBot: "#101528",
      ground: "#131a2e", groundStroke: "rgba(90,110,160,0.25)",
      districtStroke: "rgba(140,160,220,0.22)",
      districtLabel: "rgba(170,185,230,0.5)",
      road: "rgba(120,140,200,0.18)", roadDash: "rgba(190,205,255,0.14)",
      pitWallX: "#191233", pitWallY: "#221844", pitFloor: "#160f2e",
      pitStroke: "rgba(140,120,220,0.3)", pitStripe: "rgba(150,130,240,0.22)",
      pitLabel: "rgba(190,170,255,0.55)",
      cacheEmpty: "rgba(60,70,110,0.55)", cacheResident: "rgba(76,110,245,0.55)",
      labelStrong: "#ffffff", label: "rgba(220,228,255,0.75)",
      labelDim: "rgba(150,165,215,0.7)",
      tipOk: "#ffe066", tipBad: "#ff8787", tipAlert: "#ff6b6b",
      deltaWallX: "#2b1608", deltaWallY: "#3a1e0b", deltaFloor: "#241305",
      deltaStroke: "rgba(232,140,60,0.35)", deltaLabel: "rgba(255,190,140,0.5)",
      replWallX: "#1d1440", replWallY: "#261a52", replFloor: "#181035",
      replDeadX: "#2a1420", replDeadY: "#341a28",
      replStroke: "rgba(150,120,240,0.35)", replLabel: "rgba(200,180,255,0.6)"
    },
    day: {
      bgTop: "#dbe4f3", bgBot: "#eef3fb",
      ground: "#e4eaf5", groundStroke: "rgba(70,90,150,0.3)",
      districtStroke: "rgba(70,95,170,0.3)",
      districtLabel: "rgba(45,65,120,0.7)",
      road: "rgba(70,90,150,0.2)", roadDash: "rgba(35,55,110,0.3)",
      pitWallX: "#c6cbe6", pitWallY: "#b8bede", pitFloor: "#d3d8ee",
      pitStroke: "rgba(100,90,190,0.45)", pitStripe: "rgba(100,85,200,0.35)",
      pitLabel: "rgba(85,70,170,0.85)",
      cacheEmpty: "rgba(150,160,200,0.5)", cacheResident: "rgba(76,110,245,0.5)",
      labelStrong: "#141c36", label: "rgba(30,45,90,0.9)",
      labelDim: "rgba(60,80,140,0.8)",
      tipOk: "#8a5a00", tipBad: "#b02525", tipAlert: "#c92a2a",
      deltaWallX: "#e2cbb6", deltaWallY: "#d6bca4", deltaFloor: "#eeddcc",
      deltaStroke: "rgba(190,110,40,0.5)", deltaLabel: "rgba(150,80,20,0.8)",
      replWallX: "#cfc6ee", replWallY: "#c0b5e6", replFloor: "#e2dcf5",
      replDeadX: "#e6cdd6", replDeadY: "#dcbfcb",
      replStroke: "rgba(110,80,200,0.5)", replLabel: "rgba(80,50,170,0.85)"
    }
  };
  var T = THEMES.dark;
  var themeName = "dark";
  var lastSim = null;
  var hoveredTower = null;
  var selectedTower = null;

  /* Respect prefers-reduced-motion: the information is in the colours and
   * the numbers, not in the pulsing, so the decorative animation stops
   * while everything that carries meaning stays. */
  var calm = false;
  try {
    var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    calm = mq.matches;
    mq.addEventListener("change", function (e) { calm = e.matches; });
  } catch (e) { }

  function pulse(time, speed) {
    return calm ? 1 : 0.5 + 0.5 * Math.sin(time * speed);
  }

  function setTheme(name) {
    if (THEMES[name]) { T = THEMES[name]; themeName = name; }
  }

  function proj(cam, wx, wy, wz) {
    return [
      (wx - wy) * TW * cam.zoom + cam.ox,
      (wx + wy) * TH * cam.zoom - (wz || 0) * TZ * cam.zoom + cam.oy
    ];
  }

  function shade(hex, f) {
    var r = parseInt(hex.slice(1, 3), 16),
        g = parseInt(hex.slice(3, 5), 16),
        b = parseInt(hex.slice(5, 7), 16);
    r = Math.max(0, Math.min(255, Math.round(r * f)));
    g = Math.max(0, Math.min(255, Math.round(g * f)));
    b = Math.max(0, Math.min(255, Math.round(b * f)));
    return "rgb(" + r + "," + g + "," + b + ")";
  }

  function poly(ctx, pts, fill, stroke, lw) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
  }

  /* box at footprint (x,y,w,d) height h; returns screen pts used for picking */
  function drawBox(ctx, cam, x, y, w, d, h, color, glow) {
    var a0 = proj(cam, x, y, 0), b0 = proj(cam, x + w, y, 0),
        c0 = proj(cam, x + w, y + d, 0), d0 = proj(cam, x, y + d, 0),
        a1 = proj(cam, x, y, h), b1 = proj(cam, x + w, y, h),
        c1 = proj(cam, x + w, y + d, h), d1 = proj(cam, x, y + d, h);
    // +x face (right)
    poly(ctx, [b1, c1, c0, b0], shade(color, 0.55));
    // +y face (front-left)
    poly(ctx, [d1, c1, c0, d0], shade(color, 0.78));
    // top
    poly(ctx, [a1, b1, c1, d1], shade(color, 1.18), "rgba(0,0,0,0.35)", 1);
    if (glow > 0) {
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 18 * glow * cam.zoom;
      ctx.globalAlpha = Math.min(1, 0.35 + glow * 0.65);
      poly(ctx, [a1, b1, c1, d1], null, color, 1.6);
      ctx.restore();
    }
    return [a1, b1, c1, d1, b0, c0, d0];
  }

  function diamond(ctx, cam, x, y, r, fill, stroke) {
    var pts = [
      proj(cam, x - r, y - r, 0), proj(cam, x + r, y - r, 0),
      proj(cam, x + r, y + r, 0), proj(cam, x - r, y + r, 0)
    ];
    poly(ctx, pts, fill, stroke, 1);
  }

  // ---------------------------------------------------------------------

  function drawGround(ctx, cam, cw, ch, s) {
    // backdrop
    var g = ctx.createLinearGradient(0, 0, 0, ch);
    g.addColorStop(0, T.bgTop);
    g.addColorStop(1, T.bgBot);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, ch);

    // ground diamond
    var b = FB.bounds;
    poly(ctx, [
      proj(cam, b.x0, b.y0, 0), proj(cam, b.x1, b.y0, 0),
      proj(cam, b.x1, b.y1, 0), proj(cam, b.x0, b.y1, 0)
    ], T.ground, T.groundStroke, 1);

    // districts
    FB.districts.forEach(function (dz) {
      var pts = [
        proj(cam, dz.x, dz.y, 0), proj(cam, dz.x + dz.w, dz.y, 0),
        proj(cam, dz.x + dz.w, dz.y + dz.d, 0), proj(cam, dz.x, dz.y + dz.d, 0)
      ];
      poly(ctx, pts, dz.color, T.districtStroke, 1);
      if (cam.zoom > 0.55) {
        ctx.fillStyle = T.districtLabel;
        ctx.font = (10 * Math.min(cam.zoom, 1.3)) + "px 'Segoe UI', sans-serif";
        var lp = proj(cam, dz.x + 0.4, dz.y + 0.2, 0);
        ctx.fillText(dz.name, lp[0], lp[1] + 12 * cam.zoom);
      }
    });

    // roads
    ctx.strokeStyle = T.road;
    ctx.lineWidth = Math.max(2, 10 * cam.zoom);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    FB.roads.forEach(function (seq) {
      ctx.beginPath();
      for (var i = 0; i < seq.length; i++) {
        var p = FB.stations[seq[i]];
        var sp = proj(cam, p.x, p.y, 0);
        if (i === 0) ctx.moveTo(sp[0], sp[1]); else ctx.lineTo(sp[0], sp[1]);
      }
      ctx.stroke();
    });
    // center dashes
    ctx.strokeStyle = T.roadDash;
    ctx.lineWidth = Math.max(1, 1.5 * cam.zoom);
    ctx.setLineDash([6 * cam.zoom, 8 * cam.zoom]);
    FB.roads.forEach(function (seq) {
      ctx.beginPath();
      for (var i = 0; i < seq.length; i++) {
        var p = FB.stations[seq[i]];
        var sp = proj(cam, p.x, p.y, 0);
        if (i === 0) ctx.moveTo(sp[0], sp[1]); else ctx.lineTo(sp[0], sp[1]);
      }
      ctx.stroke();
    });
    ctx.setLineDash([]);

    // Prepared statement cache expressway (Y-Valve -> Execution Hall)
    if (s && s.stmtCacheRatio > 0) {
      var yv = FB.stations.yvalve, ex = FB.stations.exec;
      var pYv = proj(cam, yv.x, yv.y, 0);
      var pEx = proj(cam, ex.x, ex.y, 0);
      ctx.save();
      ctx.strokeStyle = "rgba(192,132,252," + (0.28 + s.stmtCacheRatio * 0.48) + ")";
      ctx.lineWidth = Math.max(1.5, 4 * cam.zoom);
      ctx.setLineDash([7 * cam.zoom, 5 * cam.zoom]);
      ctx.beginPath();
      ctx.moveTo(pYv[0], pYv[1]);
      ctx.lineTo(pEx[0], pEx[1]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (cam.zoom > 0.6) {
        var pMid = proj(cam, (yv.x + ex.x) / 2, (yv.y + ex.y) / 2 + 1.1, 0);
        ctx.fillStyle = "#c084fc";
        ctx.font = (9.5 * Math.min(cam.zoom, 1.3)) + "px 'Segoe UI', sans-serif";
        ctx.fillText("StatementCache (" + Math.round(s.stmtCacheRatio * 100) + "%)",
          pMid[0], pMid[1]);
      }
      ctx.restore();
    }
  }

  function drawCachePlaza(ctx, cam, s) {
    var b = FB.byId.cache;
    var cols = 16;
    var rows = Math.ceil(s.cache.length / cols);
    var cw = (b.w - 1) / cols, chh = Math.min(0.62, (b.d - 1) / rows);
    for (var i = 0; i < s.cache.length; i++) {
      var slot = s.cache[i];
      var cx = b.x + 0.8 + (i % cols) * cw;
      var cy = b.y + 0.8 + Math.floor(i / cols) * chh;
      var fill = T.cacheEmpty;
      if (slot.page >= 0) fill = T.cacheResident;
      var hotBorder = null;
      if (slot.page >= 0 && s.time > 0 && (s.time - slot.lastUse) < 2.5) {
        hotBorder = "rgba(116,192,252,0.55)";
      }
      diamond(ctx, cam, cx, cy, 0.24, fill, hotBorder);
      if (slot.dirty && cam.zoom > 0.65) {
        var dp = proj(cam, cx, cy, 0.08);
        ctx.fillStyle = "#fcc419";
        ctx.beginPath();
        ctx.arc(dp[0], dp[1], Math.max(1.2, 1.8 * cam.zoom), 0, Math.PI * 2);
        ctx.fill();
      }
      if (slot.flash > 0) {
        // Redundant encoding: hit, miss and dirty differ in hue, in
        // luminance and in size, so none of the three depends on colour
        // vision alone. A miss is drawn largest — it is the one that cost
        // you a trip to the database file.
        var col, r;
        if (slot.state === 2) { col = "224,49,49"; r = 0.38; }        // miss
        else if (slot.state === 3) { col = "252,196,25"; r = 0.31; }  // dirty
        else { col = "81,207,102"; r = 0.26; }                        // hit
        ctx.save();
        ctx.globalAlpha = Math.max(0, slot.flash);
        diamond(ctx, cam, cx, cy, r, "rgba(" + col + ",0.92)", null);
        ctx.restore();
      }
    }
    // careful-write precedence arcs (CCH_precedence): parent->child page order
    if (s.precedenceArcs && s.precedenceArcs.length) {
      ctx.save();
      ctx.lineWidth = Math.max(1.2, 1.8 * cam.zoom);
      for (var k = 0; k < s.precedenceArcs.length; k++) {
        var arc = s.precedenceArcs[k];
        if (arc.from >= s.cache.length || arc.to >= s.cache.length) continue;
        var fx = b.x + 0.8 + (arc.from % cols) * cw;
        var fy = b.y + 0.8 + Math.floor(arc.from / cols) * chh;
        var tx = b.x + 0.8 + (arc.to % cols) * cw;
        var ty = b.y + 0.8 + Math.floor(arc.to / cols) * chh;
        var pFrom = proj(cam, fx, fy, 0.1);
        var pTo = proj(cam, tx, ty, 0.1);
        var pMid = proj(cam, (fx + tx) / 2, (fy + ty) / 2, 0.9);
        ctx.globalAlpha = Math.max(0, Math.min(1, arc.flash * 0.85));
        ctx.strokeStyle = "#ffd43b";
        ctx.beginPath();
        ctx.moveTo(pFrom[0], pFrom[1]);
        ctx.quadraticCurveTo(pMid[0], pMid[1], pTo[0], pTo[1]);
        ctx.stroke();
      }
      ctx.restore();
    }
    // Classic / SuperClassic: draw per-attachment cache partition dividers
    // and blocking AST signals from Lock Manager Tower to Page Cache Plaza
    if (s.serverMode && s.serverMode !== "super") {
      ctx.save();
      ctx.strokeStyle = "rgba(34,211,238,0.55)";
      ctx.lineWidth = Math.max(1, 1.5 * cam.zoom);
      ctx.setLineDash([4 * cam.zoom, 4 * cam.zoom]);
      for (var p = 1; p < 4; p++) {
        var divX = b.x + 0.8 + (p * 4 - 0.5) * cw;
        var d0 = proj(cam, divX, b.y + 0.4, 0.05);
        var d1 = proj(cam, divX, b.y + b.d - 0.4, 0.05);
        ctx.beginPath();
        ctx.moveTo(d0[0], d0[1]);
        ctx.lineTo(d1[0], d1[1]);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      if (s.astArcs && s.astArcs.length) {
        var lk = FB.byId.lock;
        var pLock = proj(cam, lk.x + lk.w / 2, lk.y + lk.d / 2, lk.h + 0.3);
        ctx.lineWidth = Math.max(1.2, 1.8 * cam.zoom);
        for (var ai = 0; ai < s.astArcs.length; ai++) {
          var ast = s.astArcs[ai];
          if (ast.slot < 0 || ast.slot >= s.cache.length) continue;
          var sx = b.x + 0.8 + (ast.slot % cols) * cw;
          var sy = b.y + 0.8 + Math.floor(ast.slot / cols) * chh;
          var pSlot = proj(cam, sx, sy, 0.15);
          ctx.globalAlpha = Math.max(0, Math.min(1, ast.flash * 0.85));
          ctx.strokeStyle = "#22d3ee";
          ctx.beginPath();
          ctx.moveTo(pLock[0], pLock[1]);
          ctx.lineTo(pSlot[0], pSlot[1]);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  function drawStorage(ctx, cam, s) {
    var b = FB.byId.pio;
    // pit walls
    var depth = 1.2;
    var a0 = proj(cam, b.x, b.y, 0), b0 = proj(cam, b.x + b.w, b.y, 0),
        c0 = proj(cam, b.x + b.w, b.y + b.d, 0), d0 = proj(cam, b.x, b.y + b.d, 0),
        a1 = proj(cam, b.x, b.y, -depth), b1 = proj(cam, b.x + b.w, b.y, -depth),
        c1 = proj(cam, b.x + b.w, b.y + b.d, -depth), d1 = proj(cam, b.x, b.y + b.d, -depth);
    poly(ctx, [a0, b0, b1, a1], T.pitWallX);
    poly(ctx, [a0, d0, d1, a1], T.pitWallY);
    poly(ctx, [a1, b1, c1, d1], T.pitFloor, T.pitStroke, 1);
    // page stripes on the pit floor
    var stripes = 20;
    for (var i = 0; i < stripes; i++) {
      var fx = b.x + 0.6 + (b.w - 1.2) * (i / stripes);
      var p0 = proj(cam, fx, b.y + 0.5, -depth), p1 = proj(cam, fx, b.y + b.d - 0.5, -depth);
      ctx.strokeStyle = T.pitStripe;
      ctx.lineWidth = Math.max(1, 3 * cam.zoom);
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
    }
    // disk activity flash at the accessed page position
    if (s.diskFlash > 0) {
      var fx2 = b.x + 0.6 + (b.w - 1.2) * s.diskPos;
      var fp = proj(cam, fx2, b.y + b.d / 2, -depth);
      ctx.save();
      ctx.globalAlpha = Math.max(0, s.diskFlash);
      ctx.fillStyle = "#ffd43b";
      ctx.shadowColor = "#ffd43b";
      ctx.shadowBlur = 16 * cam.zoom;
      ctx.beginPath();
      ctx.arc(fp[0], fp[1], 5 * cam.zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // BLOB page segment zone on the right-hand stripes of the database file
    if (s.blobFlash > 0) {
      var bx0 = b.x + b.w * 0.78, bx1 = b.x + b.w - 0.5;
      var bp0 = proj(cam, bx0, b.y + 0.45, -depth + 0.04),
          bp1 = proj(cam, bx1, b.y + 0.45, -depth + 0.04),
          bp2 = proj(cam, bx1, b.y + b.d - 0.45, -depth + 0.04),
          bp3 = proj(cam, bx0, b.y + b.d - 0.45, -depth + 0.04);
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, s.blobFlash * 0.85));
      poly(ctx, [bp0, bp1, bp2, bp3], "rgba(192,132,252,0.32)", "#c084fc", 1.4);
      ctx.restore();
    }
    if (cam.zoom > 0.55) {
      ctx.fillStyle = s.forcedWrites === false ? "#ffa94d" : T.pitLabel;
      ctx.font = (10 * Math.min(cam.zoom, 1.3)) + "px 'Segoe UI', sans-serif";
      var lp = proj(cam, b.x + 0.5, b.y + b.d - 0.4, -depth);
      ctx.fillText(s.forcedWrites === false
        ? "careful writes (forced writes OFF — OS-buffered)"
        : "careful writes (forced writes ON) — no WAL needed", lp[0], lp[1]);
    }
  }

  function hex2(n) {
    var h = Math.max(0, Math.min(255, Math.round(n))).toString(16);
    return h.length < 2 ? "0" + h : h;
  }

  /* The difference file: a shallow pit beside the main excavation that
   * fills with orange as diverted writes accumulate while the database is
   * locked, and drains as the delta merges back. */
  function drawDelta(ctx, cam, s) {
    var b = FB.byId.delta, bk = s.backup;
    var depth = 0.8;
    var a0 = proj(cam, b.x, b.y, 0), b0 = proj(cam, b.x + b.w, b.y, 0),
        c0 = proj(cam, b.x + b.w, b.y + b.d, 0), d0 = proj(cam, b.x, b.y + b.d, 0),
        a1 = proj(cam, b.x, b.y, -depth), b1 = proj(cam, b.x + b.w, b.y, -depth),
        c1 = proj(cam, b.x + b.w, b.y + b.d, -depth), d1 = proj(cam, b.x, b.y + b.d, -depth);
    poly(ctx, [a0, b0, b1, a1], T.deltaWallX);
    poly(ctx, [a0, d0, d1, a1], T.deltaWallY);
    poly(ctx, [a1, b1, c1, d1], T.deltaFloor, T.deltaStroke, 1);

    // fill level: how full the delta is (caps out for display at 400 pages)
    var fill = Math.min(1, bk.deltaPages / 400);
    if (fill > 0) {
      var fy = b.y + b.d - (b.d - 0.6) * fill;
      var f0 = proj(cam, b.x + 0.3, fy, -depth + 0.05),
          f1 = proj(cam, b.x + b.w - 0.3, fy, -depth + 0.05),
          f2 = proj(cam, b.x + b.w - 0.3, b.y + b.d - 0.3, -depth + 0.05),
          f3 = proj(cam, b.x + 0.3, b.y + b.d - 0.3, -depth + 0.05);
      ctx.save();
      ctx.globalAlpha = bk.merging ? 0.55 : 0.8;
      poly(ctx, [f0, f1, f2, f3], "#e8590c", "rgba(255,169,77,0.7)", 1);
      ctx.restore();
    }
    if (bk.deltaFlash > 0) {
      var dp = proj(cam, b.x + b.w / 2, b.y + b.d / 2, -depth + 0.1);
      ctx.save();
      ctx.globalAlpha = Math.max(0, bk.deltaFlash);
      ctx.fillStyle = "#ffa94d";
      ctx.shadowColor = "#ffa94d";
      ctx.shadowBlur = 14 * cam.zoom;
      ctx.beginPath();
      ctx.arc(dp[0], dp[1], 4.5 * cam.zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (cam.zoom > 0.55) {
      ctx.fillStyle = bk.locked ? "#ffa94d" : T.deltaLabel;
      ctx.font = (10 * Math.min(cam.zoom, 1.3)) + "px 'Segoe UI', sans-serif";
      var lp = proj(cam, b.x + 0.4, b.y + b.d - 0.35, -depth);
      ctx.fillText(bk.locked ? "LOCKED — writes divert here"
        : bk.merging ? "merging back…" : "delta file (idle)", lp[0], lp[1]);
    }
  }

  /* The replica: a second database, drawn as a shallower pit than the
   * primary's excavation because it is the same history, not the same file. */
  function drawReplica(ctx, cam, s) {
    var b = FB.byId.replica, r = s.repl;
    var depth = 0.7;
    var a0 = proj(cam, b.x, b.y, 0), b0 = proj(cam, b.x + b.w, b.y, 0),
        c0 = proj(cam, b.x + b.w, b.y + b.d, 0), d0 = proj(cam, b.x, b.y + b.d, 0),
        a1 = proj(cam, b.x, b.y, -depth), b1 = proj(cam, b.x + b.w, b.y, -depth),
        c1 = proj(cam, b.x + b.w, b.y + b.d, -depth), d1 = proj(cam, b.x, b.y + b.d, -depth);
    var dead = r.mode === "off" || r.disabled || r.health === "down";
    poly(ctx, [a0, b0, b1, a1], dead ? T.replDeadX : T.replWallX);
    poly(ctx, [a0, d0, d1, a1], dead ? T.replDeadY : T.replWallY);
    poly(ctx, [a1, b1, c1, d1], T.replFloor, T.replStroke, 1);

    // applied history, drawn as filled rows of the replica's floor
    var rows = 8, cols = 6;
    var filled = r.generated > 0
      ? Math.round((r.applied / Math.max(1, r.generated)) * rows * cols) : 0;
    for (var i = 0; i < rows * cols; i++) {
      var rx = b.x + 0.7 + (i % cols) * ((b.w - 1.4) / (cols - 1));
      var ry = b.y + 0.7 + Math.floor(i / cols) * ((b.d - 1.4) / (rows - 1));
      var p = proj(cam, rx, ry, -depth + 0.05);
      ctx.fillStyle = i < filled ? "rgba(132,94,247,0.85)" : "rgba(120,110,180,0.18)";
      ctx.beginPath();
      ctx.arc(p[0], p[1], 2.4 * cam.zoom, 0, Math.PI * 2);
      ctx.fill();
    }
    if (cam.zoom > 0.55) {
      ctx.fillStyle = dead ? "#ff8787" : T.replLabel;
      ctx.font = (10 * Math.min(cam.zoom, 1.3)) + "px 'Segoe UI', sans-serif";
      var lp = proj(cam, b.x + 0.4, b.y + b.d - 0.3, -depth);
      var label = r.disabled ? "REPLICATION STOPPED (disable_on_error)"
        : r.mode === "off" ? "replication off"
        : r.health === "down" ? "REPLICA UNREACHABLE"
        : r.health === "slow" ? "applying slowly — lag " + Sim.replLag(s)
        : "in step (lag " + Sim.replLag(s) + ")";
      ctx.fillText(label, lp[0], lp[1]);
    }
  }

  /* Sealed journal segments waiting to ship, stacked in the yard — plus the
   * open segment filling up in front of them, so the approach to a seal is
   * continuously visible rather than a sudden pop. */
  function drawJournal(ctx, cam, s) {
    var b = FB.byId.journal, r = s.repl;

    if (r.mode === "async" && !r.disabled) {
      var frac = r.pending / Sim.SEGMENT_SIZE;
      var ox = b.x + 0.4, oy = b.y + b.d - 0.9;
      // outline of the segment being written
      var o0 = proj(cam, ox, oy, 0), o1 = proj(cam, ox + 0.62, oy, 0),
          o2 = proj(cam, ox + 0.62, oy + 0.55, 0), o3 = proj(cam, ox, oy + 0.55, 0);
      poly(ctx, [o0, o1, o2, o3], "rgba(132,94,247,0.16)",
        "rgba(160,130,255,0.55)", 1);
      if (frac > 0) {
        drawBox(ctx, cam, ox, oy, 0.62, 0.55, 0.05 + frac * 0.5, "#b197fc", 0);
      }
      if (cam.zoom > 0.7) {
        var lp = proj(cam, ox + 0.85, oy + 0.1, 0);
        ctx.fillStyle = T.labelDim;
        ctx.font = (9 * Math.min(cam.zoom, 1.2)) + "px 'Segoe UI', sans-serif";
        ctx.fillText(r.pending + "/" + Sim.SEGMENT_SIZE, lp[0], lp[1]);
      }
    }

    var n = Math.min(r.segments.length, 24);
    for (var i = 0; i < n; i++) {
      var col = i % 6, row = Math.floor(i / 6);
      var sx = b.x + 0.4 + col * 0.75;
      var sy = b.y + b.d + 0.5 + row * 0.7;
      var over = r.segments.length > 16;
      drawBox(ctx, cam, sx, sy, 0.55, 0.5, 0.35 + (i % 3) * 0.12,
        over ? "#ff6b6b" : "#845ef7", 0);
    }
    if (r.segments.length > 24 && cam.zoom > 0.6) {
      var mp = proj(cam, b.x + 0.4, b.y + b.d + 3.4, 0);
      ctx.fillStyle = "#ff8787";
      ctx.font = "600 " + (10 * Math.min(cam.zoom, 1.2)) + "px 'Segoe UI', sans-serif";
      ctx.fillText("+" + (r.segments.length - 24) + " more segments", mp[0], mp[1]);
    }
  }

  function towerColor(v) {
    // blue -> red as the chain grows (hex, so shade() can parse it)
    var t = Math.min(1, (v - 1) / 14);
    return "#" + hex2(77 + t * (255 - 77)) +
                 hex2(171 - t * 110) +
                 hex2(247 - t * 140);
  }

  /* Colour an individual record-version slab by its visibility status:
   * - current head version: cyan-blue (#4dabf7)
   * - active snapshot back-version (txn >= OST): amber (#fcc419)
   * - unreachable back-version below OST / OIT: crimson (#ff3d6b) */
  function slabColor(txn, isHead, s) {
    if (isHead) return "#4dabf7";
    if (s && txn < s.oit) return "#ff3d6b";
    if (s && txn < s.ost) return "#ff6b6b";
    return "#fcc419";
  }

  function drawSlab(ctx, cam, x, y, w, d, z0, z1, color, glow) {
    var a0 = proj(cam, x, y, z0), b0 = proj(cam, x + w, y, z0),
        c0 = proj(cam, x + w, y + d, z0), d0 = proj(cam, x, y + d, z0),
        a1 = proj(cam, x, y, z1), b1 = proj(cam, x + w, y, z1),
        c1 = proj(cam, x + w, y + d, z1), d1 = proj(cam, x, y + d, z1);
    poly(ctx, [b1, c1, c0, b0], shade(color, 0.55));
    poly(ctx, [d1, c1, c0, d0], shade(color, 0.78));
    poly(ctx, [a1, b1, c1, d1], shade(color, 1.18), "rgba(0,0,0,0.42)", 0.9);
    if (glow > 0) {
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 16 * glow * cam.zoom;
      ctx.globalAlpha = Math.min(1, 0.35 + glow * 0.65);
      poly(ctx, [a1, b1, c1, d1], null, color, 1.5);
      ctx.restore();
    }
  }

  function drawVersionTower(ctx, cam, d, s) {
    var t = d.table;
    if (!t || !t.chain || !t.chain.length) {
      drawBox(ctx, cam, d.x, d.y, d.w, d.d, d.h, d.color, d.glow);
      return;
    }
    // foundation plinth
    drawSlab(ctx, cam, d.x, d.y, d.w, d.d, 0, 0.46, "#2b3856", 0);
    // GC / sweep crumble pulse at the bottom when dead versions are purged
    if (t.purgeFlash > 0) {
      var pf = Math.max(0, Math.min(1, t.purgeFlash));
      var expand = (1 - pf) * 0.25;
      ctx.save();
      ctx.globalAlpha = pf * 0.75;
      diamond(ctx, cam, d.x + d.w / 2, d.y + d.d / 2, 0.75 + expand,
        null, "#ff6b6b");
      ctx.restore();
    }
    var chain = t.chain;
    var shown = Math.min(chain.length, 26);
    var startIdx = chain.length - shown;
    for (var k = 0; k < shown; k++) {
      var idx = startIdx + k;
      var isHead = idx === chain.length - 1;
      var z0 = 0.5 + k * 0.28;
      var z1 = z0 + 0.24;
      var col = slabColor(chain[idx], isHead, s);
      drawSlab(ctx, cam, d.x, d.y, d.w, d.d, z0, z1, col, isHead ? d.glow : 0);
    }
  }

  // ---------------------------------------------------------------------
  // Isometric interval / topological depth comparator:
  // Ordering by a scalar (x + w + y + d) clips road particles behind elongated
  // building facades when a particle has x >= box.xMax (in front along X)
  // yet q.x + q.y < box.xMax + box.yMax. Comparing [xMin, xMax] and [yMin, yMax]
  // intervals orders non-overlapping footprints along the separating axis first.
  function boundsOf(d) {
    if (d.xMin !== undefined) return d;
    if (d.type === "particle") {
      var q = d.q;
      d.xMin = q.x - 0.05; d.xMax = q.x + 0.05;
      d.yMin = q.y - 0.05; d.yMax = q.y + 0.05;
    } else {
      d.xMin = d.x; d.xMax = d.x + d.w;
      d.yMin = d.y; d.yMax = d.y + d.d;
    }
    return d;
  }

  function isoCompare(a, b) {
    boundsOf(a); boundsOf(b);
    var aBehindX = a.xMax <= b.xMin;
    var bBehindX = b.xMax <= a.xMin;
    var aBehindY = a.yMax <= b.yMin;
    var bBehindY = b.yMax <= a.yMin;
    if (aBehindX && !bBehindY) return -1;
    if (bBehindX && !aBehindY) return 1;
    if (aBehindY && !bBehindX) return -1;
    if (bBehindY && !aBehindX) return 1;
    var ka = (a.xMax + a.yMax) + (a.type === "particle" ? 0.2 : 0);
    var kb = (b.xMax + b.yMax) + (b.type === "particle" ? 0.2 : 0);
    return ka - kb;
  }

  function collectDrawables(s, hoverId, selectedId, time) {
    var list = [];
    FB.buildings.forEach(function (b) {
      if (b.id === "cache" || b.id === "pio" || b.id === "mvcc" ||
          b.id === "delta" || b.id === "replica") return;
      var glow = 0;
      if (b.id === hoverId || b.id === selectedId) glow = 1;
      if (b.id === "tra" && (s.pinned !== null || s.backup.gbakTxn !== null)) {
        glow = Math.max(glow, pulse(time, 5));
      }
      if (b.id === "gbak" && s.backup.gbakActive) {
        glow = Math.max(glow, pulse(time, 4));
      }
      if (b.id === "nbackup" && (s.backup.nbActive || s.backup.locked)) {
        glow = Math.max(glow, pulse(time, 4));
      }
      if (b.id === "journal" && s.repl.flash > 0) {
        glow = Math.max(glow, s.repl.flash);
      }
      if (b.id === "replicator" && s.repl.disabled) {
        glow = Math.max(glow, pulse(time, 6));
      }
      list.push(boundsOf({
        key: b.x + b.w + b.y + b.d, type: "box",
        x: b.x, y: b.y, w: b.w, d: b.d, h: b.h, color: b.color,
        glow: glow, b: b
      }));
    });
    // MVCC towers
    var m = FB.byId.mvcc;
    var cols = 4, rows = 3, i = 0;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++, i++) {
        var t = s.tables[i];
        var tx = m.x + 0.8 + c * 1.85, ty = m.y + 0.8 + r * 3.1;
        var h = 0.5 + Math.min(t.versions, 26) * 0.28;
        var tGlow = Math.max(0, t.flash);
        if ((hoverId === "mvcc" && (hoveredTower === i || hoveredTower === null)) ||
            (selectedId === "mvcc" && (selectedTower === i || selectedTower === null))) {
          tGlow = 1;
        }
        list.push(boundsOf({
          key: tx + 1.3 + ty + 1.3, type: "box",
          x: tx, y: ty, w: 1.3, d: 1.3, h: h,
          color: towerColor(t.versions),
          glow: tGlow, b: m, mvcc: true, towerIdx: i, table: t
        }));
      }
    }
    // sweep truck
    if (s.sweepActive) {
      var g = FB.stations.gc, mm = FB.stations.mvcc;
      var p = s.sweepProgress;
      var tx2, ty2;
      if (p < 0.25) { // depot -> district
        tx2 = g.x + (mm.x - g.x) * (p / 0.25);
        ty2 = g.y + (mm.y - g.y) * (p / 0.25);
      } else {        // tour the towers
        var q = (p - 0.25) / 0.8;
        tx2 = m.x + 1 + (m.w - 2) * (0.5 + 0.5 * Math.sin(q * Math.PI * 4));
        ty2 = m.y + 1 + (m.d - 2) * Math.min(1, q);
      }
      list.push(boundsOf({
        key: tx2 + ty2 + 0.8, type: "box",
        x: tx2, y: ty2, w: 0.9, d: 0.6, h: 0.55,
        color: "#e8590c", glow: 0.8, b: null
      }));
    }
    // particles
    s.particles.forEach(function (q) {
      list.push(boundsOf({ key: q.x + q.y + 0.01, type: "particle", q: q }));
    });
    list.sort(function (a, b2) { return a.key - b2.key; });
    // Topological insertion pass: ensure any drawable strictly in front of an
    // elongated box along X or Y is ordered after that box.
    for (var ti = 1; ti < list.length; ti++) {
      var cur = list[ti];
      var tj = ti - 1;
      while (tj >= 0 && isoCompare(list[tj], cur) > 0) {
        list[tj + 1] = list[tj];
        tj--;
      }
      list[tj + 1] = cur;
    }
    return list;
  }

  var PHASE_COLORS = {
    sql: "#22d3ee", blr: "#c084fc", result: "#4ade80", rollback: "#f87171"
  };

  // Redundant shape encoding for accessibility alongside phase colour:
  // - rollback: "xburst" (X-cross + central dot)
  // - update:   "diamond" (rotated square)
  // - select:   "circle" (disc)
  function particleShape(q) {
    if (q && q.phase === "rollback") return "xburst";
    if (q && q.kind === "update") return "diamond";
    return "circle";
  }

  function drawParticle(ctx, cam, q, time) {
    var color = PHASE_COLORS[q.phase] || "#22d3ee";
    var p = proj(cam, q.x, q.y, 0.35);
    var r = (q.isBatch ? 2.4 : q.kind === "update" ? 4.4 : 3.4) * cam.zoom;
    var shape = particleShape(q);
    ctx.save();
    // Motion trail (suppressed when prefers-reduced-motion / calm is active)
    if (!calm && q.trail && q.trail.length > 0) {
      ctx.strokeStyle = color;
      ctx.lineCap = "round";
      var prevPt = p;
      for (var ti = q.trail.length - 1; ti >= 0; ti--) {
        var tp = proj(cam, q.trail[ti].x, q.trail[ti].y, 0.35);
        var frac = (ti + 1) / (q.trail.length + 1);
        ctx.globalAlpha = 0.34 * frac;
        ctx.lineWidth = Math.max(1, r * 0.85 * frac);
        ctx.beginPath();
        ctx.moveTo(prevPt[0], prevPt[1]);
        ctx.lineTo(tp[0], tp[1]);
        ctx.stroke();
        prevPt = tp;
      }
      ctx.globalAlpha = 1;
    }
    ctx.shadowColor = color;
    ctx.shadowBlur = 10 * cam.zoom;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    if (shape === "diamond") {
      var d = r * 1.25;
      ctx.beginPath();
      ctx.moveTo(p[0], p[1] - d);
      ctx.lineTo(p[0] + d, p[1]);
      ctx.lineTo(p[0], p[1] + d);
      ctx.lineTo(p[0] - d, p[1]);
      ctx.closePath();
      ctx.fill();
    } else if (shape === "xburst") {
      var xb = r * 1.25;
      ctx.lineWidth = Math.max(1.6, 2.2 * cam.zoom);
      ctx.beginPath();
      ctx.moveTo(p[0] - xb, p[1] - xb);
      ctx.lineTo(p[0] + xb, p[1] + xb);
      ctx.moveTo(p[0] + xb, p[1] - xb);
      ctx.lineTo(p[0] - xb, p[1] + xb);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p[0], p[1], r * 0.55, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      ctx.fill();
      if (q.isBatch) {
        ctx.beginPath();
        ctx.arc(p[0] - r * 1.45, p[1] - r * 0.65, r * 0.72, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (q.isBlob) {
      ctx.strokeStyle = "#c084fc";
      ctx.lineWidth = Math.max(1.2, 1.8 * cam.zoom);
      ctx.beginPath();
      ctx.arc(p[0], p[1], r + 2.5 * cam.zoom, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (q.fromWriteQueue) {
      ctx.strokeStyle = "#fcc419";
      ctx.lineWidth = Math.max(1.2, 1.6 * cam.zoom);
      ctx.beginPath();
      ctx.arc(p[0], p[1], r + 2.2 * cam.zoom, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (q.waiting) {
      ctx.strokeStyle = "#ff6b6b";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p[0], p[1], r + 3 + Math.sin(time * 8) * 1.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (q.traced) {
      ctx.strokeStyle = T.labelStrong;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p[0], p[1], r + 5 + Math.sin(time * 5) * 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawLabels(ctx, cam, s, hoverId, selectedId, time) {
    if (cam.zoom < 0.7 && !hoverId && !selectedId) return;
    ctx.textAlign = "center";
    // labels follow attention: names only when zoomed in enough to read
    // them, plus whatever the cursor is on
    FB.buildings.forEach(function (b) {
      var show = cam.zoom >= 1.0 || b.id === hoverId || b.id === selectedId;
      if (!show) return;
      var p = proj(cam, b.x + b.w / 2, b.y + b.d / 2, b.h + 0.8);
      ctx.font = "600 " + (11 * Math.min(cam.zoom, 1.15)) + "px 'Segoe UI', sans-serif";
      ctx.fillStyle = (b.id === hoverId || b.id === selectedId) ?
        T.labelStrong : T.label;
      ctx.fillText(b.name, p[0], p[1]);
      ctx.font = (8.5 * Math.min(cam.zoom, 1.15)) + "px 'Segoe UI', sans-serif";
      ctx.fillStyle = T.labelDim;
      ctx.fillText(b.code, p[0], p[1] + 11 * Math.min(cam.zoom, 1.15));
    });
    // Per-tower MVCC hover/selection callout
    var activeTw = hoveredTower !== null ? hoveredTower : selectedTower;
    if (activeTw !== null && s.tables && s.tables[activeTw]) {
      var mv = FB.byId.mvcc;
      var tc = activeTw % 4, tr = Math.floor(activeTw / 4);
      var twObj = s.tables[activeTw];
      var twX = mv.x + 0.8 + tc * 1.85 + 0.65;
      var twY = mv.y + 0.8 + tr * 3.1 + 0.65;
      var twH = 0.5 + Math.min(twObj.versions, 26) * 0.28 + 0.65;
      var twP = proj(cam, twX, twY, twH);
      var deadCnt = 0;
      for (var di = 0; di < twObj.chain.length - 1; di++) {
        if (twObj.chain[di] < s.ost) deadCnt++;
      }
      ctx.font = "600 " + (10 * Math.min(cam.zoom, 1.2)) + "px Consolas, monospace";
      ctx.fillStyle = T.labelStrong;
      ctx.fillText("T" + activeTw + ": " + twObj.versions + " ver" +
        (deadCnt > 0 ? " (" + deadCnt + " GC-able)" : ""), twP[0], twP[1]);
    }
    // TIP counters over the Transaction Hall
    var t = FB.byId.tra;
    var tp = proj(cam, t.x + t.w / 2, t.y + t.d / 2, t.h + 2.2);
    if (cam.zoom >= 0.6) {
      ctx.font = "600 " + (10.5 * Math.min(cam.zoom, 1.2)) + "px Consolas, monospace";
      ctx.fillStyle = s.pinned !== null ? T.tipBad : T.tipOk;
      ctx.fillText("Next " + s.next + "  OAT " + s.oat + "  OST " + s.ost + "  OIT " + s.oit,
        tp[0], tp[1]);
      if (s.pinned !== null && (calm || Math.floor(time * 2) % 2 === 0)) {
        ctx.fillStyle = T.tipAlert;
        ctx.fillText("OIT PINNED — GC stalled", tp[0], tp[1] - 13 * cam.zoom);
      }
    }
    // lock tower beacon
    var l = FB.byId.lock;
    var lt = proj(cam, l.x + l.w / 2, l.y + l.d / 2, l.h + 0.3);
    ctx.save();
    if (!calm) {
      var ang = time * 2.2;
      ctx.strokeStyle = "rgba(255,107,107," + (0.35 + 0.3 * Math.sin(time * 4)) + ")";
      ctx.lineWidth = 2 * cam.zoom;
      ctx.beginPath();
      ctx.moveTo(lt[0], lt[1]);
      ctx.lineTo(lt[0] + Math.cos(ang) * 30 * cam.zoom,
                 lt[1] + Math.sin(ang) * 14 * cam.zoom);
      ctx.stroke();
    }
    ctx.fillStyle = "#ff6b6b";
    ctx.shadowColor = "#ff6b6b";
    ctx.shadowBlur = 12 * cam.zoom;
    ctx.beginPath();
    ctx.arc(lt[0], lt[1], 3.2 * cam.zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.textAlign = "left";
  }

  // Exact 2D ray-casting point-in-polygon check on projected isometric faces
  function pointInPoly(px, py, pts) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i][0], yi = pts[i][1];
      var xj = pts[j][0], yj = pts[j][1];
      var intersect = ((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-9) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function hitBox(cam, mx, my, x, y, w, d, h) {
    var hz = h || 0;
    var a0 = proj(cam, x, y, 0), b0 = proj(cam, x + w, y, 0),
        c0 = proj(cam, x + w, y + d, 0), d0 = proj(cam, x, y + d, 0);
    if (pointInPoly(mx, my, [a0, b0, c0, d0])) return true;
    if (hz !== 0) {
      var a1 = proj(cam, x, y, hz), b1 = proj(cam, x + w, y, hz),
          c1 = proj(cam, x + w, y + d, hz), d1 = proj(cam, x, y + d, hz);
      if (pointInPoly(mx, my, [a1, b1, c1, d1])) return true;
      if (pointInPoly(mx, my, [b1, c1, c0, b0])) return true;
      if (pointInPoly(mx, my, [d1, c1, c0, d0])) return true;
      if (hz < 0) {
        if (pointInPoly(mx, my, [a0, b0, b1, a1])) return true;
        if (pointInPoly(mx, my, [a0, d0, d1, a1])) return true;
      }
    }
    return false;
  }

  function pickTower(cam, mx, my, s) {
    var sim = s || lastSim;
    var m = FB.byId.mvcc;
    if (!m) return -1;
    var bestIdx = -1, bestKey = -1;
    var cols = 4, rows = 3, i = 0;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++, i++) {
        var ver = (sim && sim.tables && sim.tables[i]) ? sim.tables[i].versions : 1;
        var tx = m.x + 0.8 + c * 1.85, ty = m.y + 0.8 + r * 3.1;
        var h = 0.5 + Math.min(ver, 26) * 0.28;
        if (hitBox(cam, mx, my, tx, ty, 1.3, 1.3, h)) {
          var key = tx + ty + 2.6;
          if (key > bestKey) { bestKey = key; bestIdx = i; }
        }
      }
    }
    return bestIdx;
  }

  // picking: exact isometric polygon hit-testing in reverse painter order
  function pick(cam, mx, my, s) {
    var tw = pickTower(cam, mx, my, s);
    hoveredTower = tw >= 0 ? tw : null;
    if (tw >= 0) return "mvcc";

    var best = null, bestKey = -1;
    FB.buildings.forEach(function (b) {
      var h = b.h || 0;
      if (b.id === "pio") h = -1.2;
      else if (b.id === "delta" || b.id === "replica") h = -0.95;
      if (hitBox(cam, mx, my, b.x, b.y, b.w, b.d, h)) {
        var key = b.x + b.y + b.w + b.d;
        if (key > bestKey) { bestKey = key; best = b.id; }
      }
    });
    return best;
  }

  function drawSubsystems(ctx, cam, s, time) {
    // 1. B-Tree Gardens (btr): root -> internal -> leaf fanout tree on roof
    var btr = FB.byId.btr;
    if (btr) {
      var bz = btr.h + 0.06;
      var root = proj(cam, btr.x + btr.w * 0.5, btr.y + btr.d * 0.22, bz);
      var mid = [
        proj(cam, btr.x + btr.w * 0.3, btr.y + btr.d * 0.52, bz),
        proj(cam, btr.x + btr.w * 0.7, btr.y + btr.d * 0.52, bz)
      ];
      var leaves = [
        proj(cam, btr.x + btr.w * 0.16, btr.y + btr.d * 0.82, bz),
        proj(cam, btr.x + btr.w * 0.39, btr.y + btr.d * 0.82, bz),
        proj(cam, btr.x + btr.w * 0.61, btr.y + btr.d * 0.82, bz),
        proj(cam, btr.x + btr.w * 0.84, btr.y + btr.d * 0.82, bz)
      ];
      var activeLeaf = (s.btrLeaf || 0) % 4;
      var activeMid = activeLeaf < 2 ? 0 : 1;
      var bf = Math.max(0, s.btrFlash || 0);
      ctx.save();
      ctx.lineWidth = Math.max(1, 1.4 * cam.zoom);
      for (var mi = 0; mi < 2; mi++) {
        ctx.strokeStyle = (bf > 0 && mi === activeMid)
          ? "rgba(99,230,190," + (0.45 + bf * 0.55) + ")"
          : "rgba(99,230,190,0.28)";
        ctx.beginPath();
        ctx.moveTo(root[0], root[1]);
        ctx.lineTo(mid[mi][0], mid[mi][1]);
        ctx.stroke();
      }
      for (var li = 0; li < 4; li++) {
        var parentMid = li < 2 ? mid[0] : mid[1];
        ctx.strokeStyle = (bf > 0 && li === activeLeaf)
          ? "rgba(99,230,190," + (0.45 + bf * 0.55) + ")"
          : "rgba(99,230,190,0.25)";
        ctx.beginPath();
        ctx.moveTo(parentMid[0], parentMid[1]);
        ctx.lineTo(leaves[li][0], leaves[li][1]);
        ctx.stroke();
      }
      var allNodes = [root, mid[0], mid[1], leaves[0], leaves[1], leaves[2], leaves[3]];
      for (var ni = 0; ni < allNodes.length; ni++) {
        var isHitNode = bf > 0 &&
          (ni === 0 || ni === 1 + activeMid || ni === 3 + activeLeaf);
        ctx.fillStyle = isHitNode ? "#e6fcf5" : "#63e6be";
        ctx.beginPath();
        ctx.arc(allNodes[ni][0], allNodes[ni][1],
          (isHitNode ? 2.8 : 2.0) * cam.zoom, 0, Math.PI * 2);
        ctx.fill();
      }
      if (s.btrSplitFlash > 0) {
        var spLeaf = leaves[activeLeaf];
        ctx.strokeStyle = "rgba(255,212,59," + Math.min(1, s.btrSplitFlash) + ")";
        ctx.lineWidth = 1.8 * cam.zoom;
        ctx.beginPath();
        ctx.arc(spLeaf[0], spLeaf[1], (5 + (1 - s.btrSplitFlash) * 6) * cam.zoom, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 2. Sort Yard (sort): merge-sort run stacks + temporary spill chute to PIO
    var srt = FB.byId.sort;
    if (srt) {
      var runs = Math.max(1, Math.min(6, Math.ceil(s.sortRuns || 1)));
      for (var ri = 0; ri < runs; ri++) {
        var rx = srt.x + 0.55 + ri * 0.65;
        var ry = srt.y + 1.2;
        var rh = 0.18 + ((ri % 3) + 1) * 0.12;
        drawSlab(ctx, cam, rx, ry, 0.48, 0.48, srt.h, srt.h + rh,
          s.sortSpillFlash > 0.2 ? "#ffa94d" : "#a9e34b", 0);
      }
      if (s.sortSpillFlash > 0) {
        var pio = FB.byId.pio;
        var pSort = proj(cam, srt.x + srt.w / 2, srt.y + srt.d, srt.h);
        var pPio = proj(cam, pio.x + pio.w * 0.75, pio.y + pio.d * 0.5, -1.0);
        ctx.save();
        ctx.strokeStyle = "rgba(255,146,43," + Math.min(1, s.sortSpillFlash * 0.9) + ")";
        ctx.lineWidth = Math.max(1.5, 2.5 * cam.zoom);
        ctx.setLineDash([5 * cam.zoom, 4 * cam.zoom]);
        ctx.beginPath();
        ctx.moveTo(pSort[0], pSort[1]);
        ctx.lineTo(pPio[0], pPio[1]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }

    // 3. Lock Manager Tower (lock): queued writer holding bays + deadlock ring
    var lck = FB.byId.lock;
    if (lck && s.tables) {
      var totalWaiters = 0;
      for (var ti = 0; ti < s.tables.length; ti++) {
        totalWaiters += s.tables[ti].waiters ? s.tables[ti].waiters.length : 0;
      }
      var bayCount = Math.min(8, totalWaiters);
      if (bayCount > 0) {
        ctx.save();
        for (var bi = 0; bi < bayCount; bi++) {
          var ang = (bi / 8) * Math.PI * 2 + (calm ? 0 : time * 1.2);
          var wx = lck.x + lck.w / 2 + Math.cos(ang) * (lck.w * 0.58);
          var wy = lck.y + lck.d / 2 + Math.sin(ang) * (lck.d * 0.58);
          var bp = proj(cam, wx, wy, 0.25);
          ctx.fillStyle = "#ff8787";
          ctx.beginPath();
          ctx.arc(bp[0], bp[1], 3.0 * cam.zoom, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      if (s.deadlockFlash > 0) {
        var lp = proj(cam, lck.x + lck.w / 2, lck.y + lck.d / 2, lck.h * 0.6);
        ctx.save();
        ctx.strokeStyle = "rgba(255,61,107," + Math.min(1, s.deadlockFlash) + ")";
        ctx.lineWidth = 2.2 * cam.zoom;
        ctx.beginPath();
        ctx.arc(lp[0], lp[1], (12 + (1 - s.deadlockFlash) * 14) * cam.zoom, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 4. Client Harbor (harbor): FB_WRITE_QUEUE$ local-first staging rack
    var hrb = FB.byId.harbor;
    if (hrb && (s.writeQueueMode || (s.writeQueue && s.writeQueue.length > 0) || s.writeQueueFlash > 0)) {
      var qCount = Math.min(8, s.writeQueue ? s.writeQueue.length : 0);
      var showSlots = Math.max(qCount, s.writeQueueMode ? 4 : 0);
      for (var qi = 0; qi < showSlots; qi++) {
        var qx = hrb.x + 0.55 + (qi % 2) * 1.45;
        var qy = hrb.y + 0.8 + Math.floor(qi / 2) * 1.65;
        var filled = qi < qCount;
        drawSlab(ctx, cam, qx, qy, 0.9, 0.9, hrb.h, hrb.h + (filled ? 0.28 : 0.10),
          filled ? "#fcc419" : "#3b5bdb", s.writeQueueFlash > 0 && filled ? 0.6 : 0);
      }
    }
  }

  function draw(ctx, cam, s, cw, ch, hoverId, selectedId, time) {
    lastSim = s;
    drawGround(ctx, cam, cw, ch, s);
    drawStorage(ctx, cam, s);
    drawDelta(ctx, cam, s);
    drawReplica(ctx, cam, s);
    drawCachePlaza(ctx, cam, s);
    drawJournal(ctx, cam, s);
    var list = collectDrawables(s, hoverId, selectedId, time);
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (d.type === "box") {
        if (d.mvcc && d.table) {
          drawVersionTower(ctx, cam, d, s);
        } else {
          drawBox(ctx, cam, d.x, d.y, d.w, d.d, d.h, d.color, d.glow);
        }
      } else {
        drawParticle(ctx, cam, d.q, time);
      }
    }
    drawSubsystems(ctx, cam, s, time);
    drawLabels(ctx, cam, s, hoverId, selectedId, time);
  }

  return {
    draw: draw, pick: pick, pickTower: pickTower,
    pointInPoly: pointInPoly, hitBox: hitBox,
    slabColor: slabColor,
    particleShape: particleShape, isoCompare: isoCompare,
    getHoveredTower: function () { return hoveredTower; },
    setSelectedTower: function (idx) { selectedTower = idx; },
    proj: proj,
    setTheme: setTheme,
    isCalm: function () { return calm; },
    TW: TW, TH: TH, TZ: TZ
  };
})();
