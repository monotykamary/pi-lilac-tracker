// Offline generator: project land-110m to a Mercator SVG path, with the
// antimeridian (±180°) properly cut so polygons that wrap the date line
// (Russia/Chukchi, Fiji) don't draw horizontal bridges across the map.
//
// POLES: Antarctica (everything south of 60°S — no countries) and the north
// polar cap (everything north of 82°N — only Arctic Ocean, no countries) are
// dropped at the polygon level before projection. The map extends north to
// 82°N so Iceland, Greenland, Svalbard, Franz Josef Land, Novaya Zemlya,
// Severnaya Zemlya and the northern extents of Russia/Scandinavia/Alaska/
// Canada stay visible. The south stays at 60°S (nothing but ocean below).
//
// POLAR SQUISH: true Mercator inflates the 60→82°N band to ~202px, which would
// make the map tall and visually compress the equatorial mid-latitudes. So the
// band is projected honestly (antimeridian-cut, clipExtent-trimmed) and then
// its y-coordinates are squished into a 120px strip above the unchanged ±60°
// core. Only y is rewritten; x is untouched, so antimeridian cuts stay
// vertical. The squish MUST match yForLat() in DiscountMercator.tsx.
//
// Uses d3-geo at build time ONLY — the output (src/data/worldLand.ts) is a
// self-contained SVG path string, so the web app has zero runtime deps.
//
// Usage:
//   node scripts/gen-world-land.cjs
const fs = require('fs');
const path = require('path');
const d3 = require('d3-geo');
const { feature } = require('topojson-client');

// ---- projection constants (mirror the component & gen-timezones.cjs) ----
const ML = 12, MR = 12, MT = 12, MB = 26;
const VIEW_W = 972;
const PLOT_W = VIEW_W - ML - MR;            // 948
const SOUTH_CLIP = -60;                      // drop everything below (Antarctica)
const CORE_CLIP = 60;                        // core Mercator spans ±60°
const NORTH_CLIP = 82;                       // extend north to here (then squish)
const BAND_H = 120;                          // squished height of the 60→82°N band

const yMerc = (latDeg) => Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI / 180) / 2));
const SCALE = PLOT_W / (2 * Math.PI);
const m60 = yMerc(CORE_CLIP), m82 = yMerc(NORTH_CLIP);
const CORE_H = SCALE * (m60 - yMerc(-CORE_CLIP));     // true-mercator height of ±60° core
const HONEST_NORTH = SCALE * (m82 - m60);             // true-mercator height of 60→82° band
const HONEST_TOTAL = HONEST_NORTH + CORE_H;           // true-mercator height of -60..82
const PLOT_H = BAND_H + CORE_H;
const VIEW_H = MT + PLOT_H + MB;

// Asymmetric true-Mercator: lat 82 → top (MT), lat -60 → bottom (MT+HONEST_TOTAL).
// d3's default clipAntimeridian cuts wrapping polygons at ±180° BEFORE projection.
// clipExtent then trims everything outside the honest -60..82 rect.
const projection = d3.geoMercator()
  .scale(SCALE)
  .translate([ML + PLOT_W / 2, MT + SCALE * m82])
  .clipExtent([[ML, MT], [ML + PLOT_W, MT + HONEST_TOTAL]]);

// Squish a true-mercator y (d3 output) into the squished frame. The 60→82° band
// (y in [MT, MT+HONEST_NORTH]) compresses to [MT, MT+BAND_H]; the ±60° core
// (y in [MT+HONEST_NORTH, MT+HONEST_TOTAL]) shifts by (BAND_H-HONEST_NORTH).
// Matches yForLat() in DiscountMercator.tsx exactly.
const r3 = (v) => Math.round(v * 1000) / 1000;
function squishY(y) {
  if (y <= MT + HONEST_NORTH) return r3(MT + BAND_H * (y - MT) / HONEST_NORTH);
  return r3(y + (BAND_H - HONEST_NORTH));
}

// Transform every y-coordinate in an SVG path d-string through fn. d3.geoPath
// emits only absolute M / L / Z, so the 2nd, 4th, 6th… number after an M/L is a
// y. x is left untouched (antimeridian cuts stay vertical). d3's antimeridian
// preclip can emit NaN for pole-touching vertices (e.g. Norway/Svalbard for
// +01:00); those represent a point at the top of the frame, so clamp them to MT
// (== squishY(MT), the squished top) instead of letting them vanish — a missing
// y after `M` makes the whole <path d> invalid and hover silently breaks.
function transformPathY(d, fn) {
  const re = /([MLZmlz])|(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|NaN)|([,\s]+)/g;
  let out = '', cmd = '', idx = 0, m;
  while ((m = re.exec(d)) !== null) {
    if (m[1]) { cmd = m[1]; idx = 0; out += m[1]; }
    else if (m[3]) { out += m[3]; }
    else {
      const isY = (cmd === 'M' || cmd === 'L') && (idx % 2 === 1);
      if (isY) {
        const v = parseFloat(m[2]);
        out += isFinite(v) ? fn(v) : MT;
      } else {
        out += m[2];
      }
      idx++;
    }
  }
  return out;
}

const ROOT = path.resolve(__dirname, '..');
const TOPO_FILE = path.join(ROOT, 'scripts/land-110m.json');
const OUT_FILE = path.join(ROOT, 'src/data/worldLand.ts');
const LAND_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json';

function loadTopo() {
  if (!fs.existsSync(TOPO_FILE)) {
    console.log('Fetching ' + LAND_URL + ' ...');
    const { execSync } = require('child_process');
    execSync('curl -sL --fail "' + LAND_URL + '" -o "' + TOPO_FILE + '"');
  }
  return JSON.parse(fs.readFileSync(TOPO_FILE, 'utf8'));
}

// Drop polygons whose latitude bbox is entirely polar (no countries there):
// Antarctica (max lat < -60) or the north polar cap (min lat > 82). Survivors
// are clamped to [SOUTH_CLIP, NORTH_CLIP] below so pole-sliver vertices (e.g.
// the UK/Iceland ring reaching 90°N) truncate cleanly at the frame instead of
// projecting to NaN and corrupting the whole ring — which would erase the UK.
function polyKept(poly) {
  let mn = 90, mx = -90;
  for (const r of poly) for (const [x, y] of r) { if (y < mn) mn = y; if (y > mx) mx = y; }
  if (mx < SOUTH_CLIP) return false;
  if (mn > NORTH_CLIP) return false;
  return true;
}
const clampLat = (y) => Math.min(NORTH_CLIP, Math.max(SOUTH_CLIP, y));

// Drop degenerate outer rings — those with near-zero longitude width OR
// near-zero latitude span (a 0-area polygon). Natural Earth emits these as
// boundary slivers (e.g. a timezone-offset line running to the pole); they have
// zero fill and render as a stray vertical stroke, not a real territory. Real
// features have non-trivial span, so this drops nothing genuine.
const DEGEN_TOL = 0.02; // degrees
function ringDegenerate(ring) {
  let mnX = 180, mxX = -180, mnY = 90, mxY = -90;
  for (const [x, y] of ring) { if (x < mnX) mnX = x; if (x > mxX) mxX = x; if (y < mnY) mnY = y; if (y > mxY) mxY = y; }
  return (mxX - mnX < DEGEN_TOL) || (mxY - mnY < DEGEN_TOL);
}

const topo = loadTopo();
const fc = feature(topo, topo.objects.land); // FeatureCollection (one MultiPolygon)
const landGeom = fc.features[0].geometry;
const polys = landGeom.type === 'Polygon' ? [landGeom.coordinates] : landGeom.coordinates;
const kept = polys.filter(polyKept)
  // land-110m polygons are [outerRing] (no holes); drop ones whose outer ring
  // is a degenerate sliver (the +12 Kamchatka pole-boundary line, etc.).
  .filter((poly) => !ringDegenerate(poly[0]))
  .map((poly) => poly.map((r) => r.map(([x, y]) => [x, clampLat(y)])));
const filteredGeom = { type: 'MultiPolygon', coordinates: kept };
console.log('land polygons:', polys.length, '→ kept:', kept.length,
  '(dropped', polys.length - kept.length, 'polar/degenerate)');

let pathStr = d3.geoPath(projection)(filteredGeom) || '';
pathStr = transformPathY(pathStr, squishY);

const [[minX, minY], [maxX, maxY]] = d3.geoPath(projection).bounds(filteredGeom);
console.log('land bbox (honest):', minX.toFixed(1), minY.toFixed(1), '..', maxX.toFixed(1), maxY.toFixed(1));
console.log('plot rect (squished):', ML, MT, '..', ML + PLOT_W, MT + PLOT_H);

const out = `// Auto-generated Mercator world land outline (Natural Earth 110m via world-atlas).
// Projected with d3-geo (antimeridian-cut) to the viewBox used by DiscountMercator.tsx.
// Poles dropped (Antarctica < -60° and the north cap > 82°N — no countries there);
// the 60→82°N band is squished into BAND_H px above the unchanged ±60° core.
// Do not edit by hand. Regenerate via scripts/gen-world-land.cjs.
export const WORLD_LAND_PATH = ${JSON.stringify(pathStr)};
export const MERCATOR_VIEW_W = ${VIEW_W};
export const MERCATOR_VIEW_H = ${VIEW_H};
export const MERCATOR_PLOT_X = ${ML};
export const MERCATOR_PLOT_Y = ${MT};
export const MERCATOR_PLOT_W = ${PLOT_W};
export const MERCATOR_PLOT_H = ${PLOT_H};
export const MERCATOR_SOUTH_CLIP = ${SOUTH_CLIP};
export const MERCATOR_CORE_CLIP = ${CORE_CLIP};
export const MERCATOR_NORTH_CLIP = ${NORTH_CLIP};
export const MERCATOR_NORTH_BAND = ${BAND_H};
`;

fs.writeFileSync(OUT_FILE, out);
console.log('VIEW_H=' + VIEW_H, 'PLOT_H=' + PLOT_H, 'CORE_H=' + CORE_H.toFixed(1), 'HONEST_NORTH=' + HONEST_NORTH.toFixed(1), 'pathLen=' + pathStr.length);
console.log('written ' + OUT_FILE);
