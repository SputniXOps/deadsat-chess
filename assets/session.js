/*!
 * DeadSat Chess — the "one move" dashboard.
 * Left: the board. Right: the last recorded EU-01 session (from data/sessions.json)
 * and a live block that is nothing more than SGP4 prediction for the target from
 * the cached elements: az/el/range, the Doppler-corrected downlink, illumination,
 * the next pass. It says "prediction only" because that is what it is.
 * This page is not connected to the station.
 */
(function (global) {
  'use strict';

  var O = global.DeadSatOrbit;
  var C = 299792.458;

  function z(n, w) { return String(n).padStart(w || 2, '0'); }
  function hms(d) { return z(d.getUTCHours()) + ':' + z(d.getUTCMinutes()) + ':' + z(d.getUTCSeconds()); }
  function stamp(d) { return d.toISOString().slice(0, 10) + ' ' + hms(d) + 'Z'; }
  function dur(sec) { sec = Math.max(0, Math.round(sec)); var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return (h ? z(h) + ':' : '') + z(m) + ':' + z(s); }
  function mmss(sec) { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ':' + z(sec % 60); }
  function km(n) { return Math.round(n).toLocaleString('en-US').replace(/,/g, ' ') + ' km'; }
  function mhz(f) { var s = f.toFixed(6); return s.slice(0, -3) + ' ' + s.slice(-3) + ' MHz'; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function el(id) { return document.getElementById(id); }

  function create(opts) {
    var target = opts.target;            // catalogue object with satrec
    var observer = opts.observer;
    var sessions = (opts.sessions || []).slice().sort(function (a, b) { return a.aos < b.aos ? 1 : -1; });
    var f0 = target.tx && target.tx.length ? target.tx[0].f : 437.125;
    var phase = opts.phase || 'listening';   // listening → contact → game (later phases are not built yet)
    var termlog = el('termlog'), termlive = el('termlive'), tabs = el('sessTabs'), strip = el('strip'), cap = el('boardcap'), title = el('termTitle');

    var board = global.DeadSatBoard.create(el('board'), {
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
      from: null, cursor: null, labelTop: phase === 'listening' ? '--' : target.name, labelBottom: observer.id
    });

    /* ---- recorded sessions ---- */
    var shown = 0;
    function renderTabs() {
      tabs.innerHTML = '';
      sessions.forEach(function (s, i) {
        var b = document.createElement('button');
        b.type = 'button'; b.textContent = s.id; b.setAttribute('aria-pressed', i === shown ? 'true' : 'false');
        b.addEventListener('click', function () { shown = i; renderTabs(); renderLog(); });
        tabs.appendChild(b);
      });
    }
    function cls(line) {
      var src = line.slice(22, 30).trim();
      if (src === 'detect') return 'det';
      if (src === 'ops') return 'ops';
      return 'rig';
    }
    function renderLog() {
      var s = sessions[shown];
      if (!s) { termlog.textContent = 'no recorded sessions'; return; }
      title.textContent = 'session ' + s.id + ' · ' + s.target + ' · max el ' + s.maxEl.toFixed(0) + '° · ' + (s.carrier ? 'carrier ' + s.carrier : 'nothing') + ' · frames ' + s.frames;
      var html = '<span class="hd"># EU-01 station log · ' + esc(s.target) + ' (' + esc(s.norad) + ') · ' + esc(s.aos.slice(0, 10)) + '</span>\n';
      html += s.lines.map(function (l) { return '<span class="' + cls(l) + '">' + esc(l) + '</span>'; }).join('\n');
      if (s.note) html += '\n<span class="hd"># ' + esc(s.note) + '</span>';
      termlog.innerHTML = html;
      termlog.scrollTop = termlog.scrollHeight;
    }
    renderTabs(); renderLog();

    /* ---- live prediction ---- */
    var passCache = [], passUntil = 0;
    function ensurePasses(now) {
      if (now.getTime() < passUntil && passCache.some(function (p) { return p.los > now; })) return;
      var to = new Date(now.getTime() + 48 * 3600e3);
      passCache = O.passes(target.satrec, observer, new Date(now.getTime() - 20 * 60e3), to);
      passUntil = to.getTime() - 6 * 3600e3;
    }
    function nextPass(now) { for (var i = 0; i < passCache.length; i++) if (passCache[i].los > now) return passCache[i]; return null; }

    function row(k, v, w) { return '<span class="k">' + k.padEnd(9) + '</span>' + (w ? '<span class="w">' : '<span class="v">') + v + '</span>'; }

    function tick(now) {
      if (!target.satrec) { termlive.textContent = 'no elements cached for the target'; return; }
      ensurePasses(now);
      var l = O.look(target.satrec, observer, now);
      if (!l) return;
      var rx = O.doppler(f0, l.rate);
      var dopKHz = (rx - f0) * 1000;
      var shadow = O.inShadow(target.satrec, now);
      var np = nextPass(now);
      var inPass = np && np.aos <= now && np.los > now;
      var lines = [];
      lines.push('<span class="k">live · prediction from cached elements · station link: offline</span>');
      lines.push(row('utc', stamp(now)));
      lines.push(row(target.name.toLowerCase(), 'az ' + l.az.toFixed(1).padStart(5) + '  el ' + l.el.toFixed(1).padStart(5) + '  range ' + km(l.range) + (l.el > 0 ? '  above horizon' : '  below horizon')));
      lines.push(row('rx', mhz(rx) + '  (dop ' + (dopKHz >= 0 ? '+' : '') + dopKHz.toFixed(2) + ' kHz)  sunlit ' + (shadow === null ? '?' : shadow ? 'no' : 'yes')));
      if (inPass) {
        lines.push(row('pass', 'IN PROGRESS  max el ' + np.maxEl.toFixed(0) + '°  LOS ' + hms(np.los) + 'Z  in ' + mmss((np.los - now) / 1000) + '  — log posts after LOS', true));
      } else if (np) {
        lines.push(row('next', 'AOS ' + stamp(np.aos) + '  in ' + dur((np.aos - now) / 1000) + '  max el ' + np.maxEl.toFixed(0) + '°  az ' + np.aosAz.toFixed(0) + ' → ' + np.losAz.toFixed(0) + '  dur ' + mmss(np.duration)));
      } else {
        lines.push(row('next', 'no pass in the next 48 h'));
      }
      lines.push(row('link', 'none  ·  candidate ' + target.name + '  ·  listening only'));
      lines.push(row('board', 'idle  ·  no opponent<span class="cur">_</span>'));
      termlive.innerHTML = lines.join('\n');

      // status strip
      var last = sessions[0];
      var cells = [
        ['pass', inPass ? 'in progress' : (np ? 'next ' + hms(np.aos).slice(0, 5) + 'Z' : '—'), inPass],
        ['aos', np ? hms(np.aos) + 'Z' : '—', false],
        ['los', np ? hms(np.los) + 'Z' : '—', false],
        ['az / el', l.az.toFixed(1) + ' / ' + l.el.toFixed(1), l.el > 0],
        ['doppler', (dopKHz >= 0 ? '+' : '') + dopKHz.toFixed(1) + ' kHz', false],
        ['carrier', last && last.carrier ? last.carrier + ' · ' + last.id.slice(0, 8) : 'none', false],
        ['frames', last ? String(last.frames) : '0', false],
        ['link', 'none', false]
      ];
      strip.innerHTML = cells.map(function (c) { return '<div><span class="k">' + c[0] + '</span><span class="v" data-live="' + (c[2] ? 'true' : 'false') + '">' + esc(c[1]) + '</span></div>'; }).join('');

      cap.innerHTML = '<span>white <b>' + esc(observer.id) + '</b> · black <b>--</b></span><span class="dim">no link · candidate ' + esc(target.name) + '</span><span>waiting for an opponent<span class="blink">_</span></span>';
    }

    return { tick: tick, board: board };
  }

  global.DeadSatSession = { create: create };
})(window);
