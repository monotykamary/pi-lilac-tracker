import { useMemo, useRef, useState, useId, useEffect } from 'react';
import { GlobeSimple, Funnel, Sun } from '@phosphor-icons/react';
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
  MERCATOR_LAT_CLIP as LAT_CLIP,
} from '../data/worldLand';

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
const Y_LO = yMerc(-LAT_CLIP);
const Y_HI = yMerc(LAT_CLIP);

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
  const l = Math.min(LAT_CLIP, Math.max(-LAT_CLIP, lat));
  return MT + PLOT_H * (1 - (yMerc(l) - Y_LO) / (Y_HI - Y_LO));
}
function hhmmz(hours: number): string {
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}z`;
}

// ── Civil timezones ───────────────────────────────────────────────────────────
// The real-world UTC offsets everyone politically agreed on — including the
// messy fractional ones (India +5:30, Nepal +5:45, Iran +3:30, Newfoundland
// −3:30…). Their reference meridian L = offset × 15° lands BETWEEN the clean
// 15° graticule grid (82.5°E, 86.25°E…), and the timezone's longitude band
// (Voronoi cell between adjacent reference meridians) has off-grid edges for
// fractional zones — the "agreed but weird to look at" payoff.
//
// On hover, the band under the cursor is highlighted CLIPPED TO LAND, so its
// edges follow the actual coastlines (curves, not a straight reference line).
// Antimeridian-crossing zones (Chatham +12:45, Tonga +13, Kiribati +14) are
// omitted: their reference meridians wrap to −150°/−165° and collide with
// Hawaii/Samoa on the flat −180..180 map. This is a reference overlay only —
// discount data stays attributed to the solar-noon longitude (re-keying by
// civil offset would collapse to a single meridian, since civil noon is a
// global instant, not per-longitude).
const TIMEZONES: { m: number; names: string }[] = [
  { m: -720, names: 'Baker & Howland Is.' },
  { m: -660, names: 'American Samoa' },
  { m: -600, names: 'Hawaii (HST)' },
  { m: -570, names: 'Marquesas Is.' },
  { m: -540, names: 'Alaska (AKST)' },
  { m: -480, names: 'Pacific (PT)' },
  { m: -420, names: 'Mountain (MT)' },
  { m: -360, names: 'Central (CT)' },
  { m: -300, names: 'Eastern (ET)' },
  { m: -240, names: 'Atlantic (AT)' },
  { m: -210, names: 'Newfoundland' },
  { m: -180, names: 'Argentina, Brazil' },
  { m: -120, names: 'S. Georgia' },
  { m:  -60, names: 'Azores, Cape Verde' },
  { m:    0, names: 'UK, Iceland, Ghana' },
  { m:   60, names: 'CET — Germany, France' },
  { m:  120, names: 'EET — Egypt, Greece' },
  { m:  180, names: 'Moscow, Saudi Arabia' },
  { m:  210, names: 'Iran' },
  { m:  240, names: 'UAE, Mauritius' },
  { m:  270, names: 'Afghanistan' },
  { m:  300, names: 'Pakistan, Uzbekistan' },
  { m:  330, names: 'India, Sri Lanka' },
  { m:  345, names: 'Nepal' },
  { m:  360, names: 'Bangladesh, Bhutan' },
  { m:  390, names: 'Myanmar, Cocos Is.' },
  { m:  420, names: 'Indochina, W. Indonesia' },
  { m:  480, names: 'China, Singapore, PH' },
  { m:  525, names: 'Eucla (AU)' },
  { m:  540, names: 'Japan, Korea' },
  { m:  570, names: 'Central Australia' },
  { m:  600, names: 'E. Australia' },
  { m:  630, names: 'Lord Howe Is.' },
  { m:  660, names: 'Solomon Is.' },
  { m:  720, names: 'New Zealand, Fiji' },
];
// Reference meridian (deg) for zone i: L = offset_minutes × 0.25.
const tzRefLon = (i: number) => TIMEZONES[i].m * 0.25;
// Longitude band for zone i = Voronoi cell between adjacent reference
// meridians. Edges sit at midpoints; for fractional zones these land off the
// 15° grid (India → 78.75°–84.375°, Nepal → 84.375°–88.125°). First/last
// zones clamp to the map edges (±180°).
const TZ_BANDS: { lo: number; hi: number }[] = TIMEZONES.map((_, i) => ({
  lo: i === 0 ? -180 : (tzRefLon(i - 1) + tzRefLon(i)) / 2,
  hi: i === TIMEZONES.length - 1 ? 180 : (tzRefLon(i) + tzRefLon(i + 1)) / 2,
}));
// Which timezone's band does this longitude fall in? (lon in [-180, 180).)
function tzIndexForLon(lon: number): number {
  for (let i = 0; i < TZ_BANDS.length; i++) {
    if (lon >= TZ_BANDS[i].lo && lon < TZ_BANDS[i].hi) return i;
  }
  return lon >= 180 ? TZ_BANDS.length - 1 : 0;
}
function fmtOffset(m: number): string {
  if (m === 0) return 'UTC';
  const sign = m > 0 ? '+' : '-';
  const am = Math.abs(m);
  return `${sign}${Math.floor(am / 60)}:${(am % 60).toString().padStart(2, '0')}`;
}
function fmtLon(lon: number): string {
  const v = Math.round(lon * 100) / 100;
  const s = v > 0 ? '+' : v < 0 ? '-' : '';
  return `${s}${Math.abs(v).toFixed(1).replace(/\.0$/, '')}°`;
}

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

interface ColActivity {
  count: number;
  byTier: Map<number, number>;
  byModel: Map<string, number>;
  states: Set<string>;
}

// Attribute every filtered observation to the longitude band at local noon at
// the moment it was recorded. Returns per-band totals + the max (for opacity
// normalization) + per-band tier/model breakdowns (for 'all' mode + tooltip).
// `discFilter` is either a single tier or 'all'. Tier 0 (1× = full price) is
// always excluded — it isn't a discount.
function buildActivity(
  timeSeries: Record<string, DiscountPoint[]>,
  discFilter: number | 'all',
  selectedModel: string | null,
): { cols: ColActivity[]; maxCount: number; hasData: boolean } {
  const cols: ColActivity[] = Array.from({ length: COLS }, () => ({
    count: 0, byTier: new Map<number, number>(), byModel: new Map<string, number>(), states: new Set<string>(),
  }));
  let maxCount = 1;
  let any = false;
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
      const col = colForNoonMeridian(utcH);
      const c = cols[col];
      c.count += 1;
      c.byTier.set(tier, (c.byTier.get(tier) ?? 0) + 1);
      c.byModel.set(id, (c.byModel.get(id) ?? 0) + 1);
      c.states.add(p.snapshot.supply_state);
      if (c.count > maxCount) maxCount = c.count;
    }
  }
  return { cols, maxCount, hasData: any };
}

export default function DiscountMercator({
  timeSeries, selectedModel, onSelectModel,
}: DiscountMercatorProps) {
  const gid = 'merc-' + useId().replace(/:/g, '');
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ col: number; x: number; y: number } | null>(null);
  const [discFilter, setDiscFilter] = useState<number | 'all'>('all');

  const focused = !!selectedModel;

  const { cols, maxCount, hasData } = useMemo(
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

  const latest = selectedModel
    ? (timeSeries[selectedModel]?.[timeSeries[selectedModel].length - 1]?.snapshot ?? null)
    : null;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const scale = r.width / VIEW_W;
    const xLocal = (e.clientX - r.left) / scale;
    if (xLocal < ML || xLocal > ML + PLOT_W) {
      setHover(null);
      return;
    }
    const col = Math.min(COLS - 1, Math.max(0, Math.floor((xLocal - ML) / COL_W)));
    setHover({ col, x: e.clientX, y: e.clientY });
  };

  const tipW = 252;
  let tipX = hover ? hover.x + 14 : 0;
  let tipY = hover ? hover.y + 14 : 0;
  if (hover) {
    if (tipX + tipW > window.innerWidth - 8) tipX = hover.x - tipW - 14;
    if (tipY + 190 > window.innerHeight - 8) tipY = hover.y - 190 - 14;
  }
  const hoverCol = hover ? cols[hover.col] : null;
  const hoverLon = hover ? lonForCol(hover.col) : 0;
  const hoverNoon = hover ? noonUtcForLon(hoverLon) : 0;
  const hoverTzIndex = hover ? tzIndexForLon(hoverLon) : -1;
  const hoverTz = hoverTzIndex >= 0 ? TIMEZONES[hoverTzIndex] : null;
  const hoverTzBand = hoverTzIndex >= 0 ? TZ_BANDS[hoverTzIndex] : null;
  const hoverTzRef = hoverTzIndex >= 0 ? tzRefLon(hoverTzIndex) : 0;
  const hoverEntries = hoverCol
    ? [...hoverCol.byModel.entries()].sort((a, b) => b[1] - a[1])
    : [];
  const hoverTierEntries = hoverCol
    ? FILTER_TIERS.map((t) => ({ t, n: hoverCol.byTier.get(t) ?? 0 }))
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
              {discFilter === 'all'
                ? 'continents tinted by which discount tier dominates at each longitude\'s local noon (brighter = more frequent)'
                : 'continents tinted by how often the selected tier was live when that longitude was at local noon'}
            </p>
          </div>
        </div>
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

      <div className="relative flex justify-center">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="mercator-map"
          style={{
            display: 'block',
            width: '100%',
            aspectRatio: `${VIEW_W} / ${VIEW_H}`,
            maxWidth: `calc(70vh * ${VIEW_W} / ${VIEW_H})`,
          }}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
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
          {[-60, -30, 0, 30, 60].map((lat) => (
            <line
              key={`p${lat}`}
              x1={ML} y1={yForLat(lat)} x2={ML + PLOT_W} y2={yForLat(lat)}
              className="mercator-graticule"
              opacity={lat === 0 ? 0.5 : 0.3}
            />
          ))}

          {/* THE DATA — discount activity painted onto the continents, clipped
              to land. Single tier: each active longitude band gets a wash of
              that tier's color, opacity = how often it recurred. 'all' mode:
              each band is colored by its dominant tier (most frequent there),
              opacity = total frequency — so all tier colors appear at once. */}
          {hasData && (
            <g clipPath={`url(#${gid}-land)`}>
              {cols.map((c, col) => {
                if (c.count === 0) return null;
                let fill: string;
                if (discFilter === 'all') {
                  let domTier: number = FILTER_TIERS[0];
                  let domN = -1;
                  for (const t of FILTER_TIERS) {
                    const n = c.byTier.get(t) ?? 0;
                    if (n > domN) { domN = n; domTier = t; }
                  }
                  fill = discountColor(domTier);
                } else {
                  fill = discountColor(discFilter);
                }
                return (
                  <rect
                    key={`t${col}`}
                    x={ML + col * COL_W}
                    y={MT}
                    width={COL_W + 0.6}
                    height={PLOT_H}
                    fill={fill}
                    opacity={0.2 + 0.7 * (c.count / maxCount)}
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

          {/* hovered civil-timezone territory — the band under the cursor,
              clipped to land so its edges follow the actual coastlines
              (curves, not a straight reference line). The crisp ember meridian
              at L = offset × 15° lands BETWEEN the 15° graticule lines for
              fractional zones (India +5:30 → 82.5°E, Nepal +5:45 → 86.25°E).
              Coexists with the dashed cyan solar-noon meridian: civil vs solar. */}
          {hover && hoverTz && hoverTzBand && (
            <g clipPath={`url(#${gid}-land)`} style={{ pointerEvents: 'none' }}>
              <rect
                x={xForLon(hoverTzBand.lo)}
                y={MT}
                width={Math.max(0, xForLon(hoverTzBand.hi) - xForLon(hoverTzBand.lo))}
                height={PLOT_H}
                style={{ fill: 'var(--ember)' }}
                opacity={0.16}
              />
              <line
                x1={xForLon(hoverTzRef)} y1={MT}
                x2={xForLon(hoverTzRef)} y2={MT + PLOT_H}
                style={{ stroke: 'var(--ember)' }}
                strokeWidth={1.5}
                opacity={0.9}
              />
              <circle
                cx={xForLon(hoverTzRef)} cy={eqY} r={3.5}
                style={{ fill: 'var(--ember)', stroke: 'var(--surface)' }}
                strokeWidth={1.5}
              />
            </g>
          )}
          {hover && hoverTz && (
            <g transform={`translate(${Math.max(ML + 26, Math.min(ML + PLOT_W - 26, xForLon(hoverTzRef)))}, ${MT + 13})`} style={{ pointerEvents: 'none' }}>
              <rect x={-24} y={-9} width={48} height={16} rx={4} style={{ fill: 'var(--ember)' }} />
              <text x={0} y={2.5} textAnchor="middle" className="mercator-tz-label">{fmtOffset(hoverTz.m)}</text>
            </g>
          )}

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
        <div className="flex items-center gap-1.5 ml-auto">
          <Sun size={12} weight="bold" className="text-accent shrink-0" />
          <span className="text-[10px] text-zinc-600 dark:text-zinc-400">
            noon now · {hhmmz(nowNoon.noonUtc)} at {nowNoon.lon >= 0 ? '+' : ''}{nowNoon.lon.toFixed(0)}°
          </span>
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

      {hover && (
        <div
          style={{ position: 'fixed', left: tipX, top: tipY, width: tipW, zIndex: 50, pointerEvents: 'none' }}
        >
          <div className="glass-panel" style={{ padding: '10px 12px' }}>
            <div className="tooltip-row-flex" style={{ marginBottom: 6 }}>
              <span className="tooltip-header">
                {hoverLon >= 0 ? '+' : ''}{hoverLon.toFixed(0)}° longitude
              </span>
              <span className="tooltip-header-unit">
                local noon {hhmmz(hoverNoon)}
              </span>
            </div>
            {hoverTz && (
              <div className="tooltip-row-flex" style={{ marginBottom: 6 }}>
                <span className="tooltip-row-item">
                  <span className="tooltip-dot" style={{ background: 'var(--ember)' }} />
                  <span className="tooltip-row-label">{fmtOffset(hoverTz.m)} · {hoverTz.names}</span>
                </span>
                <span className="tooltip-row-value">ref {fmtLon(hoverTzRef)}</span>
              </div>
            )}
            {(!hoverCol || hoverCol.count === 0) ? (
              <p className="tooltip-footer">
                {discFilter === 'all'
                  ? 'No discounts recorded when this longitude was at noon.'
                  : `No ${discFilter}% off recorded when this longitude was at noon.`}
              </p>
            ) : discFilter === 'all' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div className="tooltip-row-flex" style={{ marginBottom: 2 }}>
                  <span className="tooltip-row-label">×{hoverCol.count} observations</span>
                  <span className="tooltip-row-value">{[...hoverCol.states].join('/')}</span>
                </div>
                {hoverTierEntries.map(({ t, n }) => (
                  <div key={t} className="tooltip-row-flex">
                    <span className="tooltip-row-item">
                      <span className="tooltip-dot" style={{ background: discountColor(t) }} />
                      <span className="tooltip-row-label">{t}% off</span>
                    </span>
                    <span className="tooltip-row-value">×{n}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div className="tooltip-row-flex" style={{ marginBottom: 2 }}>
                  <span className="tooltip-row-label">{discFilter}% off · ×{hoverCol.count}</span>
                  <span className="tooltip-row-value">{[...hoverCol.states].join('/')}</span>
                </div>
                {hoverEntries.map(([id, n]) => (
                  <div key={id} className="tooltip-row-flex">
                    <span className="tooltip-row-item">
                      <span className="tooltip-dot" style={{ background: MODEL_COLORS[id] }} />
                      <span className="tooltip-row-label">{MODEL_LABELS[id]}</span>
                    </span>
                    <span className="tooltip-row-value">×{n}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
