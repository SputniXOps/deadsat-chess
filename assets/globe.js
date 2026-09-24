/*!
 * DeadSat Atlas — globe renderer.
 * Plain ES2018, Canvas 2D, no build step. Positions come from SGP4 (assets/orbit.js
 * on top of satellite.js) in real time; this file only draws.
 *
 * Orthographic globe with land clipped against the limb, drag to rotate, wheel /
 * pinch to zoom, picking, the selected object's inertial orbit ring and its
 * sub-satellite track, and the observer's position.
 *
 * The RADIAL SCALE IS COMPRESSED: geostationary altitude would put the ring six
 * Earth radii out. Ordering (LEO inside MEO inside GEO) is preserved, absolute
 * radii are not, and the legend says so.
 */
(function (global) {
  'use strict';

  var DEG = Math.PI / 180;
  var TWO_PI = Math.PI * 2;
  var RE = 6378.137;
  var O = global.DeadSatOrbit;

  function createGlobe(canvas, opts) {
    var o = opts || {};
    var ctx = canvas.getContext('2d');
    var land = o.land || { rings: [] };
    var objects = o.objects || [];          // { id, name, orbit, satrec, field }
    var observer = o.observer || null;      // { id, lat, lon }

    var view = { lon: o.lon === undefined ? 10 : o.lon, lat: o.lat === undefined ? 30 : o.lat,
                 spin: o.spin !== false, spinRate: 1.2, zoom: 1 };
    var ZMIN = 0.75, ZMAX = 5;

    var css = getComputedStyle(document.documentElement);
    function tok(name, fb) { var v = css.getPropertyValue(name); return (v && v.trim()) || fb; }
    var colors = {
      space: tok('--ds-surface-inset', '#000'), ocean: tok('--ds-surface-200', '#0a0a0a'), land: tok('--ds-surface-400', '#181818'),
      coast: tok('--ds-line-300', '#464646'), grat: tok('--ds-grid-plot', '#121212'), limb: tok('--ds-line-200', '#222'),
      ink: tok('--ds-ink-100', '#e8e8e8'), muted: tok('--ds-ink-300', '#6b6b6b'), beacon: tok('--ds-accent-beacon', '#d6a24e'),
      orbit: { LEO: tok('--ds-orbit-leo', '#6fb3c6'), MEO: tok('--ds-orbit-meo', '#8d94d6'), GEO: tok('--ds-orbit-geo', '#cfa255'),
        GSO: tok('--ds-orbit-geo', '#cfa255'), HEO: tok('--ds-orbit-heo', '#b48ac2'), GRAVEYARD: tok('--ds-orbit-graveyard', '#8a949c'),
        DECAYING: tok('--ds-orbit-decaying', '#cf7a58') }
    };

    var W = 0, H = 0, cx = 0, cy = 0, R = 0, dpr = 1;
    var visibleList = objects.slice();
    var selected = null, hovered = null;
    var marks = [];
    var now = new Date();
    var positions = {};          // id -> { x,y,z, lat,lon,alt } (Earth-fixed), refreshed every second
    var ring = null, track = null, ringAt = 0;

    /** Compressed radial mapping: altitude (km) -> multiples of the Earth radius. */
    function radial(alt) {
      var a = Math.max(0, alt) / 35786;
      return 1 + 0.5 * Math.pow(Math.min(a, 1.7), 0.55);
    }
    var FRAME = radial(35786) * 1.03;

    function resize() {
      var rect = canvas.getBoundingClientRect();
      dpr = Math.min(global.devicePixelRatio || 1, 2);
      W = Math.max(1, Math.round(rect.width)); H = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = W / 2; cy = H / 2;
      R = (Math.min(W, H) * 0.47 * view.zoom) / FRAME;
      draw();
    }

    var bx = [0, 0, 0], by = [0, 0, 0], bz = [0, 0, 0];
    function setBasis() {
      var la = view.lat * DEG, lo = view.lon * DEG;
      var cl = Math.cos(la), sl = Math.sin(la), co = Math.cos(lo), so = Math.sin(lo);
      bz = [cl * co, cl * so, sl]; bx = [-so, co, 0]; by = [-sl * co, -sl * so, cl];
    }
    function project(v, radiusPx) {
      var sx = v[0] * bx[0] + v[1] * bx[1] + v[2] * bx[2];
      var sy = v[0] * by[0] + v[1] * by[1] + v[2] * by[2];
      var sz = v[0] * bz[0] + v[1] * bz[1] + v[2] * bz[2];
      return [cx + radiusPx * sx, cy - radiusPx * sy, sz];
    }
    function unit(lon, lat) { var la = lat * DEG, lo = lon * DEG, cl = Math.cos(la); return [cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la)]; }
    function projectState(s) {
      var mag = s.r || Math.hypot(s.x, s.y, s.z) || 1;
      var rr = R * radial(mag - RE);
      var p = project([s.x / mag, s.y / mag, s.z / mag], rr);
      p[3] = p[2] < 0 && Math.hypot(p[0] - cx, p[1] - cy) < R;   // occluded by the planet
      return p;
    }

    /* ------------------------------------------------------ land clipping */
    function limbAngle(p) { return Math.atan2(p[1] - cy, p[0] - cx); }
    function clipRing(pts, radiusPx) {
      var n = pts.length, proj = new Array(n), vis = new Array(n), nVis = 0, i;
      for (i = 0; i < n; i++) { var p = project(pts[i], radiusPx); proj[i] = p; vis[i] = p[2] >= 0; if (vis[i]) nVis++; }
      if (nVis === 0) return null;
      if (nVis === n) return { whole: proj };
      function crossing(a, b) {
        var va = pts[a], vb = pts[b], za = proj[a][2], zb = proj[b][2], t = za / (za - zb);
        var v = [va[0] + (vb[0] - va[0]) * t, va[1] + (vb[1] - va[1]) * t, va[2] + (vb[2] - va[2]) * t];
        var len = Math.hypot(v[0], v[1], v[2]) || 1;
        return project([v[0] / len, v[1] / len, v[2] / len], radiusPx);
      }
      var segs = [], cur = null;
      for (var k = 0; k < n; k++) {
        var a = k, b = (k + 1) % n;
        if (vis[a] && vis[b]) { if (!cur) cur = [proj[a]]; cur.push(proj[b]); }
        else if (vis[a] && !vis[b]) { if (!cur) cur = [proj[a]]; cur.push(crossing(a, b)); segs.push(cur); cur = null; }
        else if (!vis[a] && vis[b]) { cur = [crossing(a, b), proj[b]]; }
      }
      if (cur) { if (segs.length && !vis[0]) segs.push(cur); else if (segs.length) segs[0] = cur.concat(segs[0].slice(1)); else segs.push(cur); }
      return segs.length ? { segs: segs } : null;
    }
    function limbArc(from, to, radiusPx) {
      var a0 = limbAngle(from), a1 = limbAngle(to), d = a1 - a0;
      while (d > Math.PI) d -= TWO_PI; while (d <= -Math.PI) d += TWO_PI;
      ctx.arc(cx, cy, radiusPx, a0, a0 + d, d < 0);
    }
    function fillClipped(clip, radiusPx) {
      ctx.beginPath();
      if (clip.whole) { var w = clip.whole; ctx.moveTo(w[0][0], w[0][1]); for (var i = 1; i < w.length; i++) ctx.lineTo(w[i][0], w[i][1]); ctx.closePath(); return; }
      var segs = clip.segs;
      for (var j = 0; j < segs.length; j++) {
        var seg = segs[j];
        if (j === 0) ctx.moveTo(seg[0][0], seg[0][1]); else limbArc(segs[j - 1][segs[j - 1].length - 1], seg[0], radiusPx);
        for (var m = 1; m < seg.length; m++) ctx.lineTo(seg[m][0], seg[m][1]);
      }
      var last = segs[segs.length - 1];
      limbArc(last[last.length - 1], segs[0][0], radiusPx);
      ctx.closePath();
    }
    function strokeClipped(clip) {
      ctx.beginPath();
      if (clip.whole) { var w = clip.whole; ctx.moveTo(w[0][0], w[0][1]); for (var i = 1; i < w.length; i++) ctx.lineTo(w[i][0], w[i][1]); ctx.closePath(); }
      else for (var j = 0; j < clip.segs.length; j++) { var seg = clip.segs[j]; ctx.moveTo(seg[0][0], seg[0][1]); for (var m = 1; m < seg.length; m++) ctx.lineTo(seg[m][0], seg[m][1]); }
      ctx.stroke();
    }
    var landRings = null;
    function buildLand() {
      landRings = (land.rings || []).map(function (flat) {
        var pts = new Array(flat.length / 2);
        for (var i = 0, k = 0; i < flat.length; i += 2, k++) pts[k] = unit(flat[i], flat[i + 1]);
        return pts;
      });
    }
    function drawLand() {
      if (!landRings) buildLand();
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, TWO_PI); ctx.clip();
      ctx.fillStyle = colors.land; ctx.strokeStyle = colors.coast; ctx.lineWidth = 0.6; ctx.lineJoin = 'round';
      for (var i = 0; i < landRings.length; i++) {
        var clip = clipRing(landRings[i], R);
        if (!clip) continue;
        fillClipped(clip, R); ctx.fill(); strokeClipped(clip);
      }
      ctx.restore();
    }
    function drawGraticule() {
      ctx.strokeStyle = colors.grat; ctx.lineWidth = 1;
      var lat, lon, p, pen;
      for (lat = -60; lat <= 60; lat += 30) {
        ctx.beginPath(); pen = false;
        for (lon = -180; lon <= 180; lon += 4) { p = project(unit(lon, lat), R); if (p[2] < 0) { pen = false; continue; } if (!pen) { ctx.moveTo(p[0], p[1]); pen = true; } else ctx.lineTo(p[0], p[1]); }
        ctx.stroke();
      }
      for (lon = -180; lon < 180; lon += 30) {
        ctx.beginPath(); pen = false;
        for (lat = -88; lat <= 88; lat += 4) { p = project(unit(lon, lat), R); if (p[2] < 0) { pen = false; continue; } if (!pen) { ctx.moveTo(p[0], p[1]); pen = true; } else ctx.lineTo(p[0], p[1]); }
        ctx.stroke();
      }
    }

    /* ---------------------------------------------------------- positions */
    function refreshPositions() {
      now = new Date();
      for (var i = 0; i < objects.length; i++) {
        var obj = objects[i];
        if (!obj.satrec) continue;
        var e = O.ecf(obj.satrec, now);
        if (e) positions[obj.id] = e;
      }
      if (selected) refreshRing();
    }
    function refreshRing() {
      var obj = byId(selected);
      if (!obj || !obj.satrec) { ring = null; track = null; return; }
      ring = O.orbitRing(obj.satrec, now, 200);
      track = O.groundTrack(obj.satrec, now, 220);
      ringAt = selected;
    }
    function orbitColor(kind) { return colors.orbit[kind] || colors.muted; }

    function drawOrbit(obj) {
      if (!ring) return;
      var col = orbitColor(obj.orbit);
      var i, p, prev = null, behind = [];
      ctx.lineWidth = 1.2; ctx.strokeStyle = col; ctx.globalAlpha = 0.9; ctx.beginPath();
      for (i = 0; i < ring.length; i++) {
        p = projectState(ring[i]);
        if (p[3]) { behind.push(p); prev = null; continue; }
        if (!prev) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
        prev = p;
      }
      ctx.stroke();
      if (behind.length > 1) {
        ctx.globalAlpha = 0.25; ctx.setLineDash([3, 4]); ctx.beginPath();
        ctx.moveTo(behind[0][0], behind[0][1]);
        for (i = 1; i < behind.length; i++) ctx.lineTo(behind[i][0], behind[i][1]);
        ctx.stroke(); ctx.setLineDash([]);
      }
      // sub-satellite track, ±half a period, dashed on the surface
      if (track) {
        ctx.globalAlpha = 0.5; ctx.lineWidth = 1; ctx.setLineDash([2, 3]); ctx.beginPath();
        var pen = false;
        for (i = 0; i < track.length; i++) {
          p = project(unit(track[i].lon, track[i].lat), R * 1.002);
          if (p[2] < 0) { pen = false; continue; }
          if (!pen) { ctx.moveTo(p[0], p[1]); pen = true; } else ctx.lineTo(p[0], p[1]);
        }
        ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
    }

    function drawObserver() {
      if (!observer) return;
      var p = project(unit(observer.lon, observer.lat), R * 1.003);
      if (p[2] < 0) return;
      ctx.strokeStyle = colors.ink; ctx.globalAlpha = 0.8; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p[0] - 6, p[1]); ctx.lineTo(p[0] - 2, p[1]); ctx.moveTo(p[0] + 2, p[1]); ctx.lineTo(p[0] + 6, p[1]);
      ctx.moveTo(p[0], p[1] - 6); ctx.lineTo(p[0], p[1] - 2); ctx.moveTo(p[0], p[1] + 2); ctx.lineTo(p[0], p[1] + 6); ctx.stroke();
      ctx.fillStyle = colors.muted; ctx.font = '500 10px ' + tok('--ds-font-mono', 'monospace'); ctx.textBaseline = 'middle';
      ctx.fillText(observer.id, p[0] + 9, p[1] + 8);
      ctx.globalAlpha = 1;
    }

    function draw() {
      if (!W) return;
      setBasis();
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = colors.space; ctx.fillRect(0, 0, W, H);
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, TWO_PI); ctx.fillStyle = colors.ocean; ctx.fill();
      drawGraticule(); drawLand();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, TWO_PI); ctx.strokeStyle = colors.limb; ctx.lineWidth = 1; ctx.stroke();
      drawObserver();

      var sel = selected ? byId(selected) : null;
      if (sel) drawOrbit(sel);

      marks = [];
      var front = [];
      for (var i = 0; i < visibleList.length; i++) {
        var obj = visibleList[i];
        var s = positions[obj.id];
        if (!s) continue;
        var p = projectState(s);
        var item = { obj: obj, x: p[0], y: p[1], z: p[2], occ: p[3], state: s };
        marks.push(item);
        if (p[3] || p[2] < 0) drawMark(item, true); else front.push(item);
      }
      for (var j = 0; j < front.length; j++) drawMark(front[j], false);
      if (sel) drawSelection(sel);
      else if (hovered) drawHoverLabel();
    }
    function drawMark(item, dim) {
      var obj = item.obj;
      var isSel = selected && obj.id === selected, isHov = hovered && obj.id === hovered;
      var r = obj.field ? 1.3 : 2.6;
      if (isSel) r = 3.8; else if (isHov) r = 3.4;
      ctx.globalAlpha = dim ? (obj.field ? 0.15 : 0.35) : (obj.field ? 0.5 : 1);
      ctx.fillStyle = obj.field ? colors.muted : orbitColor(obj.orbit);
      ctx.beginPath(); ctx.arc(item.x, item.y, r, 0, TWO_PI); ctx.fill();
      ctx.globalAlpha = 1;
    }
    function findMark(id) { for (var i = 0; i < marks.length; i++) if (marks[i].obj.id === id) return marks[i]; return null; }
    function label(m, text, strong) {
      ctx.fillStyle = strong ? colors.ink : colors.muted;
      ctx.font = (strong ? '600 ' : '500 ') + '11px ' + tok('--ds-font-mono', 'monospace'); ctx.textBaseline = 'middle';
      var tx = m.x + 12, ty = m.y - 9, tw = ctx.measureText(text).width;
      if (tx + tw > W - 8) tx = m.x - 12 - tw;
      ctx.fillText(text, tx, ty);
    }
    function drawSelection(obj) {
      var m = findMark(obj.id); if (!m) return;
      ctx.strokeStyle = colors.ink; ctx.globalAlpha = m.occ ? 0.35 : 0.85; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(m.x, m.y, 8, 0, TWO_PI); ctx.stroke(); ctx.globalAlpha = 1;
      label(m, obj.name, true);
    }
    function drawHoverLabel() { var m = findMark(hovered); if (m && !m.occ) label(m, m.obj.name, false); }
    function byId(id) { for (var i = 0; i < objects.length; i++) if (objects[i].id === id) return objects[i]; return null; }

    /* ------------------------------------------------------------ picking */
    function markAt(clientX, clientY) {
      var rect = canvas.getBoundingClientRect(), x = clientX - rect.left, y = clientY - rect.top;
      var best = null, bd = Infinity;
      for (var i = 0; i < marks.length; i++) {
        var m = marks[i]; if (m.occ) continue;
        var d = (m.x - x) * (m.x - x) + (m.y - y) * (m.y - y);
        var lim = m.obj.field ? 64 : 196;
        if (d < bd && d <= lim) { bd = d; best = m; }
      }
      return best ? best.obj : null;
    }

    /* --------------------------------------------------- input and loop */
    var pointers = {}, dragging = false, moved = false, px = 0, py = 0, pinchD = 0, lastT = 0;
    function nPointers() { return Object.keys(pointers).length; }
    canvas.addEventListener('pointerdown', function (e) {
      pointers[e.pointerId] = [e.clientX, e.clientY];
      canvas.setPointerCapture(e.pointerId);
      if (nPointers() === 1) { dragging = true; moved = false; px = e.clientX; py = e.clientY; if (view.spin) { view.spin = false; } canvas.classList.add('is-dragging'); }
      else if (nPointers() === 2) { var k = Object.keys(pointers); pinchD = Math.hypot(pointers[k[0]][0] - pointers[k[1]][0], pointers[k[0]][1] - pointers[k[1]][1]); }
    });
    canvas.addEventListener('pointermove', function (e) {
      if (pointers[e.pointerId]) pointers[e.pointerId] = [e.clientX, e.clientY];
      if (nPointers() === 2) {
        var k = Object.keys(pointers);
        var d = Math.hypot(pointers[k[0]][0] - pointers[k[1]][0], pointers[k[0]][1] - pointers[k[1]][1]);
        if (pinchD) setZoom(view.zoom * d / pinchD);
        pinchD = d; moved = true; return;
      }
      if (!dragging) {
        var over = markAt(e.clientX, e.clientY), id = over ? over.id : null;
        if (id !== hovered) { hovered = id; draw(); }
        canvas.style.cursor = over ? 'pointer' : '';
        return;
      }
      var dx = e.clientX - px, dy = e.clientY - py;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      px = e.clientX; py = e.clientY;
      var k2 = 0.34 / view.zoom;
      view.lon -= dx * k2; view.lat = Math.max(-85, Math.min(85, view.lat + dy * k2 * 0.85));
      draw();
    });
    function endDrag(e) { delete pointers[e.pointerId]; if (nPointers() === 0) { dragging = false; canvas.classList.remove('is-dragging'); pinchD = 0; } }
    canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('click', function (e) {
      if (moved) return;
      var obj = markAt(e.clientX, e.clientY);
      if (obj) { api.select(obj.id); if (o.onPick) o.onPick(obj); }
      else if (selected) { api.select(null); if (o.onPick) o.onPick(null); }
    });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      setZoom(view.zoom * Math.pow(1.0015, -e.deltaY));
    }, { passive: false });
    canvas.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 15 : 5;
      if (e.key === 'ArrowLeft') view.lon -= step; else if (e.key === 'ArrowRight') view.lon += step;
      else if (e.key === 'ArrowUp') view.lat = Math.min(85, view.lat + step); else if (e.key === 'ArrowDown') view.lat = Math.max(-85, view.lat - step);
      else if (e.key === '+' || e.key === '=') setZoom(view.zoom * 1.2); else if (e.key === '-') setZoom(view.zoom / 1.2);
      else if (e.key === ' ') view.spin = !view.spin; else return;
      e.preventDefault(); draw();
    });
    function setZoom(z) {
      view.zoom = Math.max(ZMIN, Math.min(ZMAX, z));
      R = (Math.min(W, H) * 0.47 * view.zoom) / FRAME;
      draw();
    }

    var raf = null, lastPos = 0;
    function frame(t) {
      raf = global.requestAnimationFrame(frame);
      var dt = lastT ? (t - lastT) / 1000 : 0; lastT = t;
      if (dt > 0.5) dt = 0.5;
      var changed = false;
      if (t - lastPos > 1000) { lastPos = t; refreshPositions(); changed = true; if (o.onTick) o.onTick(now); }
      if (view.spin && !dragging) { view.lon += view.spinRate * dt; changed = true; }
      if (changed) draw();
    }

    var api = {
      resize: resize, draw: draw, view: view, objects: objects,
      position: function (id) { return positions[id] || null; },
      setFilter: function (fn) {
        visibleList = fn ? objects.filter(fn) : objects.slice();
        if (selected && !visibleList.some(function (x) { return x.id === selected; })) api.select(null);
        draw();
        return visibleList.length;
      },
      select: function (id) {
        selected = id || null; ring = null; track = null;
        if (selected) refreshRing();
        draw();
      },
      selected: function () { return selected ? byId(selected) : null; },
      setSpin: function (v) { view.spin = !!v; },
      zoomBy: function (f) { setZoom(view.zoom * f); },
      resetView: function () { view.zoom = 1; view.lon = 10; view.lat = 30; view.spin = true; setZoom(1); },
      lookAt: function (lon, lat) { if (lon != null) view.lon = lon; if (lat != null) view.lat = lat; draw(); },
      faceObject: function (obj) {
        var s = positions[obj.id]; if (!s) return;
        var off = s.alt > 3000 ? 38 : 0;
        view.spin = false;
        api.lookAt(s.lon - off, Math.max(-65, Math.min(65, s.lat * 0.6)));
      },
      destroy: function () { if (raf) global.cancelAnimationFrame(raf); }
    };

    canvas.setAttribute('tabindex', '0');
    refreshPositions();
    resize();
    raf = global.requestAnimationFrame(frame);
    return api;
  }

  global.DeadSatGlobe = { create: createGlobe };
})(window);
