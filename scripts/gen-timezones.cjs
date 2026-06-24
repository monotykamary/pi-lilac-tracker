// Offline generator: project Natural Earth civil timezones to Mercator SVG
// paths, grouped by standard UTC offset. Produces ONE path per offset whose
// subpaths are the actual political territories (China +8 spans 73°E–135°E,
// India +5:30 is one polygon, Nepal +5:45 another…). This replaces the old
// straight Voronoi longitude bands with real country boundaries.
//
// Standard offsets only (the `zone` field) — no DST. Matches the "civil
// reference" philosophy of the overlay. Uses d3-geo at build time ONLY; the
// output (src/data/timezones.ts) is self-contained path strings, so the web
// app keeps zero runtime geo deps.
//
// The projection constants here MUST match scripts/gen-world-land.cjs and
// src/components/DiscountMercator.tsx.
//
// Usage:
//   node scripts/gen-timezones.cjs
const fs = require('fs');
const path = require('path');
const d3 = require('d3-geo');

// ---- projection constants (mirror gen-world-land.cjs) ----
const ML = 40, MR = 12, MT = 12, MB = 26;
const VIEW_W = 1000;
const PLOT_W = VIEW_W - ML - MR;            // 948
const LAT_CLIP = 60;
const yMerc = (latDeg) => Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI / 180) / 2));
const Y_LO = yMerc(-LAT_CLIP), Y_HI = yMerc(LAT_CLIP);
const PLOT_H = Math.round((PLOT_W / (2 * Math.PI)) * (Y_HI - Y_LO));
const SCALE = PLOT_W / (2 * Math.PI);
const projection = d3.geoMercator()
  .scale(SCALE)
  .translate([ML + PLOT_W / 2, MT + PLOT_H / 2])
  .clipExtent([[ML, MT], [ML + PLOT_W, MT + PLOT_H]]);

// Douglas-Peucker tolerance in DEGREES. 0.5° ≈ 0.8px at the equator on this
// map — visually lossless, but slashes coordinate counts (coastlines that
// are straight at this zoom collapse to 2 points).
const SIMPLIFY_TOL = 0.5;

const ROOT = path.resolve(__dirname, '..');
const GEO_FILE = path.join(ROOT, 'scripts/ne_10m_time_zones.geojson');
const OUT_FILE = path.join(ROOT, 'src/data/timezones.ts');
const GEO_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_time_zones.geojson';

function loadGeo() {
  if (!fs.existsSync(GEO_FILE)) {
    console.log('Fetching ' + GEO_URL + ' ...');
    const { execSync } = require('child_process');
    execSync('curl -sL --fail "' + GEO_URL + '" -o "' + GEO_FILE + '"');
  }
  return JSON.parse(fs.readFileSync(GEO_FILE, 'utf8'));
}

// ── Douglas-Peucker in geographic space ─────────────────────────────────────
// Natural Earth timezones are pre-split at the antimeridian, so per-ring DP
// in lon/lat is safe (no segment crosses ±180°).
function simplifyRing(ring, tol) {
  if (ring.length <= 4) return ring;
  const perpDist = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  };
  const keep = new Array(ring.length).fill(false);
  keep[0] = true; keep[ring.length - 1] = true;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(ring[i], ring[lo], ring[hi]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx > 0 && maxD > tol) {
      keep[idx] = true;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}
function simplifyGeom(geom, tol) {
  if (geom.type === 'Polygon') {
    return { type: 'Polygon', coordinates: geom.coordinates.map((r) => simplifyRing(r, tol)) };
  }
  if (geom.type === 'MultiPolygon') {
    return { type: 'MultiPolygon', coordinates: geom.coordinates.map((poly) => poly.map((r) => simplifyRing(r, tol))) };
  }
  return geom;
}

// Reference meridian for an offset: L = offset_hours × 15°, wrapped to [-180,180).
const wrapLon = (lon) => (((lon + 180) % 360) + 360) % 360 - 180;

// Build a concise places label per offset (dedupe segments, drop open-ocean
// and research-station noise so the label stays country-focused).
function cleanPlaces(features) {
  const seen = new Set();
  const out = [];
  for (const f of features) {
    const segs = (f.properties.places || '').split(';').map((s) => s.trim()).filter(Boolean);
    for (const s of segs) {
      if (/ocean/i.test(s) || /\bstation\b/i.test(s) || /^antarctica$/i.test(s)) continue;
      if (!seen.has(s)) { seen.add(s); out.push(s); }
    }
  }
  let s = out.join('; ');
  if (s.length > 95) s = s.slice(0, 92) + '…';
  return s || '(open ocean)';
}

const fc = loadGeo();

// Group features by standard offset (the `zone` field, in hours).
const byOffset = new Map();
for (const f of fc.features) {
  const z = f.properties.zone;
  if (z == null || Number.isNaN(z)) continue;
  if (!byOffset.has(z)) byOffset.set(z, []);
  byOffset.get(z).push({
    type: 'Feature',
    properties: { places: f.properties.places },
    geometry: simplifyGeom(f.geometry, SIMPLIFY_TOL),
  });
}

const offsets = [...byOffset.keys()].sort((a, b) => a - b);
const paths = [];
const placesArr = [];
const refLons = [];
const xLo = [];
const xHi = [];
for (const z of offsets) {
  const feats = byOffset.get(z);
  const collection = { type: 'FeatureCollection', features: feats };
  const pathStr = d3.geoPath(projection)(collection);
  paths.push(pathStr || '');
  placesArr.push(cleanPlaces(feats));
  refLons.push(Math.round(wrapLon(z * 15) * 1000) / 1000);
  // Projected bbox x-range — lets the component draw the reference meridian
  // only when it actually passes through the territory (the China +8 case),
  // skipping confusing far-away lines for antimeridian-wrap zones (+12/+13/+14).
  const b = d3.geoPath(projection).bounds(collection);
  xLo.push(Math.round(b[0][0] * 10) / 10);
  xHi.push(Math.round(b[1][0] * 10) / 10);
}

const totalLen = paths.reduce((a, p) => a + p.length, 0);
console.log('offsets:', offsets.length, '| total path chars:', totalLen, '| avg:', Math.round(totalLen / offsets.length));
console.log('offsets list:', offsets.join(', '));

const out = `// Auto-generated civil timezone territories (Natural Earth ne_10m_time_zones).
// Projected with d3-geo Mercator (antimeridian-cut) to the viewBox used by DiscountMercator.tsx.
// Standard civil offsets (the \`zone\` field, NO DST). One path per offset; each path's
// subpaths are the real political territories (China +8 spans 73°E–135°E — the "backtrack").
// Do not edit by hand. Regenerate via scripts/gen-timezones.cjs.
export const TIMEZONE_OFFSETS: number[] = ${JSON.stringify(offsets)};
export const TIMEZONE_PATHS: string[] = ${JSON.stringify(paths)};
export const TIMEZONE_PLACES: string[] = ${JSON.stringify(placesArr)};
export const TIMEZONE_REF_LON: number[] = ${JSON.stringify(refLons)};
export const TIMEZONE_X_LO: number[] = ${JSON.stringify(xLo)};
export const TIMEZONE_X_HI: number[] = ${JSON.stringify(xHi)};
`;

fs.writeFileSync(OUT_FILE, out);
console.log('written ' + OUT_FILE + ' (' + (out.length / 1024).toFixed(0) + ' KB)');
