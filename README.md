# DeadSat Atlas

A small experiment for exploring inactive and historically interesting
objects still in Earth orbit.

Orbital data comes from public sources. RF metadata is incomplete and
experimental. The station side is receive-only.

## What is on the page

- **Atlas** — an orthographic globe with every object in `data/objects.json`
  that has cached elements, propagated with SGP4 in real time. Click an object
  for its orbit, its sub-satellite track and a record card (identifiers, orbit,
  RF notes, next pass over the observer).
- **Candidates** — old birds with an onboard computer that was, at some point,
  meant to accept software from the ground. Ranked; the ranking is an opinion.
- **One move** — a board, the last recorded listening session at EU-01, and a
  live block that is nothing more than prediction from cached elements
  (az/el, Doppler-corrected downlink, illumination, next pass). The page is
  not connected to the station.
- **Station** — hardware and rules.

## Stack

- plain HTML / CSS / JS, no build step
- [satellite.js](https://github.com/shashwatak/satellite-js) 5.0 (SGP4), vendored in `assets/vendor/`
- Canvas 2D globe (`assets/globe.js`), coastlines from Natural Earth
- IBM Plex Sans / Mono from Google Fonts

## Data sources

- Elements: [CelesTrak](https://celestrak.org/) GP API, with
  [SatNOGS DB](https://db.satnogs.org/) as fallback
- Observations for cross-checks: [SatNOGS Network](https://network.satnogs.org/)
- Identifiers and history: CelesTrak, Space-Track, UNOOSA, AMSAT, operator
  archives, amateur reports (listed per record)

`data/objects.json` holds the catalogue metadata. `data/tle.json` holds cached
elements. `scripts/fetch_tle.py` refreshes them (standard library only):

```bash
python3 scripts/fetch_tle.py
```

The GitHub Actions workflow runs the same script daily at build time, so the
deployed site never serves elements older than a day. CelesTrak updates GP
data every two hours; do not run the script more often than that.

## Development

`fetch()` needs HTTP rather than `file://`:

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

## Layout

```
index.html
assets/        app.js, globe.js, orbit.js, chess.js, session.js, css, vendor/
data/          objects.json, tle.json, sessions.json, state.json, land.json
scripts/       fetch_tle.py
.github/       Pages workflow
```

## Notes on the records

Names, NORAD and COSPAR identifiers are public record. Status, RF history and
"last report" fields are compiled from public reports and are incomplete.
A documented historical frequency does not imply a current signal, and a
current signal does not imply a control path. Verify against a current
catalogue before repeating a factual claim about a named spacecraft.
