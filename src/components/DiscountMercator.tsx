import { useMemo, useRef, useState, useId, useEffect } from 'react';
import { GlobeSimple, Funnel, Sun, Moon } from '@phosphor-icons/react';
import {
  TRACKED_MODELS, MODEL_LABELS, MODEL_COLORS, discountColor,
} from '../types';
import type { ModelSnapshot } from '../types';
import {
  WORLD_LAND_PATH,
  MERCATOR_VIEW_W as VIEW_W,
  MERCATOR_VIEW_H as VIEW_H,
  MERCATOR_PLOT_X as ML,
  MERCATOR_PLOT_Y as MT,
  MERCATOR_PLOT_W as PLOT_W,
  MERCATOR_PLOT_H as PLOT_H,
  MERCATOR_SOUTH_CLIP as SOUTH_CLIP,
  MERCATOR_CORE_CLIP as CORE_CLIP,
  MERCATOR_NORTH_CLIP as NORTH_CLIP,
  MERCATOR_NORTH_BAND as NORTH_BAND,
} from '../data/worldLand';
import {
  TIMEZONE_OFFSETS,
  TIMEZONE_PATHS,
  TIMEZONE_PLACES,
  TIMEZONE_REF_LON,
  TIMEZONE_X_LO,
  TIMEZONE_X_HI,
} from '../data/timezones';

export interface DiscountPoint {
  timestamp: string;
  snapshot: ModelSnapshot;
  supply_updated_at: string | null;
}

interface DiscountMercatorProps {
  timeSeries: Record<string, DiscountPoint[]>;
  selectedModel: string | null;
  onSelectModel: (id: string | null) => void;
}

// ── Noon-meridian geography ──────────────────────────────────────────────────
// Discounts are global events keyed to UTC. The geographic question is: *where
// on earth is it local noon when the discount fires?* Each snapshot at UTC time
// T is attributed to the longitude currently at local noon, L_noon = (12−T)·15°,
// and that activity is painted onto the actual continents (clipped to land).
// So the map IS the data — not a backdrop. Lilac's discounts cluster in UTC
// afternoon/evening = the Americas' daytime, so the Americas light up.
const COLS = 144; // 144 longitude bands (2.5° each)
const COL_W = PLOT_W / COLS;
const yMerc = (latDeg: number) =>
  Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI / 180) / 2));
// Polar squish constants — MUST match squishY in scripts/gen-world-land.cjs &
// gen-timezones.cjs. The ±60° core uses true Mercator scale; the 60→82°N band
// is compressed into NORTH_BAND px above it (Antarctica & the >82°N cap dropped).
const MERCATOR_SCALE = PLOT_W / (2 * Math.PI);
const M_CORE = yMerc(CORE_CLIP);
const M_NORTH = yMerc(NORTH_CLIP);

function lonForCol(col: number): number {
  return -180 + ((col + 0.5) / COLS) * 360;
}
function xForLon(lon: number): number {
  return ML + ((lon + 180) / 360) * PLOT_W;
}
// UTC hours of a snapshot → the longitude band at local noon then.
function colForNoonMeridian(utcHours: number): number {
  let lon = (12 - utcHours) * 15;
  lon = ((lon + 180) % 360 + 360) % 360 - 180; // normalize to [-180, 180)
  return Math.min(COLS - 1, Math.max(0, Math.floor(((lon + 180) / 360) * COLS)));
}
// Local-noon UTC time (hours) for a given longitude.
function noonUtcForLon(lon: number): number {
  return (((12 - lon / 15) % 24) + 24) % 24;
}
function yForLat(lat: number): number {
  const l = Math.min(NORTH_CLIP, Math.max(SOUTH_CLIP, lat));
  const m = yMerc(l);
  // Squished Mercator: 60→82°N band compresses into NORTH_BAND px above the
  // unchanged ±60° core. Mirrors squishY() in the generators exactly.
  if (m >= M_CORE) return MT + NORTH_BAND * (M_NORTH - m) / (M_NORTH - M_CORE);
  return MT + NORTH_BAND + MERCATOR_SCALE * (M_CORE - m);
}
function hhmmz(hours: number): string {
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}z`;
}

// ── Civil timezones (real political territories) ─────────────────────────────
// Each offset's territories are real Natural Earth polygons (baked at build
// time in scripts/gen-timezones.cjs), not straight longitude bands. So China
// +8 renders as its true 73°E–135°E extent — the political "backtrack" far
// west of the 120°E solar-noon reference meridian. Hover is resolved by the
// browser's native SVG point-in-polygon on invisible territory paths (no
// runtime geo deps). Standard civil offsets only — no DST. This is a reference
// overlay; discount data stays attributed to the solar-noon longitude.
function fmtOffset(h: number): string {
  if (h === 0) return 'UTC';
  const sign = h > 0 ? '+' : '-';
  const ah = Math.abs(h);
  const hh = Math.floor(ah);
  const mm = Math.round((ah - hh) * 60);
  return `${sign}${hh}:${mm.toString().padStart(2, '0')}`;
}
function fmtLon(lon: number): string {
  const v = Math.round(lon * 100) / 100;
  const s = v > 0 ? '+' : v < 0 ? '-' : '';
  return `${s}${Math.abs(v).toFixed(1).replace(/\.0$/, '')}°`;
}

// Right-sidebar stat formatters. TPS / TTFB / uptime come straight off the
// latest ModelSnapshot; null becomes an em dash (provider didn't expose it).
function fmtTps(tps: number | null): string {
  return tps != null ? `${tps.toFixed(1)} t/s` : '—';
}
function fmtTtfb(s: number | null): string {
  return s != null ? `${s.toFixed(2)}s` : '—';
}
function fmtUptime(u: number | null): string {
  return u != null ? `${u.toFixed(1)}%` : '—';
}

// Map a solar-noon offset (hours, normalized to (-12, 12]) to the nearest
// civil-timezone index. At UTC time T the longitude at local noon is
// L=(12-T)·15°, which is exactly the reference meridian of the civil offset
// O=12-T experiencing local noon — so binning observations by civil offset
// (civil mode) vs by 2.5° band (longitude mode) is the same data, differently
// grouped. Wraparound at ±12 handles antimeridian zones (+13/+14/+12:45 ≡
// -11/-10/-11.25 on the 24h ring).
const NOON_OFFSET_TO_TZ = (() => {
  const offs = TIMEZONE_OFFSETS;
  return (noonOffset: number) => {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < offs.length; i++) {
      // circular distance on the 24h ring (offsets span -12..+14, so the raw
      // gap can exceed 24 — reduce mod 24 then take the shorter way round)
      let d = Math.abs(offs[i] - noonOffset) % 24;
      d = Math.min(d, 24 - d);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };
})();

// Discount tiers selectable as a filter. 0% is excluded: a 1× credit
// multiplier is full price, not a discount. Default 75% (surplus tier).
const FILTER_TIERS = [25, 50, 75] as const;
const tierOf = (d: number) => Math.max(0, Math.min(100, Math.round(d / 25) * 25));

// Faint region annotations over the major landmasses.
const REGIONS: { lon: number; label: string }[] = [
  { lon: -100, label: 'AMERICAS' },
  { lon: 18, label: 'EUROPE / AFRICA' },
  { lon: 95, label: 'ASIA' },
];

interface BinActivity {
  count: number;
  byTier: Map<number, number>;
  byModel: Map<string, number>;
  // discount_percent of every observation, per model — so the sidebar can
  // show the discounts each model had at this local-noon time period instead
  // of live-now stats.
  byModelDiscounts: Map<string, number[]>;
  states: Set<string>;
}

function emptyBin(): BinActivity {
  return { count: 0, byTier: new Map(), byModel: new Map(), byModelDiscounts: new Map(), states: new Set() };
}

// For 'all' (multi-tier) mode, a bin's color is its dominant tier (the one
// most frequently observed there).
function dominantTier(b: BinActivity): number {
  let domTier: number = FILTER_TIERS[0], domN = -1;
  for (const t of FILTER_TIERS) {
    const n = b.byTier.get(t) ?? 0;
    if (n > domN) { domN = n; domTier = t; }
  }
  return domTier;
}

// Most frequently observed discount_percent for a model within a bin — the
// representative discount that model had at this local-noon time period.
function modeDiscount(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0], bestN = -1;
  for (const [v, n] of counts) if (n > bestN) { bestN = n; best = v; }
  return best;
}

// Attribute every filtered observation to BOTH (a) the longitude band at
// solar noon (longitude mode) and (b) the civil timezone at local noon
// (civil mode). The two are the same observations, differently grouped: the
// solar-noon longitude L=(12-T)·15° is the reference meridian of the civil
// offset O=12-T, so civil mode bins by offset territory, longitude mode bins
// by 2.5° band. Returns per-bin totals + each mode's max (for opacity
// normalization) + per-bin tier/model breakdowns (for 'all' mode + tooltip).
// `discFilter` is either a single tier or 'all'. Tier 0 (1× = full price) is
// always excluded — it isn't a discount.
function buildActivity(
  timeSeries: Record<string, DiscountPoint[]>,
  discFilter: number | 'all',
  selectedModel: string | null,
): { cols: BinActivity[]; tzBins: BinActivity[]; maxCountCols: number; maxCountTz: number; hasData: boolean } {
  const cols: BinActivity[] = Array.from({ length: COLS }, emptyBin);
  const tzBins: BinActivity[] = Array.from({ length: TIMEZONE_OFFSETS.length }, emptyBin);
  let maxCountCols = 1, maxCountTz = 1, any = false;
  const models = selectedModel ? [selectedModel] : TRACKED_MODELS;
  for (const id of models) {
    const pts = timeSeries[id] || [];
    for (const p of pts) {
      const tier = tierOf(p.snapshot.discount_percent);
      if (tier === 0) continue; // 1× multiplier = full price, not a discount
      if (discFilter !== 'all' && tier !== discFilter) continue;
      any = true;
      const d = new Date(p.timestamp);
      const utcH = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
      // longitude band at solar noon (longitude mode)
      const col = colForNoonMeridian(utcH);
      const c = cols[col];
      c.count += 1;
      c.byTier.set(tier, (c.byTier.get(tier) ?? 0) + 1);
      c.byModel.set(id, (c.byModel.get(id) ?? 0) + 1);
      let cD = c.byModelDiscounts.get(id);
      if (!cD) { cD = []; c.byModelDiscounts.set(id, cD); }
      cD.push(p.snapshot.discount_percent);
      c.states.add(p.snapshot.supply_state);
      if (c.count > maxCountCols) maxCountCols = c.count;
      // civil timezone at local noon (civil mode). Same observation, binned
      // by civil offset instead of by 2.5° band.
      const noonOff = (((12 - utcH) % 24) + 24) % 24;
      const noonNorm = noonOff > 12 ? noonOff - 24 : noonOff; // (-12, 12]
      const ti = NOON_OFFSET_TO_TZ(noonNorm);
      const b = tzBins[ti];
      b.count += 1;
      b.byTier.set(tier, (b.byTier.get(tier) ?? 0) + 1);
      b.byModel.set(id, (b.byModel.get(id) ?? 0) + 1);
      let bD = b.byModelDiscounts.get(id);
      if (!bD) { bD = []; b.byModelDiscounts.set(id, bD); }
      bD.push(p.snapshot.discount_percent);
      b.states.add(p.snapshot.supply_state);
      if (b.count > maxCountTz) maxCountTz = b.count;
    }
  }
  return { cols, tzBins, maxCountCols, maxCountTz, hasData: any };
}

export default function DiscountMercator({
  timeSeries, selectedModel, onSelectModel,
}: DiscountMercatorProps) {
  const gid = 'merc-' + useId().replace(/:/g, '');
  const svgRef = useRef<SVGSVGElement>(null);
  // Hover resolves the longitude column under the cursor into state. It
  // re-renders only when crossing a 2.5° band boundary, so the map stays
  // smooth. The detail renders in the right sidebar (React panel), not an
  // imperative floating tooltip — no DOM writes, no position math.
  const [hoverColIdx, setHoverColIdx] = useState<number | null>(null);
  const [hoverTz, setHoverTz] = useState<number | null>(null);
  const [discFilter, setDiscFilter] = useState<number | 'all'>('all');
  // How to bin & paint discount activity: by civil-timezone territory (the
  // political reality — China +8 spans 73°E–135°E) or by 2.5° longitude
  // bands at solar noon (the smoother scientific span). Same data, different
  // bins; the activity memo doesn't depend on this, so toggling is instant.
  const [geoMode, setGeoMode] = useState<'civil' | 'longitude'>('civil');
  // Day/night overlay on the map: shades the night side of earth (the
  // longitudes >90° from the subsolar meridian), sweeping west as the planet
  // rotates. Civil longitude approximation — consistent with the map's
  // longitude-of-noon model (no seasonal terminator curve). On by default;
  // toggle off for a pure-data view. Painted UNDER the discount data so the
  // data stays vivid while the ambient cycle reads behind it.
  const [dayNight, setDayNight] = useState(true);

  const focused = !!selectedModel;

  const { cols, tzBins, maxCountCols, maxCountTz, hasData } = useMemo(
    () => buildActivity(timeSeries, discFilter, selectedModel),
    [timeSeries, discFilter, selectedModel],
  );

  // Real-time noon meridian: where on earth is it local noon right now? Marches
  // westward ~15°/hr as the earth rotates. Ticks once a minute.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const nowNoon = useMemo(() => {
    const utcH = now.getUTCHours() + now.getUTCMinutes() / 60;
    let lon = (12 - utcH) * 15;
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    return { lon, x: xForLon(lon), noonUtc: utcH };
  }, [now]);

  // Night-side columns for the day/night overlay. Each 2.5° longitude band
  // gets a nightness 0..1 from its angular distance to the subsolar meridian,
  // with a soft twilight ramp across the ±12° band around the 90° terminator.
  // Wraps correctly at the antimeridian via the 360-d reduction.
  const nightCols = useMemo(() => {
    const out: { x: number; w: number; op: number }[] = [];
    const noon = nowNoon.lon;
    for (let col = 0; col < COLS; col++) {
      const lon = lonForCol(col);
      let d = Math.abs(lon - noon);
      d = Math.min(d, 360 - d);                 // angular distance to subsolar (0..180)
      const night = Math.max(0, Math.min(1, (d - 78) / 24));  // twilight 78°→102°
      if (night <= 0.01) continue;
      out.push({ x: ML + col * COL_W, w: COL_W + 0.6, op: night * 0.5 });
    }
    return out;
  }, [nowNoon.lon]);

  const latest = selectedModel
    ? (timeSeries[selectedModel]?.[timeSeries[selectedModel].length - 1]?.snapshot ?? null)
    : null;

  // Latest snapshot per tracked model — drives the sidebar's resting
  // "live now" overview (shown when nothing is hovered, i.e. no time period
  // selected). When a longitude / civil timezone is hovered (a time period
  // selected) the sidebar instead shows the discounts observed at that noon,
  // from each bin's byModelDiscounts (see buildActivity).
  const latestPerModel = useMemo(
    () => TRACKED_MODELS.map((id) => {
      const pts = timeSeries[id] || [];
      const last = pts.length ? pts[pts.length - 1] : null;
      return { id, snap: last?.snapshot ?? null };
    }),
    [timeSeries],
  );
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const scale = r.width / VIEW_W;
    const xLocal = (e.clientX - r.left) / scale;
    if (xLocal < ML || xLocal > ML + PLOT_W) {
      if (hoverColIdx !== null) setHoverColIdx(null);
      return;
    }
    const col = Math.min(COLS - 1, Math.max(0, Math.floor((xLocal - ML) / COL_W)));
    if (col !== hoverColIdx) setHoverColIdx(col);
  };
  const hoverCol = hoverColIdx != null ? cols[hoverColIdx] : null;
  const hoverLon = hoverColIdx != null ? lonForCol(hoverColIdx) : 0;
  const hoverNoon = hoverColIdx != null ? noonUtcForLon(hoverLon) : 0;
  // Real civil timezone under the cursor (from browser-native hit-testing on
  // the invisible territory polygons below) — independent of the solar-noon
  // longitude column, so the tooltip shows BOTH the civil zone and the
  // discount activity at that longitude's local noon.
  const tzIdx = hoverTz;
  const tzOffset = tzIdx != null ? TIMEZONE_OFFSETS[tzIdx] : null;
  const tzPlaces = tzIdx != null ? TIMEZONE_PLACES[tzIdx] : null;
  const tzRefLon = tzIdx != null ? TIMEZONE_REF_LON[tzIdx] : 0;
  const tzXRef = xForLon(tzRefLon);
  const tzRefVisible =
    tzIdx != null && tzXRef >= TIMEZONE_X_LO[tzIdx] - 8 && tzXRef <= TIMEZONE_X_HI[tzIdx] + 8;
  // The bin whose activity the tooltip reports: in civil mode the hovered
  // timezone's aggregate, in longitude mode the hovered band's. Both are
  // derived from the same observations, just differently grouped.
  const hoverTzBin = tzIdx != null ? tzBins[tzIdx] : null;
  const activeBin = geoMode === 'civil' ? hoverTzBin : hoverCol;
  const activeEntries = activeBin
    ? [...activeBin.byModel.entries()].sort((a, b) => b[1] - a[1])
    : [];
  const activeTierEntries = activeBin
    ? FILTER_TIERS.map((t) => ({ t, n: activeBin.byTier.get(t) ?? 0 }))
        .filter((e) => e.n > 0)
        .sort((a, b) => b.n - a.n)
    : [];

  const eqY = yForLat(0);

  return (
    <div className="card-surface p-5">
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="p-1.5 bg-accent/10 dark:bg-accent/15 rounded-lg">
            <GlobeSimple weight="bold" size={16} className="text-accent" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 leading-none">
              Discount Timezones
            </h2>
            <p className="text-[11px] text-zinc-600 dark:text-zinc-400 mt-1">
              {geoMode === 'civil'
                ? (discFilter === 'all'
                    ? 'continents tinted by which discount tier dominates in each civil timezone at its local noon (brighter = more frequent)'
                    : 'continents tinted by how often the selected tier was live when each civil timezone was at local noon')
                : (discFilter === 'all'
                    ? 'continents tinted by which discount tier dominates at each longitude\'s local noon (brighter = more frequent)'
                    : 'continents tinted by how often the selected tier was live when that longitude was at local noon')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {latest && selectedModel && (
            <span
              className="supply-badge"
              style={{
                backgroundColor: `${discountColor(latest.discount_percent)}18`,
                color: discountColor(latest.discount_percent),
              }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: discountColor(latest.discount_percent) }}
              />
              {MODEL_LABELS[selectedModel]} · {latest.discount_percent}% OFF
            </span>
          )}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 dark:text-zinc-400 shrink-0">view</span>
            <div className="flex items-center gap-0.5 rounded-lg p-0.5" style={{ border: '1px solid var(--border)' }}>
              {(['civil', 'longitude'] as const).map((m) => {
                const on = geoMode === m;
                return (
                  <button
                    key={m}
                    onClick={() => setGeoMode(m)}
                    className="metric-mono text-[10px] font-semibold rounded-md px-2 py-1 transition-all"
                    style={on ? { color: '#fff', backgroundColor: '#52525b' } : { color: '#71717a' }}
                    aria-pressed={on}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* model selector chips */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {TRACKED_MODELS.map((id) => {
          const active = selectedModel === id;
          const color = MODEL_COLORS[id];
          const pts = timeSeries[id] || [];
          const cur = pts.length ? pts[pts.length - 1].snapshot : null;
          return (
            <button
              key={id}
              onClick={() => onSelectModel(active ? null : id)}
              className="group flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-colors"
              style={{
                borderColor: active ? color : 'var(--border)',
                backgroundColor: active ? `${color}14` : 'transparent',
              }}
            >
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
              <span
                className={`text-xs font-medium ${active ? 'text-zinc-800 dark:text-zinc-200' : 'text-zinc-600 dark:text-zinc-400'}`}
              >
                {MODEL_LABELS[id]}
              </span>
              {cur && (
                <span
                  className="metric-mono text-[10px] font-semibold px-1.5 py-0.5 rounded-md"
                  style={{ backgroundColor: `${discountColor(cur.discount_percent)}1a`, color: discountColor(cur.discount_percent) }}
                >
                  {cur.discount_percent}%
                </span>
              )}
              {active && (
                <span className="text-[10px] text-zinc-400 dark:text-zinc-500 group-hover:text-ember">✕</span>
              )}
            </button>
          );
        })}
        {!selectedModel && (
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400 ml-1">
            pick a model to isolate its timezones · showing all faintly
          </span>
        )}
      </div>

      <div
        className="mercator-layout"
        style={{ '--map-max': `calc(70vh * ${VIEW_W} / ${VIEW_H})` } as React.CSSProperties}
      >
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="mercator-map"
          style={{
            display: 'block',
            width: '100%',
            height: 'auto',
            aspectRatio: `${VIEW_W} / ${VIEW_H}`,
          }}
          onMouseMove={onMove}
          onMouseLeave={() => { setHoverColIdx(null); setHoverTz(null); }}
        >
          <defs>
            <clipPath id={`${gid}-land`}>
              <path d={WORLD_LAND_PATH} />
            </clipPath>
          </defs>

          {/* ocean */}
          <rect x={ML} y={MT} width={PLOT_W} height={PLOT_H} rx={5} className="mercator-ocean" />

          {/* base continents (neutral) */}
          <path d={WORLD_LAND_PATH} className="mercator-land" />

          {/* graticule — meridians (every 15° = 1 hour of noon-time) + parallels */}
          {Array.from({ length: 25 }, (_, h) => {
            const x = ML + h * 6 * COL_W;
            return (
              <line
                key={`m${h}`}
                x1={x} y1={MT} x2={x} y2={MT + PLOT_H}
                className="mercator-graticule"
                opacity={h % 6 === 0 ? 0.6 : 0.22}
              />
            );
          })}
          {[-60, -30, 0, 30, 60, 75].map((lat) => (
            <line
              key={`p${lat}`}
              x1={ML} y1={yForLat(lat)} x2={ML + PLOT_W} y2={yForLat(lat)}
              className="mercator-graticule"
              opacity={lat === 0 ? 0.5 : 0.3}
            />
          ))}

          {/* day / night overlay — the night side of earth, sweeping west as the
              planet rotates. Civil longitude approximation: night where the
              longitude is >90° from the subsolar meridian (local solar hour
              outside 06–18), with a soft twilight gradient. Painted over ocean
              + base land but UNDER the discount data, so the data stays vivid
              while the ambient cycle reads behind it. Toggle off for pure data. */}
          {dayNight && nightCols.map((c, i) => (
            <rect
              key={`dn${i}`}
              x={c.x} y={MT} width={c.w} height={PLOT_H}
              className="mercator-night"
              opacity={c.op}
              style={{ pointerEvents: 'none' }}
            />
          ))}

          {/* THE DATA — discount activity painted onto the continents, clipped
              to land. Two binning modes (toggled above): longitude = 2.5°
              bands at solar noon (smooth); civil = real timezone territories
              at local noon (political reality). Single tier: each active bin
              gets a wash of that tier's color, opacity = how often it recurred.
              'all' mode: each bin is colored by its dominant tier, opacity =
              total frequency — so all tier colors appear at once. */}
          {hasData && geoMode === 'longitude' && (
            <g clipPath={`url(#${gid}-land)`}>
              {cols.map((c, col) => {
                if (c.count === 0) return null;
                const fill = discFilter === 'all' ? discountColor(dominantTier(c)) : discountColor(discFilter);
                return (
                  <rect
                    key={`t${col}`}
                    x={ML + col * COL_W}
                    y={MT}
                    width={COL_W + 0.6}
                    height={PLOT_H}
                    fill={fill}
                    opacity={0.2 + 0.7 * (c.count / maxCountCols)}
                  />
                );
              })}
            </g>
          )}
          {hasData && geoMode === 'civil' && (
            <g clipPath={`url(#${gid}-land)`}>
              {tzBins.map((b, idx) => {
                if (b.count === 0) return null;
                const fill = discFilter === 'all' ? discountColor(dominantTier(b)) : discountColor(discFilter);
                return (
                  <path
                    key={`tzd${idx}`}
                    d={TIMEZONE_PATHS[idx]}
                    fill={fill}
                    opacity={0.2 + 0.7 * (b.count / maxCountTz)}
                    style={{ pointerEvents: 'none' }}
                  />
                );
              })}
            </g>
          )}

          {/* faint region labels over the landmasses */}
          {REGIONS.map((r) => (
            <text
              key={r.label}
              x={xForLon(r.lon)}
              y={MT + 16}
              textAnchor="middle"
              className="mercator-region-label"
            >
              {r.label}
            </text>
          ))}

          {/* live noon meridian — where it's local noon right now, sweeping
              westward as the earth rotates. Pulsing dot on the equator. */}
          <line
            x1={nowNoon.x} y1={MT} x2={nowNoon.x} y2={MT + PLOT_H}
            stroke="var(--accent)"
            strokeWidth={1.4}
            strokeDasharray="4 3"
            opacity={0.85}
          />
          <circle cx={nowNoon.x} cy={eqY} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={1.8}>
            <animate attributeName="r" values="4;6;4" dur="2.2s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="1;0.55;1" dur="2.2s" repeatCount="indefinite" />
          </circle>

          {/* hovered civil-timezone territory — a REAL Natural Earth polygon
              (not a straight longitude band). China +8 spans 73°E–135°E; the
              dashed ember reference meridian at L = offset × 15° (120°E) cuts
              through it, exposing the "backtrack": political territory reaches
              ~47° west of its solar-noon longitude. Visibility is carried by a
              thin OUTLINE, not a fill — discount data reaches 0.9 opacity, so a
              faint fill vanishes over busy columns, but a 1px ember stroke with
              a soft surface halo reads on any background without overpowering.
              Clipped to land so ocean stays negative space. Ref meridian dashed
              ember (parallel to the dashed-cyan solar noon): civil vs solar. */}
          {hoverColIdx != null && tzIdx != null && (
            <g style={{ pointerEvents: 'none' }}>
              <g clipPath={`url(#${gid}-land)`}>
                <path d={TIMEZONE_PATHS[tzIdx]} style={{ fill: 'var(--ember)' }} opacity={0.12} />
                {tzRefVisible && (
                  <>
                    <line
                      x1={tzXRef} y1={MT} x2={tzXRef} y2={MT + PLOT_H}
                      style={{ stroke: 'var(--ember)' }} strokeWidth={1.3} strokeDasharray="4 3" opacity={0.85}
                    />
                    <circle
                      cx={tzXRef} cy={eqY} r={3}
                      style={{ fill: 'var(--ember)', stroke: 'var(--surface)' }} strokeWidth={1.2}
                    />
                  </>
                )}
              </g>
              {/* Outline is unclipped on purpose. The land clip is 110m but the
                  territory polygons are 10m, so their coastlines differ —
                  clipping the stroke ate the coastal segment and outlines
                  vanished for ocean-bordering countries (landlocked ones
                  survived). Render the stroke unclipped so it follows the
                  real 10m coast; the fill above stays clipped so the faint
                  tint doesn't bleed into the ocean. */}
              <path d={TIMEZONE_PATHS[tzIdx]} fill="none" style={{ stroke: 'var(--surface)' }} strokeWidth={2.6} opacity={0.6} />
              <path d={TIMEZONE_PATHS[tzIdx]} fill="none" style={{ stroke: 'var(--ember)' }} strokeWidth={1.1} opacity={0.95} />
              {tzRefVisible && (
                <g transform={`translate(${Math.max(ML + 26, Math.min(ML + PLOT_W - 26, tzXRef))}, ${MT + 13})`}>
                  <rect x={-24} y={-9} width={48} height={16} rx={4} style={{ fill: 'var(--ember)' }} />
                  <text x={0} y={2.5} textAnchor="middle" className="mercator-tz-label">{fmtOffset(tzOffset!)}</text>
                </g>
              )}
            </g>
          )}

          {/* timezone hit layer — invisible territory polygons. The browser's
              native SVG point-in-polygon does hover detection for free,
              accurate to real borders (incl. China's far-west +8 reach), with
              zero runtime geo deps. Topmost so it captures over the data. */}
          <g>
            {TIMEZONE_PATHS.map((d, idx) => (
              <path
                key={idx}
                d={d}
                fill="none"
                stroke="none"
                style={{ pointerEvents: 'all' }}
                onMouseEnter={() => setHoverTz(idx)}
                onMouseLeave={() => setHoverTz(null)}
              />
            ))}
          </g>

          {/* frame */}
          <rect x={ML} y={MT} width={PLOT_W} height={PLOT_H} rx={5} fill="none" className="mercator-frame-stroke" />

          {/* longitude axis */}
          {[-180, -120, -60, 0, 60, 120, 180].map((lon) => {
            const x = xForLon(lon);
            const anchor = lon === -180 ? 'start' : lon === 180 ? 'end' : 'middle';
            return (
              <text
                key={`lo${lon}`}
                x={x}
                y={MT + PLOT_H + 18}
                textAnchor={anchor}
                className="mercator-label"
              >
                {lon === 0 ? '0°' : lon > 0 ? `+${lon}°` : `${lon}°`}
              </text>
            );
          })}
          <text
            x={ML + PLOT_W / 2}
            y={MT + PLOT_H + 33}
            textAnchor="middle"
            className="mercator-axis-cap"
          >
            longitude = where it was local noon · west ← → east
          </text>
        </svg>

        {/* right sidebar — a flex sibling of the SVG so align-items: stretch
            pins its top/bottom borders to the map's exact box (no separate
            wrap, no dead vertical band), and flex:1 grows it to fill all the
            width the maxWidth-clamped map leaves unused. On hover: hovered
            longitude / civil-timezone detail + discount activity + live TPS
            for the models with activity there — the discounts observed at
            that local-noon time period, not live stats. At rest (no time
            period selected): a "live now" overview of every tracked model's
            latest snapshot so the panel is never sparse. */}
        <aside className="mercator-side">
          <div
            className="mercator-side-inner"
            style={{
              // Align the bordered panel exactly with the map frame's
              // top/bottom borders, not the SVG's outer box. The SVG is
              // VIEW_H tall but its frame sits at y=MT..MT+PLOT_H (the MT
              // strip above is empty sky, MB=VIEW_H-MT-PLOT_H below holds
              // longitude axis labels). Percentages here resolve against
              // .mercator-side's height (the stretched grid cell = the map's
              // rendered height), so they track the frame precisely.
              top: `${(MT / VIEW_H) * 100}%`,
              height: `${(PLOT_H / VIEW_H) * 100}%`,
            }}
          >
          {hoverColIdx != null ? (
            <>
              <div className="tooltip-row-flex" style={{ marginBottom: 8 }}>
                <span className="tooltip-header">
                  {hoverLon >= 0 ? '+' : ''}{hoverLon.toFixed(0)}° longitude
                </span>
                <span className="tooltip-header-unit">local noon {hhmmz(hoverNoon)}</span>
              </div>
              {tzIdx != null && tzPlaces != null && (
                <div className="tooltip-row-flex" style={{ marginBottom: 8 }}>
                  <span className="tooltip-row-item">
                    <span className="tooltip-dot" style={{ background: 'var(--ember)' }} />
                    <span className="tooltip-row-label">{fmtOffset(tzOffset!)} · {tzPlaces}</span>
                  </span>
                  <span className="tooltip-row-value">ref {fmtLon(tzRefLon)}</span>
                </div>
              )}
              {(!activeBin || activeBin.count === 0) ? (
                <p className="tooltip-footer">
                  {activeBin == null
                    ? 'Ocean — no civil timezone here.'
                    : geoMode === 'civil'
                      ? (discFilter === 'all'
                          ? 'No discounts recorded when this timezone was at noon.'
                          : `No ${discFilter}% off recorded when this timezone was at noon.`)
                      : (discFilter === 'all'
                          ? 'No discounts recorded when this longitude was at noon.'
                          : `No ${discFilter}% off recorded when this longitude was at noon.`)}
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <div className="tooltip-row-flex" style={{ marginBottom: 2 }}>
                    <span className="tooltip-row-label">×{activeBin.count} observations</span>
                    <span className="tooltip-row-value">{[...activeBin.states].join('/')}</span>
                  </div>
                  {discFilter === 'all' && activeTierEntries.map(({ t, n }) => (
                    <div key={t} className="tooltip-row-flex">
                      <span className="tooltip-row-item">
                        <span className="tooltip-dot" style={{ background: discountColor(t) }} />
                        <span className="tooltip-row-label">{t}% off</span>
                      </span>
                      <span className="tooltip-row-value">×{n}</span>
                    </div>
                  ))}
                </div>
              )}
              {/* models with activity here — latest stats enrich the sparse
                  per-zone observation counts with live TPS / discount / supply. */}
              {activeEntries.length > 0 && (
                <div className="tooltip-section" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="tooltip-header">models here · this noon</span>
                  {activeEntries.map(([id, n]) => {
                    const discounts = activeBin!.byModelDiscounts.get(id) ?? [];
                    const dom = discounts.length ? modeDiscount(discounts) : 0;
                    const distinct = [...new Set(discounts)].sort((a, b) => b - a);
                    const color = MODEL_COLORS[id];
                    return (
                      <div key={id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <div className="tooltip-row-flex">
                          <span className="tooltip-row-item">
                            <span className="tooltip-dot-lg" style={{ background: color }} />
                            <span className="text-[11px] font-semibold text-zinc-800 dark:text-zinc-200">{MODEL_LABELS[id]}</span>
                          </span>
                          <span className="tooltip-row-value" style={{ color: discounts.length ? discountColor(dom) : undefined }}>
                            {discounts.length ? `${dom}% off` : `×${n}`}
                          </span>
                        </div>
                        <div className="tooltip-row-flex">
                          <span className="tooltip-row-label">
                            ×{n} at this noon{distinct.length > 1 ? ` · ${distinct.join('/')}%` : ''}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="tooltip-row-flex" style={{ marginBottom: 10 }}>
                <span className="tooltip-header">Live now</span>
                <span className="tooltip-header-unit">
                  noon {hhmmz(nowNoon.noonUtc)} · {nowNoon.lon >= 0 ? '+' : ''}{nowNoon.lon.toFixed(0)}°
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {latestPerModel.map(({ id, snap }) => {
                  const color = MODEL_COLORS[id];
                  return (
                    <div key={id} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <div className="tooltip-row-flex">
                        <span className="tooltip-row-item">
                          <span className="tooltip-dot-lg" style={{ background: color }} />
                          <span className="text-[11px] font-semibold text-zinc-800 dark:text-zinc-200">{MODEL_LABELS[id]}</span>
                        </span>
                        {snap && (
                          <span className="tooltip-row-value" style={{ color: discountColor(snap.discount_percent) }}>
                            {snap.discount_percent}% off
                          </span>
                        )}
                      </div>
                      {snap ? (
                        <div className="tooltip-row-flex">
                          <span className="tooltip-row-label">{fmtTps(snap.tps)} · {fmtTtfb(snap.ttfb_seconds)} · {snap.supply_state}</span>
                          <span className="tooltip-row-value">up {fmtUptime(snap.uptime_pct)}</span>
                        </div>
                      ) : (
                        <span className="tooltip-footer">no data yet</span>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="tooltip-footer tooltip-section">
                hover the map to inspect a longitude or civil timezone at its local noon.
              </p>
            </>
          )}
          </div>
        </aside>
      </div>

      {/* controls — discount tier filter */}
      <div className="mt-3 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <Funnel size={13} weight="bold" className="text-zinc-400 dark:text-zinc-500 shrink-0" />
          <span className="text-[10px] text-zinc-500 dark:text-zinc-400 shrink-0">discount tier</span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setDiscFilter('all')}
            className="metric-mono text-[10px] font-semibold rounded-md px-2.5 py-1.5 transition-all"
            style={discFilter === 'all'
              ? { color: '#fff', backgroundColor: '#52525b', boxShadow: '0 0 0 1.5px #52525b' }
              : { color: '#71717a', border: '1px solid var(--border)' }}
            aria-pressed={discFilter === 'all'}
          >
            all
          </button>
          {FILTER_TIERS.map((t) => {
            const on = discFilter === t;
            const color = discountColor(t);
            return (
              <button
                key={t}
                onClick={() => setDiscFilter(t)}
                className="metric-mono text-[10px] font-semibold rounded-md px-2.5 py-1.5 transition-all"
                style={{
                  color: on ? '#fff' : color,
                  backgroundColor: on ? color : `${color}1a`,
                  boxShadow: on ? `0 0 0 1.5px ${color}` : 'none',
                }}
                aria-pressed={on}
              >
                {t}%
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <div className="flex items-center gap-1.5">
            <Sun size={12} weight="bold" className="text-accent shrink-0" />
            <span className="text-[10px] text-zinc-600 dark:text-zinc-400">
              noon now · {hhmmz(nowNoon.noonUtc)} at {nowNoon.lon >= 0 ? '+' : ''}{nowNoon.lon.toFixed(0)}°
            </span>
          </div>
          <button
            onClick={() => setDayNight(v => !v)}
            className="flex items-center gap-1 rounded-md px-2 py-1 transition-colors"
            style={{
              border: `1px solid ${dayNight ? 'var(--accent)' : 'var(--border)'}`,
              backgroundColor: dayNight ? 'rgba(8,145,178,0.08)' : 'transparent',
            }}
            aria-pressed={dayNight}
            title={dayNight ? 'Day/night overlay on — click to hide' : 'Day/night overlay off — click to show'}
          >
            {dayNight
              ? <Sun size={12} weight="bold" className="text-accent" />
              : <Moon size={12} weight="bold" className="text-zinc-400 dark:text-zinc-500" />}
            <span
              className="text-[10px] font-medium"
              style={{ color: dayNight ? 'var(--accent)' : 'var(--text-secondary)' }}
            >
              day/night
            </span>
          </button>
        </div>
      </div>

      {/* legend — 'all' shows tier chips; single tier shows intensity gradient */}
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        {discFilter === 'all' ? (
          <>
            <span className="text-[10px] text-zinc-500 dark:text-zinc-400 shrink-0 mr-2">dominant tier</span>
            <div className="flex items-center gap-1.5 flex-wrap">
              {FILTER_TIERS.map((t) => (
                <div key={t} className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: discountColor(t) }} />
                  <span className="text-[10px] text-zinc-600 dark:text-zinc-400">{t}%</span>
                </div>
              ))}
            </div>
            <span className="text-[10px] text-zinc-400 dark:text-zinc-500 mx-1">·</span>
            <span className="text-[10px] text-zinc-500 dark:text-zinc-400">brighter = more frequent</span>
          </>
        ) : (
          <>
            <span className="text-[10px] text-zinc-500 dark:text-zinc-400 shrink-0">rare</span>
            <div
              className="h-2 rounded-full min-w-[120px] flex-1 max-w-[260px]"
              style={{
                background: `linear-gradient(to right, ${discountColor(discFilter)}33, ${discountColor(discFilter)})`,
              }}
            />
            <span className="text-[10px] text-zinc-500 dark:text-zinc-400 shrink-0">frequent at local noon</span>
          </>
        )}
        {focused && (
          <>
            <span className="text-[10px] text-zinc-400 dark:text-zinc-500 mx-1">·</span>
            <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
              {MODEL_LABELS[selectedModel!]} only
            </span>
          </>
        )}
      </div>

    </div>
  );
}
