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
      tipOk: "#ffe066", tipBad: "#ff8787", tipAlert: "#ff6b6b"
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
      tipOk: "#8a5a00", tipBad: "#b02525", tipAlert: "#c92a2a"
    }
  };
  var T = THEMES.dark;
  var themeName = "dark";

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

  function drawGround(ctx, cam, cw, ch) {
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
      diamond(ctx, cam, cx, cy, 0.24, fill, null);
      if (slot.flash > 0) {
        var col = slot.state === 2 ? "255,107,107" :
                  slot.state === 3 ? "252,196,25" : "64,192,87";
        ctx.save();
        ctx.globalAlpha = Math.max(0, slot.flash);
        diamond(ctx, cam, cx, cy, 0.3, "rgba(" + col + ",0.9)", null);
        ctx.restore();
      }
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
    if (cam.zoom > 0.55) {
      ctx.fillStyle = T.pitLabel;
      ctx.font = (10 * Math.min(cam.zoom, 1.3)) + "px 'Segoe UI', sans-serif";
      var lp = proj(cam, b.x + 0.5, b.y + b.d - 0.4, -depth);
      ctx.fillText("careful writes — no WAL needed", lp[0], lp[1]);
    }
  }

  function hex2(n) {
    var h = Math.max(0, Math.min(255, Math.round(n))).toString(16);
    return h.length < 2 ? "0" + h : h;
  }

  function towerColor(v) {
    // blue -> red as the chain grows (hex, so shade() can parse it)
    var t = Math.min(1, (v - 1) / 14);
    return "#" + hex2(77 + t * (255 - 77)) +
                 hex2(171 - t * 110) +
                 hex2(247 - t * 140);
  }

  // ---------------------------------------------------------------------

  function collectDrawables(s, hoverId, selectedId, time) {
    var list = [];
    FB.buildings.forEach(function (b) {
      if (b.id === "cache" || b.id === "pio" || b.id === "mvcc") return;
      var glow = 0;
      if (b.id === hoverId || b.id === selectedId) glow = 1;
      if (b.id === "tra" && s.pinned !== null) glow = Math.max(glow, 0.5 + 0.5 * Math.sin(time * 5));
      list.push({
        key: b.x + b.w + b.y + b.d, type: "box",
        x: b.x, y: b.y, w: b.w, d: b.d, h: b.h, color: b.color,
        glow: glow, b: b
      });
    });
    // MVCC towers
    var m = FB.byId.mvcc;
    var cols = 4, rows = 3, i = 0;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++, i++) {
        var t = s.tables[i];
        var tx = m.x + 0.8 + c * 1.85, ty = m.y + 0.8 + r * 3.1;
        var h = 0.5 + Math.min(t.versions, 26) * 0.28;
        list.push({
          key: tx + 1.3 + ty + 1.3, type: "box",
          x: tx, y: ty, w: 1.3, d: 1.3, h: h,
          color: towerColor(t.versions),
          glow: Math.max(0, t.flash), b: (i === 0 ? m : null), mvcc: true
        });
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
      list.push({
        key: tx2 + ty2 + 0.8, type: "box",
        x: tx2, y: ty2, w: 0.9, d: 0.6, h: 0.55,
        color: "#e8590c", glow: 0.8, b: null
      });
    }
    // particles
    s.particles.forEach(function (q) {
      list.push({ key: q.x + q.y + 0.01, type: "particle", q: q });
    });
    list.sort(function (a, b2) { return a.key - b2.key; });
    return list;
  }

  var PHASE_COLORS = {
    sql: "#22d3ee", blr: "#c084fc", result: "#4ade80", rollback: "#f87171"
  };

  function drawParticle(ctx, cam, q, time) {
    var color = PHASE_COLORS[q.phase] || "#22d3ee";
    var p = proj(cam, q.x, q.y, 0.35);
    var r = (q.kind === "update" ? 4.4 : 3.4) * cam.zoom;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 10 * cam.zoom;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
    ctx.fill();
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
    // TIP counters over the Transaction Hall
    var t = FB.byId.tra;
    var tp = proj(cam, t.x + t.w / 2, t.y + t.d / 2, t.h + 2.2);
    if (cam.zoom >= 0.6) {
      ctx.font = "600 " + (10.5 * Math.min(cam.zoom, 1.2)) + "px Consolas, monospace";
      ctx.fillStyle = s.pinned !== null ? T.tipBad : T.tipOk;
      ctx.fillText("Next " + s.next + "  OAT " + s.oat + "  OIT " + s.oit,
        tp[0], tp[1]);
      if (s.pinned !== null && Math.floor(time * 2) % 2 === 0) {
        ctx.fillStyle = T.tipAlert;
        ctx.fillText("OIT PINNED — GC stalled", tp[0], tp[1] - 13 * cam.zoom);
      }
    }
    // lock tower beacon
    var l = FB.byId.lock;
    var lt = proj(cam, l.x + l.w / 2, l.y + l.d / 2, l.h + 0.3);
    ctx.save();
    var ang = time * 2.2;
    ctx.strokeStyle = "rgba(255,107,107," + (0.35 + 0.3 * Math.sin(time * 4)) + ")";
    ctx.lineWidth = 2 * cam.zoom;
    ctx.beginPath();
    ctx.moveTo(lt[0], lt[1]);
    ctx.lineTo(lt[0] + Math.cos(ang) * 30 * cam.zoom,
               lt[1] + Math.sin(ang) * 14 * cam.zoom);
    ctx.stroke();
    ctx.fillStyle = "#ff6b6b";
    ctx.shadowColor = "#ff6b6b";
    ctx.shadowBlur = 12 * cam.zoom;
    ctx.beginPath();
    ctx.arc(lt[0], lt[1], 3.2 * cam.zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.textAlign = "left";
  }

  // picking: screen-space bbox of each building's projected corners
  function pick(cam, mx, my) {
    var best = null, bestKey = -1;
    FB.buildings.forEach(function (b) {
      var pts = [
        proj(cam, b.x, b.y, 0), proj(cam, b.x + b.w, b.y, 0),
        proj(cam, b.x + b.w, b.y + b.d, 0), proj(cam, b.x, b.y + b.d, 0),
        proj(cam, b.x, b.y, b.h || 1), proj(cam, b.x + b.w, b.y, b.h || 1),
        proj(cam, b.x + b.w, b.y + b.d, b.h || 1), proj(cam, b.x, b.y + b.d, b.h || 1)
      ];
      var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      pts.forEach(function (p) {
        x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
        y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
      });
      if (mx >= x0 && mx <= x1 && my >= y0 && my <= y1) {
        var key = b.x + b.y + b.w + b.d;
        if (key > bestKey) { bestKey = key; best = b.id; }
      }
    });
    return best;
  }

  function draw(ctx, cam, s, cw, ch, hoverId, selectedId, time) {
    drawGround(ctx, cam, cw, ch);
    drawStorage(ctx, cam, s);
    drawCachePlaza(ctx, cam, s);
    var list = collectDrawables(s, hoverId, selectedId, time);
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (d.type === "box") {
        drawBox(ctx, cam, d.x, d.y, d.w, d.d, d.h, d.color, d.glow);
      } else {
        drawParticle(ctx, cam, d.q, time);
      }
    }
    drawLabels(ctx, cam, s, hoverId, selectedId, time);
  }

  return {
    draw: draw, pick: pick, proj: proj,
    setTheme: setTheme,
    TW: TW, TH: TH, TZ: TZ
  };
})();
