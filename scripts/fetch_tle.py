#!/usr/bin/env python3
"""
Refresh cached orbital data for DeadSat Chess.

  data/tle.json        elements for every object in data/objects.json
  data/tle_field.json  the CelesTrak 'amateur' group, drawn as background marks
  data/satnogs.json    most recent 'good' SatNOGS observation per watchlist object

Sources: CelesTrak GP API (primary), SatNOGS DB (fallback), SatNOGS Network.
CelesTrak refreshes GP data every two hours and blocks aggressive clients, so
this script sleeps between requests. Run it once a day, not more.

Standard library only. Python 3.8+.
"""
import json
import sys
import time
import urllib.request
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UA = "deadsat-chess/0.2 (+https://github.com/SputniXOps/deadsat-chess; static site data refresh)"
CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php?{}"
SATNOGS_TLE = "https://db.satnogs.org/api/tle/?norad_cat_id={}&format=json"
SATNOGS_OBS = "https://network.satnogs.org/api/observations/?satellite__norad_cat_id={}&status=good&format=json"
SLEEP = 1.5


def get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def checksum(line):
    s = 0
    for ch in line[:68]:
        if ch.isdigit():
            s += int(ch)
        elif ch == "-":
            s += 1
    return s % 10


def valid(l1, l2):
    return (len(l1) == 69 and len(l2) == 69 and l1[0] == "1" and l2[0] == "2"
            and checksum(l1) == int(l1[68]) and checksum(l2) == int(l2[68]))


def epoch_iso(l1):
    yy = int(l1[18:20])
    doy = float(l1[20:32])
    year = 2000 + yy if yy < 57 else 1900 + yy
    return (datetime(year, 1, 1, tzinfo=timezone.utc) + timedelta(days=doy - 1)).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_tle_text(text):
    lines = [l.rstrip("\r\n") for l in text.splitlines() if l.strip()]
    out = {}
    i = 0
    while i < len(lines):
        if lines[i].startswith("1 ") and i + 1 < len(lines) and lines[i + 1].startswith("2 "):
            name = lines[i - 1].strip() if i > 0 and not lines[i - 1].startswith(("1 ", "2 ")) else ""
            l1, l2 = lines[i], lines[i + 1]
            if valid(l1, l2):
                out[str(int(l1[2:7]))] = {"name": name, "line1": l1, "line2": l2}
            i += 2
        else:
            i += 1
    return out


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load(path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def fetch_one(norad, name):
    # CelesTrak first
    try:
        txt = get(CELESTRAK.format(urllib.parse.urlencode({"CATNR": norad, "FORMAT": "TLE"})))
        got = parse_tle_text(txt)
        if norad in got:
            rec = got[norad]
            rec.update(source="CelesTrak", updated=now_iso(), epoch=epoch_iso(rec["line1"]))
            if not rec["name"]:
                rec["name"] = name
            return rec
    except Exception as e:  # noqa: BLE001
        print(f"  celestrak {norad}: {e}", file=sys.stderr)
    time.sleep(SLEEP)
    # SatNOGS DB fallback
    try:
        arr = json.loads(get(SATNOGS_TLE.format(norad)))
        if arr:
            t = arr[0]
            l1, l2 = t["tle1"], t["tle2"]
            if valid(l1, l2):
                return {"name": name, "line1": l1, "line2": l2, "source": "SatNOGS DB (" + t.get("tle_source", "?") + ")",
                        "updated": now_iso(), "epoch": epoch_iso(l1)}
    except Exception as e:  # noqa: BLE001
        print(f"  satnogs {norad}: {e}", file=sys.stderr)
    return None


def main():
    cat = load(DATA / "objects.json", {"objects": []})
    tle = load(DATA / "tle.json", {"items": {}})
    tle.setdefault("items", {})
    tle["note"] = "Two-line element sets cached from public sources. Refresh with scripts/fetch_tle.py (CelesTrak GP API, SatNOGS DB fallback)."

    ok = 0
    for o in cat["objects"]:
        nid = str(int(o["id"]))
        rec = fetch_one(nid, o["name"])
        if rec:
            tle["items"][nid] = rec
            ok += 1
            print(f"  {nid:>6} {o['name']:<14} {rec['source']}  epoch {rec['epoch']}")
        else:
            print(f"  {nid:>6} {o['name']:<14} kept cached" if nid in tle["items"] else f"  {nid:>6} {o['name']:<14} no elements")
        time.sleep(SLEEP)
    tle["fetched"] = now_iso()
    (DATA / "tle.json").write_text(json.dumps(tle, indent=1) + "\n")
    print(f"tle.json: {ok} refreshed, {len(tle['items'])} total")

    # background field: CelesTrak amateur group
    try:
        txt = get(CELESTRAK.format(urllib.parse.urlencode({"GROUP": "amateur", "FORMAT": "TLE"})))
        got = parse_tle_text(txt)
        field = {"note": "CelesTrak 'amateur' group, used as unlabeled background marks. Refreshed by scripts/fetch_tle.py.",
                 "fetched": now_iso(), "source": "CelesTrak", "items": got}
        (DATA / "tle_field.json").write_text(json.dumps(field, indent=0) + "\n")
        print(f"tle_field.json: {len(got)} objects")
    except Exception as e:  # noqa: BLE001
        print(f"  amateur group: {e}", file=sys.stderr)

    # SatNOGS: last good observation for watchlist objects
    obs = load(DATA / "satnogs.json", {"items": {}})
    obs.setdefault("items", {})
    for o in cat["objects"]:
        if not o.get("watch"):
            continue
        nid = str(int(o["id"]))
        try:
            arr = json.loads(get(SATNOGS_OBS.format(nid), timeout=60))
            arr = [a for a in arr if str(a.get("norad_cat_id")) == nid and a.get("status") == "good"]
            if arr:
                a = arr[0]
                obs["items"][nid] = {k: a.get(k) for k in ("id", "start", "end", "station_name", "ground_station",
                                                            "max_altitude", "transmitter_description", "observation_frequency",
                                                            "status", "waterfall_status")}
                print(f"  satnogs {nid}: obs {a['id']} {a['start']} {a.get('station_name')}")
        except Exception as e:  # noqa: BLE001
            print(f"  satnogs obs {nid}: {e}", file=sys.stderr)
        time.sleep(SLEEP)
    obs["fetched"] = now_iso()
    obs["note"] = "Most recent SatNOGS Network observation with status 'good' per watchlist object. CC BY-SA, SatNOGS."
    (DATA / "satnogs.json").write_text(json.dumps(obs, indent=1) + "\n")


if __name__ == "__main__":
    main()
