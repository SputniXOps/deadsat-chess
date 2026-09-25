/*!
 * DeadSat Chess — page wiring.
 * Loads the catalogue, the cached elements and the coastlines; builds the globe,
 * the record card, the candidates list and the dashboard. Everything on screen
 * derives from the data files.
 */
(function () {
  'use strict';

  var O = window.DeadSatOrbit;
  var ORBITS = [
    ['LEO', 'orbit-leo', 'LEO'], ['MEO', 'orbit-meo', 'MEO'], ['GEO', 'orbit-geo', 'GEO'], ['GSO', 'orbit-geo', 'GSO'],
    ['HEO', 'orbit-heo', 'HEO'], ['GRAVEYARD', 'orbit-graveyard', 'Graveyard'], ['DECAYING', 'orbit-decaying', 'Decaying']
  ];
  var STATUS_TONE = {
    'Operational': 'operational', 'Partially Operational': 'partial', 'Inactive': 'dormant', 'Non-operational': 'dormant',
    'Retired': 'dormant', 'Decommissioned': 'dormant', 'Abandoned': 'unattended', 'Lost Contact': 'unattended',
    'Graveyard Orbit': 'graveyard', 'Unknown': 'unknown'
  };
  var INACTIVE = { 'Operational': false, 'Partially Operational': false };

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = text; return n; }
  function int(n) { return n === null || n === undefined || isNaN(n) ? '—' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function km(n) { return n === null || n === undefined ? '—' : int(n) + ' km'; }
  function deg(n, d) { return n === null || n === undefined ? '—' : Number(n).toFixed(d === undefined ? 1 : d) + '°'; }
  function z(n) { return String(n).padStart(2, '0'); }
  function hms(d) { return z(d.getUTCHours()) + ':' + z(d.getUTCMinutes()) + ':' + z(d.getUTCSeconds()); }
  function ageDays(d) { return (Date.now() - d.getTime()) / 86400000; }
  function ageStr(d) { var a = ageDays(d); return a < 1 ? (a * 24).toFixed(0) + ' h' : a < 60 ? a.toFixed(1) + ' d' : a < 730 ? (a / 30.4).toFixed(0) + ' mo' : (a / 365.25).toFixed(1) + ' y'; }

  var state = { orbits: { LEO: true, MEO: true, GEO: true, GSO: true, HEO: true, GRAVEYARD: true, DECAYING: true }, group: 'all', query: '' };
  var data = null, tle = null, field = null, sessions = null, land = null, satnogs = null;
  var globe = null, session = null, recentSince = 0, observer = null, all = [];

  /* ------------------------------------------------------------- prepare */
  function prepare() {
    recentSince = Date.parse(data.recentSince || '2020-01-01');
    observer = data.observer;
    data.objects.forEach(function (o) {
      var t = tle.items[String(int0(o.id))];
      o.tle = t || null;
      o.satrec = t ? O.parse(t.line1, t.line2) : null;
      if (o.satrec) { o.summary = O.summary(o.satrec); o.orbit = O.classify(o.satrec, o.orbit); }
      o.recent = !!(o.rf && o.rf.lastHeard && Date.parse(pad(o.rf.lastHeard)) >= recentSince);
      o.inactive = INACTIVE[o.status] !== false;
      o.field = false;
    });
    all = data.objects.slice();
    if (field && field.items) {
      var known = {};
      data.objects.forEach(function (o) { known[String(int0(o.id))] = true; });
      Object.keys(field.items).forEach(function (id) {
        if (known[id]) return;
        var t = field.items[id], rec = O.parse(t.line1, t.line2);
        if (!rec) return;
        all.push({ id: 'f' + id, name: t.name || ('NORAD ' + id), field: true, satrec: rec, orbit: O.classify(rec), status: 'Unknown', rf: {} });
      });
    }
  }
  function int0(id) { return parseInt(id, 10); }
  function pad(s) { return s.length === 4 ? s + '-01-01' : s.length === 7 ? s + '-01' : s; }

  /* ------------------------------------------------------------ filtering */
  function matches(o) {
    if (o.field) return state.group === 'all' && !state.query && state.orbits[o.orbit];
    if (!state.orbits[o.orbit]) return false;
    if (state.group === 'rf' && !(o.rf && o.rf.historical)) return false;
    if (state.group === 'recent' && !o.recent) return false;
    if (state.group === 'watch' && !o.watch) return false;
    if (state.query) {
      var q = state.query.toLowerCase();
      var hay = [o.name, o.id, o.cospar, o.operator, o.country].concat(o.alt || []).join(' ').toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }

  function apply() {
    globe.setFilter(matches);
    renderCands();
  }

  /* --------------------------------------------------------------- counts */
  function counts() {
    var objs = data.objects;
    var withTle = objs.filter(function (o) { return o.satrec; });
    var newest = withTle.reduce(function (m, o) { return Math.max(m, o.summary.epoch.getTime()); }, 0);
    document.getElementById('tleage').textContent = objs.length + ' objects · elements: ' + withTle.length + ' cached · newest epoch ' + (newest ? new Date(newest).toISOString().slice(0, 10) : '—') + ' · radial scale compressed';
  }

  /* ----------------------------------------------------------- record card */
  function badge(cls, attrs, label) {
    var b = el('span', 'badge ' + cls + ' micro');
    Object.keys(attrs || {}).forEach(function (k) { b.setAttribute(k, attrs[k]); });
    if (cls === 'status') b.appendChild(el('i'));
    b.appendChild(el('span', null, label)); return b;
  }
  function kv(dl, k, v, cls) { dl.appendChild(el('dt', null, k)); dl.appendChild(el('dd', cls || null, v)); }
  var live = null;

  function showCard(o) {
    var stage = document.getElementById('atlas');
    var old = stage.querySelector('.card'); if (old) old.remove();
    live = null;
    if (!o || o.field) return;

    var card = el('div', 'card');
    var close = el('button', 'btn close'); close.type = 'button'; close.setAttribute('aria-label', 'Close');
    close.innerHTML = '<svg width="11" height="11" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4.5 4.5l9 9M13.5 4.5l-9 9"/></svg>';
    close.addEventListener('click', function () { select(null); });
    card.appendChild(close);
    card.appendChild(el('h2', 'display-sm', o.name));
    if (o.alt && o.alt.length) card.appendChild(el('span', 'alt micro', o.alt.join(' · ')));
    card.appendChild(el('span', 'ids ident', 'NORAD ' + String(int0(o.id)).padStart(5, '0') + ' · ' + (o.cospar || '—')));

    var badges = el('div', 'badges');
    if (o.candidate && o.candidate.rank) badges.appendChild(badge('rank', {}, 'candidate ' + o.candidate.rank));
    badges.appendChild(badge('status', { 'data-tone': STATUS_TONE[o.status] || 'unknown' }, o.status));
    badges.appendChild(badge('orbit', { 'data-orbit': o.orbit }, o.orbit));
    if (o.rf && o.rf.historical) badges.appendChild(badge('rf', { 'data-recent': o.recent ? 'true' : 'false' }, o.recent ? 'recently heard' : 'historical RF'));
    if (o.watch) badges.appendChild(badge('watch', {}, 'watchlist'));
    card.appendChild(badges);

    var dl = el('dl');
    kv(dl, 'OPERATOR', o.operator || '—', 'sans');
    kv(dl, 'MISSION', o.mission || '—', 'sans');
    kv(dl, 'LAUNCH', o.launch || '—');
    if (o.retired) kv(dl, 'RETIRED', o.retired);
    if (o.summary) {
      kv(dl, 'PERIOD', o.summary.period.toFixed(1) + ' min');
      kv(dl, 'INCLINATION', deg(o.summary.i));
      kv(dl, 'PERIGEE', km(o.summary.perigee));
      kv(dl, 'APOGEE', km(o.summary.apogee));
    }
    card.appendChild(dl);

    // TRACK
    card.appendChild(el('p', 'sec label', 'track'));
    var tr = el('dl');
    if (o.satrec) {
      live = {};
      tr.appendChild(el('dt', null, 'SUB-POINT')); live.pos = el('dd', null, '—'); tr.appendChild(live.pos);
      tr.appendChild(el('dt', null, 'ALTITUDE')); live.alt = el('dd', null, '—'); tr.appendChild(live.alt);
      tr.appendChild(el('dt', null, observer.id + ' AZ/EL')); live.look = el('dd', null, '—'); tr.appendChild(live.look);
      tr.appendChild(el('dt', null, 'NEXT PASS')); live.pass = el('dd', null, '…'); tr.appendChild(live.pass);
      var ep = o.summary.epoch, a = ageDays(ep);
      kv(tr, 'ELEMENTS', ep.toISOString().slice(0, 10) + ' · ' + ageStr(ep) + ' old · ' + (o.tle.source || ''), a > 30 ? 'warn' : null);
    } else {
      kv(tr, 'ELEMENTS', 'not cached — run scripts/fetch_tle.py', 'warn');
    }
    card.appendChild(tr);

    // RF
    card.appendChild(el('p', 'sec label', 'rf'));
    var rf = el('dl');
    (o.tx || []).forEach(function (t) {
      kv(rf, fmtF(t.f) + ' MHz', t.mode + (t.desc ? ' — ' + t.desc : '') + (t.alive === true ? ' · alive' : t.alive === false ? ' · silent' : ' · unverified'), 'sans');
    });
    if (!(o.tx || []).length) kv(rf, 'FREQ', 'no public frequency record kept here', 'sans');
    if (o.rf) {
      kv(rf, 'RF HISTORY', o.rf.historical ? 'documented' : 'none found', 'sans');
      kv(rf, 'LAST REPORT', o.rf.lastHeard ? o.rf.lastHeard + (o.rf.lastBy ? ' · ' + o.rf.lastBy : '') : 'none found', 'sans');
      if (o.rf.lastNote) kv(rf, 'NOTE', o.rf.lastNote, 'sans');
    }
    var sn = satnogs && satnogs.items && satnogs.items[String(int0(o.id))];
    if (sn) kv(rf, 'SATNOGS', 'obs ' + sn.id + ' · ' + String(sn.start).slice(0, 10) + ' · ' + (sn.station_name || sn.ground_station) + ' · ' + sn.status, 'sans');
    card.appendChild(rf);

    // WHY / NOTES
    if (o.candidate && o.candidate.why && o.candidate.why.length) {
      card.appendChild(el('p', 'sec label', o.candidate.rank ? 'why this one' : 'notes'));
      var ul = el('ul', 'why body-sm');
      o.candidate.why.forEach(function (w) { ul.appendChild(el('li', null, w)); });
      card.appendChild(ul);
    }
    if (o.computer) { var cdl = el('dl'); kv(cdl, 'COMPUTER', o.computer, 'sans'); card.appendChild(cdl); }
    if (o.notes) card.appendChild(el('p', 'note micro', o.notes));

    // SOURCE
    card.appendChild(el('p', 'sec label', 'source'));
    card.appendChild(el('p', 'note micro', (o.sources || []).join(' · ') + (o.tle ? ' · elements: ' + (o.tle.source || '') : '')));
    stage.appendChild(card);
    updateLive(new Date());
  }

  var passMemo = {};
  function updateLive(now) {
    if (!live || !globe) return;
    var o = globe.selected(); if (!o || !o.satrec) return;
    var p = globe.position(o.id);
    if (p) { live.pos.textContent = deg(p.lat) + ' / ' + Math.abs(p.lon).toFixed(1) + '°' + (p.lon < 0 ? 'W' : 'E'); live.alt.textContent = km(p.alt); }
    var l = O.look(o.satrec, observer, now);
    if (l) live.look.textContent = l.az.toFixed(1) + '° / ' + l.el.toFixed(1) + '°' + (l.el > 0 ? ' · above horizon' : '');
    var key = o.id;
    if (!passMemo[key] || passMemo[key].until < now.getTime()) {
      var s = o.summary;
      if (s.period > 1300 && s.period < 1600 && s.e < 0.05) {
        passMemo[key] = { text: l && l.el > 0 ? 'geosynchronous · fixed in the sky' : 'geosynchronous · below the horizon from ' + observer.id, until: now.getTime() + 3600e3 };
      } else {
        var ps = O.passes(o.satrec, observer, now, new Date(now.getTime() + 36 * 3600e3), 0);
        var np = ps.filter(function (x) { return x.los > now; })[0];
        passMemo[key] = { text: np ? 'AOS ' + hms(np.aos) + 'Z · max el ' + np.maxEl.toFixed(0) + '° · ' + Math.round(np.duration / 60) + ' min' : 'none in 36 h', until: np ? np.los.getTime() : now.getTime() + 3600e3 };
      }
    }
    live.pass.textContent = passMemo[key].text;
  }

  function select(id, opts) {
    var o = id ? all.filter(function (x) { return x.id === id; })[0] : null;
    globe.select(o ? o.id : null);
    if (o && opts && opts.face) globe.faceObject(o);
    showCard(o);
    renderCands();
  }

  /* ------------------------------------------------------------ candidates */
  var openCand = null;
  function renderCands() {
    var host = document.getElementById('cands'); host.textContent = '';
    var list = data.objects.filter(function (o) { return o.candidate; })
      .sort(function (a, b) { return (a.candidate.rank || 99) - (b.candidate.rank || 99) || (b.rf.lastHeard || '').localeCompare(a.rf.lastHeard || ''); });
    var head = el('div', 'cand candhead');
    [['#', 'rk'], ['object', 'nm'], ['norad', 'dimc'], ['orbit', 'dimc'], ['computer', 'comp'], ['rf now', 'rfnow'], ['last report', 'lastc'], ['', 'act']].forEach(function (h) { head.appendChild(el('span', h[1], h[0])); });
    host.appendChild(head);
    var sel = globe.selected();
    list.forEach(function (o, i) {
      var row = el('div', 'cand'); row.setAttribute('role', 'button'); row.tabIndex = 0;
      row.setAttribute('data-top', o.candidate.rank ? 'true' : 'false');
      row.setAttribute('aria-selected', sel && sel.id === o.id ? 'true' : 'false');
      row.setAttribute('data-open', openCand === o.id ? 'true' : 'false');
      row.appendChild(el('span', 'rk', o.candidate.rank ? String(o.candidate.rank) : '·'));
      var nm = el('span', 'nm'); nm.appendChild(el('b', null, o.name)); if (o.alt && o.alt[0]) nm.appendChild(el('span', null, o.alt[0])); row.appendChild(nm);
      row.appendChild(el('span', 'dimc', String(int0(o.id)).padStart(5, '0')));
      row.appendChild(el('span', 'dimc', o.orbit));
      row.appendChild(el('span', 'comp dimc', o.computer ? o.computer.split('·')[0].trim() : '—'));
      var alive = (o.tx || []).some(function (t) { return t.alive === true; }) ? 'true' : (o.tx || []).some(function (t) { return t.alive === null; }) ? 'null' : 'false';
      var rfnow = el('span', 'rfnow', alive === 'true' ? (fmtF(o.tx.filter(function (t) { return t.alive; })[0].f) + ' ' + o.tx.filter(function (t) { return t.alive; })[0].mode) : alive === 'null' ? 'unverified' : 'silent');
      rfnow.setAttribute('data-alive', alive); row.appendChild(rfnow);
      row.appendChild(el('span', 'lastc dimc', o.rf && o.rf.lastHeard ? o.rf.lastHeard + (o.rf.lastBy ? ' · ' + o.rf.lastBy.split('/')[0].trim() : '') : 'no report'));
      row.appendChild(el('span', 'act', openCand === o.id ? 'close' : 'why'));
      var why = el('div', 'candwhy');
      var ul = el('ul'); (o.candidate.why || []).forEach(function (w) { ul.appendChild(el('li', null, w)); }); why.appendChild(ul);
      var meta = el('div', 'meta');
      meta.innerHTML = (o.computer ? '<b>computer</b> ' + esc(o.computer) + '<br>' : '') +
        (o.summary ? '<b>orbit</b> ' + o.summary.period.toFixed(1) + ' min · ' + deg(o.summary.i) + ' · ' + km(o.summary.perigee) + ' × ' + km(o.summary.apogee) + '<br>' : '<b>orbit</b> elements not cached<br>') +
        '<b>launch</b> ' + esc(o.launch) + (o.retired ? ' · <b>retired</b> ' + esc(o.retired) : '') + '<br>' +
        '<b>sources</b> ' + esc((o.sources || []).join(' · ')) + '<br>' +
        '<a href="#atlas" class="showmap">show on the map ↑</a>';
      why.appendChild(meta);
      row.appendChild(why);
      function toggle() {
        openCand = openCand === o.id ? null : o.id;
        globe.select(o.id); showCard(o);
        renderCands();
      }
      row.addEventListener('click', function (e) { if (e.target.tagName === 'A') { globe.faceObject(o); return; } toggle(); });
      row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      host.appendChild(row);
    });
  }
  function fmtF(f) { var s = f.toFixed(4); return s.slice(-1) === '0' ? f.toFixed(3) : s; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  /* -------------------------------------------------------------- legend */
  function legend() {
    var host = document.getElementById('legend'); host.textContent = '';
    ORBITS.forEach(function (o) {
      if (!data.objects.some(function (x) { return x.orbit === o[0]; })) return;
      var s = el('span'); s.appendChild(document.createTextNode(o[2])); var i = el('i'); i.style.background = 'var(--ds-' + o[1] + ')'; s.appendChild(i); host.appendChild(s);
    });
  }

  /* ---------------------------------------------------------------- boot */
  function fetchJson(url, optional) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); })
      .catch(function (e) { if (optional) return null; throw e; });
  }
  function fail(msg) {
    var stage = document.getElementById('atlas'); stage.innerHTML = '';
    var p = el('p', 'body'); p.style.padding = '24px'; p.style.color = 'var(--ds-ink-300)'; p.textContent = msg; stage.appendChild(p);
  }

  Promise.all([
    fetchJson('data/objects.json'), fetchJson('data/tle.json'), fetchJson('data/land.json'),
    fetchJson('data/sessions.json', true), fetchJson('data/state.json', true), fetchJson('data/tle_field.json', true), fetchJson('data/satnogs.json', true)
  ]).then(function (res) {
    data = res[0]; tle = res[1]; land = res[2]; sessions = res[3] || { sessions: [] }; var pstate = res[4] || { phase: 'listening' }; field = res[5]; satnogs = res[6];
    prepare();
    document.getElementById('obsGrid').textContent = observer.grid || '';
    counts(); legend();

    globe = window.DeadSatGlobe.create(document.getElementById('globe'), {
      land: land, objects: all, observer: observer, lon: 10, lat: 30,
      onPick: function (obj) { showCard(obj); renderCands(); },
      onTick: function (now) { updateLive(now); if (session) session.tick(now); }
    });
    apply();

    var target = data.objects.filter(function (o) { return String(int0(o.id)) === String(pstate.target || '') || (!pstate.target && o.candidate && o.candidate.rank === 1); })[0];
    if (target && target.satrec) session = window.DeadSatSession.create({ target: target, observer: observer, sessions: sessions.sessions, state: pstate, elementsCached: data.objects.filter(function (o) { return o.satrec; }).length });

    document.getElementById('zoomIn').addEventListener('click', function () { globe.zoomBy(1.25); });
    document.getElementById('zoomOut').addEventListener('click', function () { globe.zoomBy(0.8); });
    document.getElementById('zoomReset').addEventListener('click', function () { globe.resetView(); });
    var hint = document.getElementById('hint');
    document.getElementById('atlas').addEventListener('pointerdown', function () { hint.hidden = true; }, { once: true });

    var q = document.getElementById('q');
    q.addEventListener('input', function () {
      state.query = q.value.trim(); apply();
      if (state.query) { var hit = data.objects.filter(matches)[0]; if (hit) select(hit.id, { face: true }); }
    });
    window.addEventListener('resize', function () { globe.resize(); });

    function clock() { var d = new Date(); document.getElementById('clock').textContent = hms(d) + 'Z'; }
    clock(); setInterval(clock, 1000);
    session && session.tick(new Date());

    window.DeadSatApp = { globe: globe, data: data, all: all, state: state, select: select, session: session };
  }).catch(function (e) {
    fail('Could not load the catalogue (' + e.message + '). Serve the folder over HTTP: python3 -m http.server 8080');
    if (window.console) console.error(e);
  });
})();
