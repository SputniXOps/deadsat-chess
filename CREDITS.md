# Credits and data sources

## Orbital elements

Two-line element sets in `data/tle.json` are fetched from the CelesTrak GP API
(https://celestrak.org/) and, as a fallback, the SatNOGS DB API
(https://db.satnogs.org/, CC BY-SA). Both sources publish Space-Track data.

## Coastlines

`data/land.json` is derived from Natural Earth 1:110 000 000 land, obtained
through the world-atlas package and converted to a flat ring list at 0.1°
precision. Natural Earth is in the public domain.

## Satellite records

Names and NORAD / COSPAR identifiers are public record (CelesTrak, Space-Track,
UNOOSA). Status and RF notes are compiled from AMSAT, AMSAT-UK, AMSAT-DL,
operator archives and amateur reports; each record lists its sources.

## Code

- satellite.js 5.0 (MIT) — `assets/vendor/satellite.min.js`
- everything else in `assets/` is original and yours to use

## Typefaces

IBM Plex Sans and IBM Plex Mono (SIL Open Font License 1.1), via Google Fonts.
