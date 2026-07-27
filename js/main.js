/* FBSimCity — bootstrap, camera, input, main loop. */
(function () {
  "use strict";

  var canvas = document.getElementById("city");
  var ctx = canvas.getContext("2d");
  var sim = Sim.create();

  var cam = { ox: 0, oy: 0, zoom: 1, target: null };
  var hoverId = null, selectedId = null;
  var dragging = false, dragMoved = false;
  var lastX = 0, lastY = 0;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
  }

  function fitCamera() {
    var b = FB.bounds;
    // project world corners at zoom 1, offset 0
    var pts = [
      [(b.x0 - b.y0) * Render.TW, (b.x0 + b.y0) * Render.TH],
      [(b.x1 - b.y0) * Render.TW, (b.x1 + b.y0) * Render.TH],
      [(b.x1 - b.y1) * Render.TW, (b.x1 + b.y1) * Render.TH],
      [(b.x0 - b.y1) * Render.TW, (b.x0 + b.y1) * Render.TH]
    ];
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    pts.forEach(function (p) {
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
    });
    var cw = canvas.clientWidth, ch = canvas.clientHeight;
    var pad = 60;
    var z = Math.min((cw - pad) / (x1 - x0), (ch - pad) / (y1 - y0));
    cam.zoom = Math.max(0.3, Math.min(z, 1.6));
    cam.ox = cw / 2 - (x0 + x1) / 2 * cam.zoom;
    cam.oy = ch / 2 - (y0 + y1) / 2 * cam.zoom - 20;
  }

  // The city can never be lost: invert the projection for the screen
  // center and clamp that world point into the (slightly padded) world
  // rectangle. The ground occupies exactly the world rect, so whatever
  // pan or zoom did, there is always city under the screen center.
  function clampCamera() {
    var b = FB.bounds, z = cam.zoom;
    var cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2;
    var A = (cx - cam.ox) / (Render.TW * z); // = wx - wy
    var B = (cy - cam.oy) / (Render.TH * z); // = wx + wy
    var wx = (A + B) / 2, wy = (B - A) / 2;
    var px = (b.x1 - b.x0) * 0.1, py = (b.y1 - b.y0) * 0.1;
    var kx = Math.min(Math.max(wx, b.x0 + px), b.x1 - px);
    var ky = Math.min(Math.max(wy, b.y0 + py), b.y1 - py);
    if (kx !== wx || ky !== wy) {
      cam.ox = cx - (kx - ky) * Render.TW * z;
      cam.oy = cy - (kx + ky) * Render.TH * z;
    }
  }

  function focusOn(id, zoom) {
    var b = FB.byId[id];
    if (!b) return;
    var wx = b.x + b.w / 2, wy = b.y + b.d / 2, wz = (b.h || 0) / 2;
    var z = zoom || 1.3;
    cam.target = {
      zoom: z,
      ox: canvas.clientWidth / 2 - (wx - wy) * Render.TW * z,
      oy: canvas.clientHeight / 2 -
        ((wx + wy) * Render.TH - wz * Render.TZ) * z
    };
  }

  // ---- input -----------------------------------------------------------

  canvas.addEventListener("mousedown", function (e) {
    dragging = true; dragMoved = false;
    lastX = e.clientX; lastY = e.clientY;
  });
  window.addEventListener("mouseup", function () { dragging = false; });
  window.addEventListener("mousemove", function (e) {
    if (dragging) {
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
      cam.ox += dx; cam.oy += dy;
      cam.target = null;
      lastX = e.clientX; lastY = e.clientY;
    } else {
      var r = canvas.getBoundingClientRect();
      hoverId = Render.pick(cam, e.clientX - r.left, e.clientY - r.top);
      canvas.style.cursor = hoverId ? "pointer" : "grab";
    }
  });
  canvas.addEventListener("click", function (e) {
    if (dragMoved) return;
    var r = canvas.getBoundingClientRect();
    var id = Render.pick(cam, e.clientX - r.left, e.clientY - r.top);
    if (id) {
      selectedId = id;
      UI.showBuilding(id);
    } else {
      selectedId = null;
    }
  });
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    var r = canvas.getBoundingClientRect();
    var mx = e.clientX - r.left, my = e.clientY - r.top;
    var f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    var nz = Math.max(0.3, Math.min(2.4, cam.zoom * f));
    f = nz / cam.zoom;
    cam.ox = mx - (mx - cam.ox) * f;
    cam.oy = my - (my - cam.oy) * f;
    cam.zoom = nz;
    cam.target = null;
  }, { passive: false });

  // touch: one-finger pan, two-finger pinch zoom
  var touches = {};
  canvas.addEventListener("touchstart", function (e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      touches[t.identifier] = { x: t.clientX, y: t.clientY };
    }
  }, { passive: true });
  canvas.addEventListener("touchmove", function (e) {
    e.preventDefault();
    var ids = Object.keys(touches);
    if (e.touches.length === 1 && ids.length >= 1) {
      var t = e.touches[0], p = touches[t.identifier];
      if (p) {
        cam.ox += t.clientX - p.x; cam.oy += t.clientY - p.y;
        p.x = t.clientX; p.y = t.clientY;
        cam.target = null;
      }
    } else if (e.touches.length === 2) {
      var a = e.touches[0], b = e.touches[1];
      var pa = touches[a.identifier], pb = touches[b.identifier];
      if (pa && pb) {
        var d0 = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        var d1 = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (d0 > 0) {
          cam.zoom = Math.max(0.3, Math.min(2.4, cam.zoom * (d1 / d0)));
        }
        pa.x = a.clientX; pa.y = a.clientY;
        pb.x = b.clientX; pb.y = b.clientY;
      }
    }
  }, { passive: false });
  canvas.addEventListener("touchend", function (e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      delete touches[e.changedTouches[i].identifier];
    }
  }, { passive: true });

  window.addEventListener("keydown", function (e) {
    var tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" ||
        tag === "BUTTON") return;
    var step = 40;
    if (e.key === "ArrowLeft") cam.ox += step;
    else if (e.key === "ArrowRight") cam.ox -= step;
    else if (e.key === "ArrowUp") cam.oy += step;
    else if (e.key === "ArrowDown") cam.oy -= step;
    else if (e.key === "+" || e.key === "=") cam.zoom = Math.min(2.4, cam.zoom * 1.1);
    else if (e.key === "-") cam.zoom = Math.max(0.3, cam.zoom / 1.1);
    else {
      if (UI.handleKey(e.key)) e.preventDefault();
      return;
    }
    cam.target = null;
  });

  window.addEventListener("resize", function () { resize(); });

  // ---- loop ------------------------------------------------------------

  var last = performance.now();
  var statTick = 0;

  var fitted = false;

  function frame(now) {
    var dt = (now - last) / 1000;
    last = now;

    // self-heal if the canvas was laid out after load (or resized)
    var wantW = Math.floor(canvas.clientWidth * dpr);
    if (canvas.width !== wantW && canvas.clientWidth > 0) {
      resize();
      if (!fitted) { fitCamera(); fitted = true; }
    } else if (!fitted && canvas.clientWidth > 0) {
      fitted = true;
    }

    if (!sim.paused) Sim.tick(sim, dt * sim.speed);

    // camera follows a traced query
    if (sim.tracedQ && !dragging) {
      var tq = sim.tracedQ, tz = 1.5;
      cam.target = {
        zoom: tz,
        ox: canvas.clientWidth / 2 - (tq.x - tq.y) * Render.TW * tz,
        oy: canvas.clientHeight / 2 -
          ((tq.x + tq.y) * Render.TH - 0.35 * Render.TZ) * tz
      };
    }

    if (cam.target) {
      var t = cam.target, k = Math.min(1, dt * 5);
      cam.ox += (t.ox - cam.ox) * k;
      cam.oy += (t.oy - cam.oy) * k;
      cam.zoom += (t.zoom - cam.zoom) * k;
      if (Math.abs(t.ox - cam.ox) < 1 && Math.abs(t.zoom - cam.zoom) < 0.01) {
        cam.target = null;
      }
    }
    if (!cam.target) clampCamera();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    Render.draw(ctx, cam, sim, canvas.clientWidth, canvas.clientHeight,
      hoverId, selectedId, now / 1000);

    statTick += dt;
    if (statTick > 0.25) {
      UI.updateStats(sim);
      statTick = 0;
    }
    requestAnimationFrame(frame);
  }

  UI.init(sim, focusOn);
  resize();
  fitCamera();

  // deep link: ?warp=45 fast-forwards the simulation 45 seconds at load
  try {
    var warp = parseInt(new URLSearchParams(location.search).get("warp"), 10);
    if (warp > 0) {
      warp = Math.min(warp, 300);
      for (var wi = 0; wi < warp * 60; wi++) {
        Sim.tick(sim, 1 / 60);
        if (wi % 60 === 59) UI.updateStats(sim); // feed the sparklines
      }
    }
  } catch (e) { }

  requestAnimationFrame(frame);

  // debug/test hook (not part of the public surface)
  window.FBDebug = { cam: cam, clampCamera: clampCamera, fitCamera: fitCamera };
})();
