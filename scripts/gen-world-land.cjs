// Offline generator: project land-110m to a Mercator SVG path, with the
// antimeridian (±180°) properly cut so polygons that wrap the date line
// (Russia/Chukchi, Fiji) don't draw horizontal bridges across the map.
//
// Uses d3-geo at build time ONLY — the output (src/data/worldLand.ts) is a
// self-contained SVG path string, so the web app has zero runtime deps for this.
//
// The projection constants here MUST match src/components/DiscountMercator.tsx.
//
// Usage:
//   npm install d3-geo topojson-client   # one-time, in a scratch dir
//   node scripts/gen-world-land.js
const fs = require('fs');
const path = require('path');
const d3 = require('d3-geo');
const { feature } = require('topojson-client');

// ---- projection constants (mirror the component) ----
const ML = 40, MR = 12, MT = 12, MB = 26;
const VIEW_W = 1000;
const PLOT_W = VIEW_W - ML - MR;            // 948
const LAT_CLIP = 60;                         // crop poles — compact, fits viewport
const yMerc = (latDeg) => Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI / 180) / 2));
const Y_LO = yMerc(-LAT_CLIP), Y_HI = yMerc(LAT_CLIP);
const PLOT_H = Math.round((PLOT_W / (2 * Math.PI)) * (Y_HI - Y_LO));  // true Mercator scale
const VIEW_H = MT + PLOT_H + MB;

// d3 Mercator: x = scale * (lon rad) + tx. 360° = scale * 2π → scale = PLOT_W/(2π).
// translate so lon 0 → centre; lat 0 → vertical centre; lat ±60 → top/bottom.
// d3.geoMercator's DEFAULT preclip is clipAntimeridian, which cuts wrapping
// polygons at ±180° before projecting (the fix for the bridge strip).
// clipExtent then trims everything outside the plot rect (handles the ±80°
// pole clip in screen space and any residual edge bleed).
const SCALE = PLOT_W / (2 * Math.PI);
const projection = d3.geoMercator()
  .scale(SCALE)
  .translate([ML + PLOT_W / 2, MT + PLOT_H / 2])
  .clipExtent([[ML, MT], [ML + PLOT_W, MT + PLOT_H]]);

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

const topo = loadTopo();
const fc = feature(topo, topo.objects.land); // FeatureCollection
// d3.geoPath returns ONE path string containing every (antimeridian-cut) subpath.
const pathStr = d3.geoPath(projection)(fc);

// Sanity: bounding box of the projected land must sit inside the plot rect.
const [[minX, minY], [maxX, maxY]] = d3.geoPath(projection).bounds(fc);
console.log('land bbox:', minX.toFixed(1), minY.toFixed(1), '..', maxX.toFixed(1), maxY.toFixed(1));
console.log('plot rect:', ML, MT, '..', ML + PLOT_W, MT + PLOT_H);

const out = `// Auto-generated Mercator world land outline (Natural Earth 110m via world-atlas).
// Projected with d3-geo (antimeridian-cut) to the viewBox used by DiscountMercator.tsx.
// Do not edit by hand. Regenerate via scripts/gen-world-land.js.
export const WORLD_LAND_PATH = ${JSON.stringify(pathStr)};
export const MERCATOR_VIEW_W = ${VIEW_W};
export const MERCATOR_VIEW_H = ${VIEW_H};
export const MERCATOR_PLOT_X = ${ML};
export const MERCATOR_PLOT_Y = ${MT};
export const MERCATOR_PLOT_W = ${PLOT_W};
export const MERCATOR_PLOT_H = ${PLOT_H};
export const MERCATOR_LAT_CLIP = ${LAT_CLIP};
`;

fs.writeFileSync(OUT_FILE, out);
console.log('VIEW_H=' + VIEW_H, 'PLOT_H=' + PLOT_H, 'pathLen=' + pathStr.length);
console.log('written ' + OUT_FILE);
