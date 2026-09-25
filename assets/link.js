/*!
 * DeadSat Chess — station link client.
 *
 * The ops daemon on the EU-01 host writes a line-oriented status stream:
 *   <seq> <src> <text> *<crc16>
 * When a relay endpoint is configured (data/state.json → "link"), this client
 * connects to it, verifies each frame and hands the text to the page. Without an
 * endpoint it runs the daemon's idle scheduler locally, against the same cached
 * elements the page already has, so the stream reads the same either way.
 *
 * CRC is CRC-16/XMODEM (poly 0x1021, init 0), the one the PACSAT tools use.
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------ framing */
  var CRC_TABLE = (function () {
    var t = new Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i << 8;
      for (var k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
      t[i] = c;
    }
    return t;
  })();
  function crc16(str) {
    var c = 0;
    for (var i = 0; i < str.length; i++) c = ((c << 8) & 0xffff) ^ CRC_TABLE[((c >> 8) ^ (str.charCodeAt(i) & 0xff)) & 0xff];
    return c;
  }
  function hex4(n) { return ('0000' + n.toString(16)).slice(-4); }
  function encode(seq, src, text) {
    var body = seq + ' ' + src + ' ' + text;
    return body + ' *' + hex4(crc16(body));
  }
  function decode(line) {
    var m = /^(\d+) (\S+) (.*) \*([0-9a-f]{4})$/.exec(line);
    if (!m) return null;
    var body = m[1] + ' ' + m[2] + ' ' + m[3];
    if (hex4(crc16(body)) !== m[4]) return { seq: +m[1], src: m[2], text: m[3], bad: true };
    return { seq: +m[1], src: m[2], text: m[3], bad: false };
  }

  /* --------------------------------------------------------- utilities */
  function z(n, w) { return String(n).padStart(w || 2, '0'); }
  function stampUtc(d) { return d.toISOString().slice(0, 10) + ' ' + d.toISOString().slice(11, 19) + 'Z'; }
  function dur(sec) { sec = Math.max(0, Math.round(sec)); var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return (h ? z(h) + ':' : '') + z(m) + ':' + z(s); }
  function hms(d) { return d.toISOString().slice(11, 19) + 'Z'; }
  function jitter(base, frac) { return base * (1 + (Math.random() * 2 - 1) * (frac === undefined ? 0.35 : frac)); }
  function fmtKm(n) { return Math.round(n).toLocaleString('en-US').replace(/,/g, ' ') + ' km'; }

  /* ------------------------------------------------------ local daemon */
  /**
   * The idle scheduler. `ctx()` returns the live orbital state the page already
   * computes: { now, look:{az,el,range}, rx (MHz), sunlit, next (pass or null),
   * nextUsable (pass ≥ minEl or null), tleAge (days), tleEpoch (string),
   * target:{name,norad,f0}, minEl }.
   */
  function LocalDaemon(ctx, emit) {
    var seq = 0;
    var floor = -104.2;                    // dBFS, wanders slowly
    var temp = 42.4;                       // Pluto XADC, °C
    var timers = [];
    var inPass = false, passSeen = null, lastTrack = 0;
    var at = null;                         // set while replaying the tail of the log

    function say(src, text, cls) { seq++; emit({ seq: seq, src: src, text: text, cls: cls || null, ts: at || ctx().now, raw: encode(seq, src, text) }); }

    function every(sec, fn, first) {
      var handle = { t: null };
      function tick() { try { fn(); } catch (e) { /* the stream is best-effort */ } handle.t = setTimeout(tick, jitter(sec) * 1000); }
      handle.t = setTimeout(tick, (first === undefined ? jitter(sec) : first) * 1000);
      timers.push(handle);
    }

    var lines = {
      boot: function () {
        var c = ctx();
        say('ops', 'ops 0.2.1 · station ' + c.station + ' · host ' + c.host + ' · target ' + c.target.name + ' (' + c.target.norad + ')');
        say('ops', 'elements ' + c.elementsCached + ' cached · ' + c.target.norad + ' epoch ' + c.tleEpoch + ' (' + c.tleAge.toFixed(1) + ' d)');
        say('rotctld', '127.0.0.1:4533 · model 1 · parked 0.0 0.0 · RPRT 0', 'hb');
        say('gqrx', '127.0.0.1:7356 · f ' + Math.round(c.target.f0 * 1e6) + ' · M USB 2400 · RPRT 0', 'hb');
        say('sched', 'mode unattended · min el ' + c.minEl + '° · queue 1 (' + c.target.name + ')');
      },
      idle: function () {
        var c = ctx();
        if (c.nextUsable) {
          say('ops', 'idle · next ' + c.target.name + ' ≥' + c.minEl + '° ' + hms(c.nextUsable.aos) + ' in ' + dur((c.nextUsable.aos - c.now) / 1000) + ' · max el ' + c.nextUsable.maxEl.toFixed(0) + '°' +
            (c.next && c.next !== c.nextUsable && c.next.aos > c.now ? ' · ' + hms(c.next.aos).slice(0, 5) + 'Z (' + c.next.maxEl.toFixed(0) + '°) skipped' : ''));
        } else say('ops', 'idle · no usable pass in 48 h');
      },
      rot: function () { say('rotctld', 'p → 0.0 0.0 · RPRT 0', 'hb'); },
      lvl: function () {
        floor += (Math.random() - 0.5) * 0.6; if (floor < -106) floor = -106; if (floor > -101) floor = -101;
        say('gqrx', 'l STRENGTH → ' + floor.toFixed(1) + ' dBFS', 'hb');
      },
      det: function () {
        var c = ctx();
        say('detect', 'floor ' + floor.toFixed(1) + ' dBFS · threshold +8 dB · nothing above · ' + (c.look.el > 0 ? 'target above horizon' : 'target below horizon'), 'hb');
      },
      tle: function () {
        var c = ctx();
        say('tle', c.target.norad + ' epoch ' + c.tleEpoch + ' (' + c.tleAge.toFixed(1) + ' d) · ' + (c.tleAge < 3 ? 'ok' : 'stale, refresh pending'), c.tleAge < 3 ? 'hb' : 'warn');
      },
      pluto: function () {
        temp += (Math.random() - 0.5) * 0.4; if (temp < 39) temp = 39; if (temp > 47) temp = 47;
        say('pluto', 'xadc ' + temp.toFixed(1) + ' °C · fs 2.0 MSPS · gain 40 dB', 'hb');
      },
      sched: function () {
        var c = ctx();
        say('sched', 'queue 1 · satnogs jobs 0 · kiss/ ' + c.kissFiles + ' files · disk ok', 'hb');
      },
      track: function () {
        var c = ctx();
        if (!c.next) return;
        var now = c.now, p = c.next;
        var up = p.aos <= now && p.los > now;
        if (up && p.maxEl < c.minEl) return;                       // low passes are not tracked
        if (up && !inPass) { inPass = true; passSeen = p; say('ops', 'AOS · ' + c.target.name + ' · max el ' + p.maxEl.toFixed(1) + '° · az ' + p.aosAz.toFixed(0) + ' → ' + p.losAz.toFixed(0)); }
        if (up) {
          if (now - lastTrack > 29000) {
            lastTrack = now;
            var dop = (c.rx - c.target.f0) * 1000;
            say('rotctld', 'P ' + c.look.az.toFixed(1) + ' ' + Math.max(0, c.look.el).toFixed(1) + ' · RPRT 0', 'hb');
            say('gqrx', 'F ' + Math.round(c.rx * 1e6) + ' · RPRT 0 · dop ' + (dop >= 0 ? '+' : '') + dop.toFixed(2) + ' kHz', 'hb');
          }
        } else if (inPass) {
          inPass = false;
          say('ops', 'LOS · frames 0 · carrier -- · unattended pass, recording kept');
          say('rotctld', 'P 0.0 0.0 · park · RPRT 0', 'hb');
        }
      }
    };

    /** The page opens on the tail of the log, not on an empty screen: replay the last ~40 min. */
    function backfill(minutes) {
      var now = ctx().now.getTime(), t = now - minutes * 60000;
      var sched = [['idle', 90], ['rot', 70], ['lvl', 40], ['det', 120], ['pluto', 300], ['sched', 240]];
      var nextAt = {};
      sched.forEach(function (s) { nextAt[s[0]] = t + jitter(s[1]) * 1000; });
      at = new Date(t); lines.boot();
      while (t < now - 2000) {
        var name = null, best = Infinity;
        sched.forEach(function (s) { if (nextAt[s[0]] < best) { best = nextAt[s[0]]; name = s[0]; } });
        t = best; at = new Date(t);
        ctx(at);
        lines[name]();
        nextAt[name] = t + jitter(sched.filter(function (s) { return s[0] === name; })[0][1]) * 1000;
      }
      at = null; ctx();
    }

    return {
      start: function () {
        backfill(40);
        every(90, lines.idle, 6);
        every(70, lines.rot);
        every(40, lines.lvl, 3);
        every(120, lines.det, 14);
        every(900, lines.tle, 40);
        every(300, lines.pluto, 25);
        every(240, lines.sched, 60);
        every(1, lines.track, 1);
      },
      stop: function () { timers.forEach(function (h) { clearTimeout(h.t); }); },
      decode: decode, encode: encode, crc16: crc16
    };
  }

  /* --------------------------------------------------------- relay link */
  function RelayLink(url, emit, onState) {
    var ws = null, backoff = 2, seqSeen = 0, closed = false;
    function connect() {
      if (closed) return;
      try { ws = new WebSocket(url); } catch (e) { onState('error'); return retry(); }
      ws.onopen = function () { backoff = 2; onState('open'); };
      ws.onmessage = function (ev) {
        String(ev.data).split('\n').forEach(function (line) {
          var f = decode(line.trim());
          if (!f) return;
          if (f.bad) { emit({ seq: f.seq, src: 'link', text: 'bad crc on frame ' + f.seq + ', dropped', cls: 'warn', ts: new Date(), raw: line }); return; }
          if (f.seq <= seqSeen) return;
          seqSeen = f.seq;
          emit({ seq: f.seq, src: f.src, text: f.text, cls: null, ts: new Date(), raw: line });
        });
      };
      ws.onclose = function () { onState('closed'); retry(); };
      ws.onerror = function () { onState('error'); };
    }
    function retry() { if (closed) return; setTimeout(connect, backoff * 1000); backoff = Math.min(backoff * 2, 120); }
    return { start: connect, stop: function () { closed = true; if (ws) ws.close(); }, decode: decode, encode: encode, crc16: crc16 };
  }

  /** Pick the transport from the page state: a relay URL if one is configured, the local daemon otherwise. */
  function open(state, ctx, emit, onState) {
    if (state && typeof state.link === 'string' && /^wss?:\/\//.test(state.link)) return RelayLink(state.link, emit, onState || function () {});
    return LocalDaemon(ctx, emit);
  }

  global.StationLink = { open: open, crc16: crc16, encode: encode, decode: decode, stampUtc: stampUtc };
})(window);
