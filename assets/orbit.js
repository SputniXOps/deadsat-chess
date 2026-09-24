/*!
 * DeadSat Chess — orbit helpers on top of satellite.js (SGP4).
 * Works in the browser (window.DeadSatOrbit) and in node (module.exports),
 * so the same code that drives the page also generates the recorded sessions.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('satellite.js'));
  else root.DeadSatOrbit = factory(root.satellite);
})(typeof self !== 'undefined' ? self : this, function (satellite) {
  'use strict';

  var RE = 6378.137;          // km
  var MU = 398600.4418;       // km^3/s^2
  var C = 299792.458;         // km/s
  var AU = 149597870.7;       // km
  var DEG = Math.PI / 180;

  function parse(line1, line2) {
    var rec = satellite.twoline2satrec(line1, line2);
    if (rec.error) return null;
    return rec;
  }

  /** Orbit summary from a satrec: a, e, i, period, perigee, apogee (km / min / deg). */
  function summary(rec) {
    var nRadMin = rec.no;                         // rad/min (SGP4 mean motion)
    var nRadS = nRadMin / 60;
    var a = Math.pow(MU / (nRadS * nRadS), 1 / 3);
    var e = rec.ecco;
    return {
      a: a, e: e, i: rec.inclo / DEG,
      period: 2 * Math.PI / nRadMin,
      perigee: a * (1 - e) - RE,
      apogee: a * (1 + e) - RE,
      revs: nRadMin * 1440 / (2 * Math.PI),
      epoch: epochDate(rec)
    };
  }

  function epochDate(rec) {
    // satrec.jdsatepoch is the Julian date of the epoch
    return new Date((rec.jdsatepoch - 2440587.5) * 86400000);
  }

  /** Orbit class from the elements. Declared class wins for graveyard/decaying edge cases. */
  function classify(rec, declared) {
    var s = summary(rec);
    var geoP = Math.abs(s.period - 1436.07) < 40;
    if (s.perigee < 250) return 'DECAYING';
    if (s.e > 0.25) return 'HEO';
    if (geoP) {
      if (s.perigee > 35786 + 150) return 'GRAVEYARD';
      if (declared === 'GRAVEYARD') return 'GRAVEYARD';
      return s.i < 3 ? 'GEO' : 'GSO';
    }
    if (s.apogee > 35586 + 300 && s.perigee > 35586) return 'GRAVEYARD';
    if (s.apogee < 2000) return 'LEO';
    return 'MEO';
  }

  /** ECI position/velocity (km, km/s) at a Date, or null if SGP4 fails. */
  function eci(rec, date) {
    var pv = satellite.propagate(rec, date);
    if (!pv || !pv.position || typeof pv.position !== 'object') return null;
    return pv;
  }

  /** Earth-fixed state: x,y,z (km), lat/lon (deg), alt (km). */
  function ecf(rec, date) {
    var pv = eci(rec, date);
    if (!pv) return null;
    var g = satellite.gstime(date);
    var p = satellite.eciToEcf(pv.position, g);
    var geo = satellite.eciToGeodetic(pv.position, g);
    return {
      x: p.x, y: p.y, z: p.z,
      r: Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z),
      lat: geo.latitude / DEG, lon: geo.longitude / DEG, alt: geo.height,
      gmst: g, eci: pv
    };
  }

  /** Inertial orbit over one period, expressed in the Earth-fixed frame *of the given instant*
      (a closed ellipse around the planet, the way a tracking display draws it). */
  function orbitRing(rec, date, steps) {
    var s = summary(rec);
    var g = satellite.gstime(date);
    var out = [];
    var n = steps || 180;
    for (var k = 0; k <= n; k++) {
      var t = new Date(date.getTime() + (s.period * 60000) * (k / n - 0.5));
      var pv = eci(rec, t);
      if (!pv) continue;
      var p = satellite.eciToEcf(pv.position, g);
      var r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
      out.push({ x: p.x, y: p.y, z: p.z, r: r, alt: r - RE, k: k / n });
    }
    return out;
  }

  /** Sub-satellite track from -half to +half period (Earth-fixed, dashed on the map). */
  function groundTrack(rec, date, steps) {
    var s = summary(rec);
    var out = [];
    var n = steps || 200;
    for (var k = 0; k <= n; k++) {
      var t = new Date(date.getTime() + (s.period * 60000) * (k / n - 0.5));
      var e = ecf(rec, t);
      if (e) out.push({ lat: e.lat, lon: e.lon, k: k / n });
    }
    return out;
  }

  function observerGd(obs) {
    return { latitude: obs.lat * DEG, longitude: obs.lon * DEG, height: (obs.alt_m || 0) / 1000 };
  }

  /** Azimuth / elevation / range (deg, km) and range rate (km/s) from an observer. */
  function look(rec, obs, date) {
    var pv = eci(rec, date);
    if (!pv) return null;
    var g = satellite.gstime(date);
    var pEcf = satellite.eciToEcf(pv.position, g);
    var la = satellite.ecfToLookAngles(observerGd(obs), pEcf);
    // range rate by finite difference (1 s), good to a few cm/s
    var pv2 = eci(rec, new Date(date.getTime() + 1000));
    var rate = null;
    if (pv2) {
      var g2 = satellite.gstime(new Date(date.getTime() + 1000));
      var la2 = satellite.ecfToLookAngles(observerGd(obs), satellite.eciToEcf(pv2.position, g2));
      rate = la2.rangeSat - la.rangeSat;
    }
    return { az: ((la.azimuth / DEG) + 360) % 360, el: la.elevation / DEG, range: la.rangeSat, rate: rate };
  }

  /** Received frequency for a transmit frequency (MHz) given range rate (km/s). */
  function doppler(fMHz, rate) {
    if (rate === null || rate === undefined) return fMHz;
    return fMHz * (1 - rate / C);
  }

  /** Low-precision sun vector in ECI (km). Vallado, Algorithm 29. */
  function sunEci(date) {
    var jd = date.getTime() / 86400000 + 2440587.5;
    var T = (jd - 2451545.0) / 36525;
    var lm = (280.460 + 36000.771 * T) % 360;
    var M = ((357.5291092 + 35999.05034 * T) % 360) * DEG;
    var lam = (lm + 1.914666471 * Math.sin(M) + 0.019994643 * Math.sin(2 * M)) * DEG;
    var eps = (23.439291 - 0.0130042 * T) * DEG;
    var r = (1.000140612 - 0.016708617 * Math.cos(M) - 0.000139589 * Math.cos(2 * M)) * AU;
    return { x: r * Math.cos(lam), y: r * Math.cos(eps) * Math.sin(lam), z: r * Math.sin(eps) * Math.sin(lam) };
  }

  /** True when the satellite is inside the Earth's (cylindrical) shadow. */
  function inShadow(rec, date) {
    var pv = eci(rec, date);
    if (!pv) return null;
    var s = pv.position, u = sunEci(date);
    var um = Math.sqrt(u.x * u.x + u.y * u.y + u.z * u.z);
    var ux = u.x / um, uy = u.y / um, uz = u.z / um;
    var proj = s.x * ux + s.y * uy + s.z * uz;
    if (proj > 0) return false;
    var px = s.x - proj * ux, py = s.y - proj * uy, pz = s.z - proj * uz;
    return Math.sqrt(px * px + py * py + pz * pz) < RE;
  }

  /**
   * Passes above the horizon for an observer between two Dates.
   * Coarse 20 s scan, then the AOS/LOS edges are refined to 1 s.
   */
  function passes(rec, obs, from, to, minEl) {
    var out = [];
    var step = 20000;
    var t = from.getTime(), end = to.getTime();
    var prev = look(rec, obs, new Date(t));
    var cur = null, best = null;
    var lim = minEl || 0;
    function refine(t0, t1, rising) {
      // t0 below/above, t1 above/below; bisect to 1 s
      var a = t0, b = t1;
      while (b - a > 1000) {
        var m = Math.round((a + b) / 2);
        var l = look(rec, obs, new Date(m));
        if (!l) break;
        if ((l.el > lim) === rising) b = m; else a = m;
      }
      return rising ? b : a;
    }
    for (t += step; t <= end; t += step) {
      var l = look(rec, obs, new Date(t));
      if (!l || !prev) { prev = l; continue; }
      if (l.el > lim && prev.el <= lim) {
        var aos = refine(t - step, t, true);
        var la = look(rec, obs, new Date(aos));
        cur = { aos: new Date(aos), aosAz: la.az, maxEl: -90, tca: null, tcaAz: 0, tcaRange: 0 };
        best = null;
      }
      if (cur) {
        if (l.el > cur.maxEl) { cur.maxEl = l.el; cur.tca = new Date(t); cur.tcaAz = l.az; cur.tcaRange = l.range; }
        if (l.el <= lim && prev.el > lim) {
          var los = refine(t - step, t, false);
          var ll = look(rec, obs, new Date(los));
          cur.los = new Date(los); cur.losAz = ll.az;
          cur.duration = (cur.los - cur.aos) / 1000;
          out.push(cur); cur = null;
        }
      }
      prev = l;
    }
    return out;
  }

  return {
    RE: RE, C: C,
    parse: parse, summary: summary, classify: classify, epochDate: epochDate,
    eci: eci, ecf: ecf, orbitRing: orbitRing, groundTrack: groundTrack,
    look: look, doppler: doppler, sunEci: sunEci, inShadow: inShadow, passes: passes,
    gmst: function (d) { return satellite.gstime(d); }
  };
});
