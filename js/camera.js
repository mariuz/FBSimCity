/* FBSimCity — camera arithmetic.
 *
 * Split out of main.js so it can be tested without a canvas, a touchscreen
 * or a phone. Everything here is pure apart from mutating the camera object
 * it is handed: no DOM, no rendering, no globals.
 */
var Camera = (function () {
  "use strict";

  /* Zoom about a fixed screen point, so whatever is under that point stays
   * under it. Every zoom path goes through here — wheel, pinch and keyboard —
   * because a zoom that drifts is the fastest way to lose the city. */
  function zoomAt(cam, mx, my, factor, min, max) {
    var nz = Math.max(min, Math.min(max, cam.zoom * factor));
    var f = nz / cam.zoom;
    cam.ox = mx - (mx - cam.ox) * f;
    cam.oy = my - (my - cam.oy) * f;
    cam.zoom = nz;
    cam.target = null;
    return cam;
  }

  /* Reduce every active contact to one gesture: how many fingers, where their
   * centroid is, and how far they sit from it on average.
   *
   * Taking all contacts together is the whole point. PGSimCity found the
   * alternative on a real phone: pointer events arrive per contact, so a
   * handler that updates whichever finger the current event mentions ends up
   * pairing one finger's new position with the other's stale one, and reads a
   * pinch out of a gesture that never pinched. A TouchEvent always carries
   * the full list, so deriving everything from the list — and from nothing
   * remembered per finger — makes the result independent of delivery order.
   */
  function gestureOf(list) {
    var n = list ? list.length : 0;
    if (!n) return null;
    var cx = 0, cy = 0, i;
    for (i = 0; i < n; i++) { cx += list[i].clientX; cy += list[i].clientY; }
    cx /= n; cy /= n;
    var spread = 0;
    for (i = 0; i < n; i++) {
      spread += Math.hypot(list[i].clientX - cx, list[i].clientY - cy);
    }
    return { n: n, cx: cx, cy: cy, spread: spread / n };
  }

  /* Pan by the centroid's movement and scale by the change in spread,
   * anchored on the centroid.
   *
   * Returns false when the number of contacts changed, meaning the caller
   * should re-baseline and commit nothing: a third finger landing, or one
   * lifting, must not be read as a sudden pinch.
   */
  function applyGesture(cam, prev, cur, rect, min, max) {
    if (!prev || !cur || prev.n !== cur.n) return false;
    cam.ox += cur.cx - prev.cx;
    cam.oy += cur.cy - prev.cy;
    cam.target = null;
    // Below about half a pixel of spread the ratio is noise, not a pinch.
    if (cur.n >= 2 && prev.spread > 0.5) {
      zoomAt(cam, cur.cx - rect.left, cur.cy - rect.top,
        cur.spread / prev.spread, min, max);
    }
    return true;
  }

  return { zoomAt: zoomAt, gestureOf: gestureOf, applyGesture: applyGesture };
})();
