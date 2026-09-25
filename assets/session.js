/*!
 * DeadSat Chess — the "one move" dashboard.
 * Left: the board. Right: the ops stream from the station link (live tab) and the
 * recorded sessions from data/sessions.json. Under the stream, a four-line summary
 * computed here from the cached elements: az/el/range, Doppler-corrected downlink,
 * illumination, next pass.
 */
(function (global) {
  'use strict';

  var O = global.DeadSatOrbit;
  var MIN_EL = 10;          // passes below this are not worth tracking with a hand-pointed yagi
  var MAX_LINES = 400;

  function z(n, w) { return String(n).padStart(w || 2, '0'); }
  function hms(d) { return z(d.getUTCHours()) + ':' + z(d.getUTCMinutes()) + ':' + z(d.getUTCSeconds()); }
  function stamp(d) { return d.toISOString().slice(0, 10) + ' ' + hms(d) + 'Z'; }
  function dur(sec) { sec = Math.max(0, Math.round(sec)); var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return (h ? z(h) + ':' : '') + z(m) + ':' + z(s); }
  function mmss(sec) { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ':' + z(sec % 60); }
  function km(n) { return Math.round(n).toLocaleString('en-US').replace(/,/g, ' ') + ' km'; }
  function mhz(f) { var s = f.toFixed(6); return s.slice(0, -3) + ' ' + s.slice(-3) + ' MHz'; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function el(id) { return document.getElementById(id); }
  var localFmt = null;
  try { localFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }); } catch (e) { localFmt = null; }

  function create(opts) {
    var target = opts.target, observer = opts.observer, pstate = opts.state || {};
    var sessions = (opts.sessions || []).slice().sort(function (a, b) { return a.aos < b.aos ? 1 : -1; });
    var f0 = target.tx && target.tx.length ? target.tx[0].f : 437.125;
    var phase = pstate.phase || 'listening';
    var termlog = el('termlog'), termlive = el('termlive'), tabs = el('sessTabs'), strip = el('strip'), cap = el('boardcap'), title = el('termTitle'), local = el('termLocal');

    var board = global.DeadSatBoard.create(el('board'), {
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
      from: null, cursor: null, labelTop: phase === 'listening' ? '--' : target.name, labelBottom: observer.id
    });

    /* ---- orbital context, refreshed once a second ---- */
    var passCache = [], passUntil = 0, cur = null;
    function ensurePasses(now) {
      if (now.getTime() < passUntil && passCache.some(function (p) { return p.los > now; })) return;
      var to = new Date(now.getTime() + 48 * 3600e3);
      passCache = O.passes(target.satrec, observer, new Date(now.getTime() - 20 * 60e3), to);
      passUntil = to.getTime() - 6 * 3600e3;
    }
    function nextPass(now, minEl) { for (var i = 0; i < passCache.length; i++) if (passCache[i].los > now && (!minEl || passCache[i].maxEl >= minEl)) return passCache[i]; return null; }
    function context(now) {
      now = now || new Date();
      ensurePasses(now);
      var l = O.look(target.satrec, observer, now);
      var rx = O.doppler(f0, l ? l.rate : null);
      var ep = O.epochDate(target.satrec);
      cur = {
        now: now, look: l, rx: rx, sunlit: O.inShadow(target.satrec, now) === false,
        next: nextPass(now), nextUsable: nextPass(now, MIN_EL), minEl: MIN_EL,
        tleAge: (now - ep) / 86400000, tleEpoch: target.tle.line1.slice(18, 32).trim(),
        target: { name: target.name, norad: String(parseInt(target.id, 10)), f0: f0 },
        station: observer.id, host: 'pi4', elementsCached: opts.elementsCached || 0, kissFiles: sessions.length
      };
      return cur;
    }

    /* ---- the stream ---- */
    var live = [];
    var shown = 'live';
    function cls(src, c) { if (c) return c; if (src === 'detect') return 'det'; if (src === 'ops') return 'ops'; return 'rig'; }
    function fmt(f) { return '<span class="' + cls(f.src, f.cls) + '">' + esc(stamp(f.ts)) + '  ' + esc(f.src.padEnd(8)) + ' ' + esc(f.text) + '</span>'; }
    function push(f) {
      live.push(f); if (live.length > MAX_LINES) live.shift();
      if (shown !== 'live') return;
      var atBottom = termlog.scrollHeight - termlog.scrollTop - termlog.clientHeight < 40;
      var span = document.createElement('span'); span.innerHTML = fmt(f) + '\n';
      termlog.appendChild(span);
      while (termlog.childNodes.length > MAX_LINES + 1) termlog.removeChild(termlog.firstChild);
      if (atBottom) termlog.scrollTop = termlog.scrollHeight;
    }
    var link = global.StationLink.open(pstate, function (when) { return when ? context(when) : (cur || context()); }, push, function (s) { push({ src: 'link', text: 'relay ' + s, cls: s === 'open' ? null : 'warn', ts: new Date() }); });

    function renderTabs() {
      tabs.innerHTML = '';
      [{ id: 'live', label: 'live' }].concat(sessions.map(function (s) { return { id: s.id, label: s.id }; })).forEach(function (t) {
        var b = document.createElement('button');
        b.type = 'button'; b.textContent = t.label; b.setAttribute('aria-pressed', t.id === shown ? 'true' : 'false');
        b.addEventListener('click', function () { shown = t.id; renderTabs(); renderLog(); });
        tabs.appendChild(b);
      });
    }
    function sessCls(line) { var src = line.slice(22, 30).trim(); return src === 'detect' ? 'det' : src === 'ops' ? 'ops' : 'rig'; }
    function renderLog() {
      if (shown === 'live') {
        title.textContent = 'ops · ' + observer.id + ' · ' + target.name;
        termlog.innerHTML = live.map(function (f) { return '<span>' + fmt(f) + '\n</span>'; }).join('');
        termlog.scrollTop = termlog.scrollHeight;
        return;
      }
      var s = sessions.filter(function (x) { return x.id === shown; })[0];
      if (!s) return;
      title.textContent = 'session ' + s.id + ' · ' + s.target + ' · max el ' + s.maxEl.toFixed(0) + '° · ' + (s.carrier ? 'carrier ' + s.carrier : 'nothing') + ' · frames ' + s.frames;
      var html = '<span class="hd"># ' + esc(observer.id) + ' station log · ' + esc(s.target) + ' (' + esc(s.norad) + ') · ' + esc(s.aos.slice(0, 10)) + '</span>\n';
      html += s.lines.map(function (l) { return '<span class="' + sessCls(l) + '">' + esc(l) + '</span>'; }).join('\n');
      if (s.note) html += '\n<span class="hd"># ' + esc(s.note) + '</span>';
      termlog.innerHTML = html;
      termlog.scrollTop = termlog.scrollHeight;
    }
    renderTabs(); renderLog();
    context(new Date());
    link.start();

    /* ---- summary, strip, caption ---- */
    function row(k, v, w) { return '<span class="k">' + k.padEnd(9) + '</span>' + (w ? '<span class="w">' : '<span class="v">') + v + '</span>'; }

    function tick(now) {
      if (!target.satrec) { termlive.textContent = 'no elements cached for the target'; return; }
      var c = context(now);
      if (local && localFmt) local.textContent = localFmt.format(now).replace(',', '');
      var l = c.look; if (!l) return;
      var dopKHz = (c.rx - f0) * 1000;
      var np = c.next, nu = c.nextUsable;
      var inPass = np && np.aos <= now && np.los > now;
      var lines = [];
      lines.push(row('utc', stamp(now) + '  <span class="k">· prediction from cached elements</span>'));
      lines.push(row(target.name.toLowerCase(), 'az ' + l.az.toFixed(1).padStart(5) + '  el ' + l.el.toFixed(1).padStart(5) + '  range ' + km(l.range) + (l.el > 0 ? '  above horizon' : '  below horizon')));
      lines.push(row('rx', mhz(c.rx) + '  (dop ' + (dopKHz >= 0 ? '+' : '') + dopKHz.toFixed(2) + ' kHz)  sunlit ' + (c.sunlit ? 'yes' : 'no')));
      if (inPass) lines.push(row('pass', 'IN PROGRESS  max el ' + np.maxEl.toFixed(0) + '°  LOS ' + hms(np.los) + 'Z  in ' + mmss((np.los - now) / 1000), true));
      else if (nu) lines.push(row('next', 'AOS ' + stamp(nu.aos) + '  in ' + dur((nu.aos - now) / 1000) + '  max el ' + nu.maxEl.toFixed(0) + '°  az ' + nu.aosAz.toFixed(0) + ' → ' + nu.losAz.toFixed(0) + '  dur ' + mmss(nu.duration)));
      else lines.push(row('next', 'no usable pass in the next 48 h'));
      lines.push(row('link', 'none  ·  candidate ' + target.name + '  ·  listening only'));
      lines.push(row('board', 'idle  ·  no opponent<span class="cur">_</span>'));
      termlive.innerHTML = lines.join('\n');

      var last = sessions[0];
      var cells = [
        ['pass', inPass ? 'in progress' : (nu ? 'next ' + hms(nu.aos).slice(0, 5) + 'Z' : '—'), inPass],
        ['aos', nu ? hms(nu.aos) + 'Z' : '—', false],
        ['los', nu ? hms(nu.los) + 'Z' : '—', false],
        ['az / el', l.az.toFixed(1) + ' / ' + l.el.toFixed(1), l.el > 0],
        ['doppler', (dopKHz >= 0 ? '+' : '') + dopKHz.toFixed(1) + ' kHz', false],
        ['carrier', last && last.carrier ? last.carrier + ' · ' + last.id.slice(0, 8) : 'none', false],
        ['frames', last ? String(last.frames) : '0', false],
        ['link', 'none', false]
      ];
      strip.innerHTML = cells.map(function (x) { return '<div><span class="k">' + x[0] + '</span><span class="v" data-live="' + (x[2] ? 'true' : 'false') + '">' + esc(x[1]) + '</span></div>'; }).join('');
      cap.innerHTML = '<span>white <b>' + esc(observer.id) + '</b> · black <b>--</b></span><span class="dim">no link · candidate ' + esc(target.name) + '</span><span>waiting for an opponent<span class="blink">_</span></span>';
    }

    return { tick: tick, board: board, link: link };
  }

  global.DeadSatSession = { create: create };
})(window);
