import { useMemo, useState, useEffect, useId } from 'react';
import { SunHorizon, Sun, Moon, ArrowUpRight } from '@phosphor-icons/react';
import { TRACKED_MODELS, MODEL_LABELS, discountColor } from '../types';
import type { DiscountPoint } from './DiscountMercator';

interface Props {
  timeSeries: Record<string, DiscountPoint[]>;
  selectedModel: string | null;
}

// ── Local-hour discount statistics ───────────────────────────────────────────
// Lilac's discounts are global events keyed to UTC. To answer "when should *I*
// use Lilac?" we re-bin every observation into the viewer's *local* hour of day
// (the browser handles DST via Date.getHours, so Finland in summer folds the
// UTC pattern to EEST automatically), then find the contiguous run of local
// hours with the strongest, deepest discounts — the viewer's personal prime
// window. The Mercator map paints the same data sliced by longitude; this is
// the flatland translation: a sentence + a clock.
interface HourStat { count: number; avg: number; goodShare: number; }

function buildLocalHourStats(timeSeries: Record<string, DiscountPoint[]>, selectedModel: string | null): HourStat[] {
  const acc = Array.from({ length: 24 }, () => ({ count: 0, sum: 0, good75: 0 }));
  const models = selectedModel ? [selectedModel] : TRACKED_MODELS;
  for (const id of models) {
    const pts = timeSeries[id] || [];
    for (const p of pts) {
      const disc = p.snapshot.discount_percent;
      if (disc <= 0) continue;             // 1× multiplier = full price, not a discount
      const d = new Date(p.timestamp);
      const localHour = d.getHours();       // browser-local, DST-aware
      const s = acc[localHour];
      s.count++; s.sum += disc;
      if (disc >= 75) s.good75++;          // "surplus" tier = the deep cuts
    }
  }
  return acc.map(s => ({
    count: s.count,
    avg: s.count ? s.sum / s.count : 0,
    goodShare: s.count ? s.good75 / s.count : 0,
  }));
}

// ── Realtime current discount ───────────────────────────────────────────────
// The prime/dead windows above are *historical* (averaged over every
// observation binned by local hour), so they answer "when do discounts tend to
// land in your day?". But the right-now nudge must answer a more live
// question: "what is Lilac charging *this minute*?". So we pull the latest
// snapshot's discount and fold it into the verdict — a deep live deal can
// override a historically-dry window (a flash sale), and a shallow live deal
// tempers a historically-prime one (the clock says prime, but Lilac's only
// running 25% off right now, so don't rush).
interface RealtimeDiscount { percent: number; ageMs: number; }

function currentDiscountFor(
  timeSeries: Record<string, DiscountPoint[]>,
  selectedModel: string | null,
  now: Date,
): RealtimeDiscount | null {
  // For a single model: its latest discount. For the pooled view: the best
  // discount across the latest snapshot of every tracked model — if *any*
// model is at a deep cut right now, that's the actionable signal (go use
  // that one).
  let best = -1, bestAge = Infinity, any = false;
  const models = selectedModel ? [selectedModel] : TRACKED_MODELS;
  for (const id of models) {
    const pts = timeSeries[id] || [];
    if (!pts.length) continue;
    any = true;
    const p = pts[pts.length - 1];
    const disc = p.snapshot.discount_percent;
    const age = now.getTime() - new Date(p.timestamp).getTime();
    if (disc > best) { best = disc; bestAge = age; }
  }
  return any ? { percent: Math.max(0, best), ageMs: Math.max(0, bestAge) } : null;
}

// ── Contiguous-run finder with midnight wraparound ───────────────────────────
// A prime window can cross midnight (e.g. 22:00→02:00), so runs are found on a
// doubled ring and the seam is stitched when a run ends at hour 23 and another
// starts at hour 0.
function findRuns(flags: boolean[]): { start: number; end: number; len: number }[] {
  const n = flags.length;
  if (!flags.some(Boolean)) return [];
  if (flags.every(Boolean)) return [{ start: 0, end: n - 1, len: n }];
  // Start scanning just after the first false, so the midnight seam is never
  // inside a run being collected. This folds a wraparound window (e.g.
  // 22:00→02:00) into a single run instead of splitting it into a body + a
  // spurious hour-0 fragment. The scan covers the whole circle once.
  let startScan = 0;
  while (flags[startScan]) startScan = (startScan + 1) % n;
  const runs: { start: number; end: number; len: number }[] = [];
  let s = -1, len = 0;
  for (let k = 0; k < n; k++) {
    const idx = (startScan + 1 + k) % n;
    if (flags[idx]) {
      if (s === -1) s = idx;
      len++;
    } else {
      if (s !== -1) { runs.push({ start: s, end: (startScan + k) % n, len }); s = -1; len = 0; }
    }
  }
  if (s !== -1) runs.push({ start: s, end: startScan, len }); // close a trailing wrap run
  return runs;
}

function fmtClock(h: number): string {
  const hh = Math.floor((((h % 24) + 24) % 24));
  return `${String(hh).padStart(2, '0')}:00`;
}
function fmtOffset(off: number): string {
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  const hh = Math.floor(a);
  const mm = Math.round((a - hh) * 60);
  return mm === 0 ? `UTC${sign}${hh}` : `UTC${sign}${hh}:${String(mm).padStart(2, '0')}`;
}
function daypartOf(h: number): string {
  const hr = ((h % 24) + 24) % 24;
  if (hr >= 5 && hr < 8) return 'early morning';
  if (hr >= 8 && hr < 12) return 'morning';
  if (hr >= 12 && hr < 14) return 'lunchtime';
  if (hr >= 14 && hr < 17) return 'afternoon';
  if (hr >= 17 && hr < 21) return 'evening';
  if (hr >= 21 || hr < 2) return 'late night';
  return 'small hours';   // 2–5
}
// Name a run by coverage, not by its start hour. A window ≥12h spans too much
// of the clock for a single daypart — calling a "05:00–23:00" run "early
// morning" (its start) smells. Fold wide runs into a coverage label keyed to
// the window's midpoint: day-centered → "most of the day", night-centered →
// "most of the night". Narrow runs keep the start hour's daypart, which is
// representative because the window is short.
function windowLabel(run: { start: number; len: number }): { label: string; wide: boolean; night: boolean } {
  if (run.len >= 12) {
    const mid = (((run.start + run.len / 2) % 24) + 24) % 24;
    const night = !(mid >= 6 && mid < 18);
    return { label: night ? 'most of the night' : 'most of the day', wide: true, night };
  }
  return { label: daypartOf(run.start), wide: false, night: false };
}
function inWindow(h: number, start: number, end: number): boolean {
  const n = 24;
  const e = ((end % n) + n) % n;
  let cur = ((start % n) + n) % n;
  const target = Math.floor(((h % n) + n) % n);
  for (let k = 0; k < n; k++) {
    if (cur === target) return true;
    if (cur === e) break;
    cur = (cur + 1) % n;
  }
  return false;
}

interface Window { start: number; end: number; len: number; daypart: string; wide: boolean; night: boolean; }
interface Advisory {
  hasData: boolean;
  headline: string;
  detail: string;
  rightNow: 'prime' | 'warm' | 'dead' | 'neutral';
  rightNowText: string;
  prime: Window | null;
  dead: Window | null;
  bursts: boolean;
}

function buildAdvisory(stats: HourStat[], now: Date, selectedModel: string | null, currentDiscount: RealtimeDiscount | null): Advisory {
  const total = stats.reduce((a, s) => a + s.count, 0);
  const empty: Advisory = {
    hasData: false, headline: '', detail: '', rightNow: 'neutral', rightNowText: '',
    prime: null, dead: null, bursts: false,
  };
  // A single model has ~1/N the observations the pooled view does, so relax
  // the minimum gate proportionally — but never below a per-hour floor so a
  // half-empty clock still reads as "not enough history yet".
  const minTotal = selectedModel ? Math.max(24, 60 / TRACKED_MODELS.length) : 60;
  if (total < minTotal) return empty;

  const maxCount = Math.max(...stats.map(s => s.count));
  const minCount = Math.max(5, maxCount * 0.04);          // drop sparse hours
  // "good" = enough observations AND a deep-discount majority (≥50% are 75%-off,
  // or the average discount clears 58%). These are the hours worth aiming for.
  const goodFlags = stats.map(s => s.count >= minCount && (s.goodShare >= 0.5 || s.avg >= 58));
  // "dead" = sparse OR mostly shallow (deep-discount share < 30%) — the dry spell.
  const deadFlags = stats.map(s => s.count < minCount || s.goodShare < 0.3);
  const goodRuns = findRuns(goodFlags);
  const deadRuns = findRuns(deadFlags);

  // prime = strongest good run (most total observations, not just longest —
  // a long shallow run shouldn't beat a short deep one).
  let prime: Window | null = null;
  let primeStrength = -1;
  for (const r of goodRuns) {
    let strength = 0;
    let cur = r.start;
    for (let k = 0; k < 24; k++) { strength += stats[cur].count; if (cur === r.end) break; cur = (cur + 1) % 24; }
    if (strength > primeStrength) { const lbl = windowLabel(r); primeStrength = strength; prime = { ...r, daypart: lbl.label, wide: lbl.wide, night: lbl.night }; }
  }
  // dead = longest dead run
  let dead: Window | null = null;
  for (const r of deadRuns) if (!dead || r.len > dead.len) { const lbl = windowLabel(r); dead = { ...r, daypart: lbl.label, wide: lbl.wide, night: lbl.night }; }

  const localNowH = now.getHours() + now.getMinutes() / 60;

  // headline — the natural-language advisory, phrased by where the prime window
  // lands in the viewer's own day. Mirrors the colleague-style nudges: "wake a
  // bit earlier", "wait for the afternoon", "focused bursts".
  let headline: string;
  if (prime) {
    const range = `${fmtClock(prime.start)}–${fmtClock((prime.end + 1) % 24)}`;
    const start = fmtClock(prime.start);
    if (prime.wide) {
      headline = prime.night
        ? `Discounts run through most of your night — from ${range} — so the night shift pays off.`
        : `Discounts hold across most of your day — from ${range} — so you've got a wide, forgiving window.`;
    } else {
      switch (prime.daypart) {
        case 'early morning': headline = `Wake a little earlier — the steepest discounts land around ${range} your time.`; break;
        case 'morning':       headline = `Mornings are your sweet spot — aim for ${range}.`; break;
        case 'lunchtime':     headline = `Plan around lunch — discounts peak near ${range}.`; break;
        case 'afternoon':     headline = `Hold out for the afternoon — discounts build from ${start}.`; break;
        case 'evening':       headline = `Evenings pay off — the window opens around ${start}.`; break;
        case 'late night':    headline = `Night owl's bargain — the best cuts land near ${range}.`; break;
        default:              headline = `The small hours carry the deepest discounts — around ${range}.`; break;
      }
    }
  } else {
    headline = `Discounts are scattered across your day — skim the map for the strongest pocket.`;
  }

  // bursts = several short windows instead of one long one → batch heavy runs.
  const bursts = goodRuns.length >= 2 && (prime?.len ?? 0) < 7;

  // ── right-now nudge, grounded in the live discount ────────────────────────
  // The prime/dead windows come from historical local-hour stats; the nudge
  // must answer "what is Lilac charging *right now*?". A deep current deal
  // overrides a historically-dry window (flash sale), and a shallow current
  // deal tempers a historically-prime one (clock says go, but ~25% off this
  // minute — wait for the real cuts). 'warm' is the amber middle: not a blind
  // "go", not a full hold.
  type CurTier = 'deep' | 'modest' | 'priced' | 'unknown';
  const curTier: CurTier = currentDiscount == null
    ? 'unknown'
    : currentDiscount.percent >= 50 ? 'deep'
    : currentDiscount.percent > 0 ? 'modest'
    : 'priced';
  const pct = currentDiscount?.percent;
  const fragGo = pct != null ? `~${pct}% off right now, go.` : `deal live right now, go.`;
  const fragPct = pct != null ? `~${pct}% off, go.` : `go.`;
  let rightNow: Advisory['rightNow'] = 'neutral';
  let rightNowText = '';
  if (prime && inWindow(localNowH, prime.start, prime.end)) {
    if (curTier === 'deep') {
      rightNow = 'prime';
      rightNowText = `That's right now for you — ${fragPct}`;
    } else if (curTier === 'modest') {
      rightNow = 'warm';
      rightNowText = `Your prime window — but only ~${pct!}% off right now; the deep cuts come later.`;
    } else if (curTier === 'priced') {
      rightNow = 'warm';
      rightNowText = `Your prime window — but Lilac's at full price right now, wait for the cut.`;
    } else {
      // no live read available → keep the historical nudge but soften it
      rightNow = 'warm';
      rightNowText = `Your prime window right now — aim for the deep cuts.`;
    }
  } else if (dead && inWindow(localNowH, dead.start, dead.end)) {
    if (curTier === 'deep') {
      // historically a dry spell, but a live flash deal overrides it
      rightNow = 'prime';
      rightNowText = `Usually a dry spell here — but ${fragGo}`;
    } else {
      rightNow = 'dead';
      rightNowText = prime ? `Dry spell right now — hold off until ${fmtClock(prime.start)}.` : `Dry spell right now.`;
    }
  } else if (curTier === 'deep') {
    // no strong historical window at this hour, but there's a live deep deal — surface it
    rightNow = 'prime';
    rightNowText = prime
      ? `Outside your usual prime window — but ${fragGo}`
      : `No usual prime window here — but ${fragGo}`;
  }

  // supporting detail
  const parts: string[] = [];
  if (dead && dead.wide && prime) {
    const pr = `${fmtClock(prime.start)}–${fmtClock((prime.end + 1) % 24)}`;
    parts.push(`Most of your ${dead.night ? 'night' : 'day'} runs shallow, though — the deep cuts cluster in a tight ${prime.daypart} pocket (${pr}).`);
  } else if (dead && dead.len >= 3) {
    parts.push(`Prices run hot from ${fmtClock(dead.start)}–${fmtClock((dead.end + 1) % 24)} (${dead.daypart}) — avoid that stretch.`);
  }
  if (bursts && prime && !prime.wide) {
    parts.push(`Discounts arrive in focused bursts — batch your heavy runs into the ${prime.daypart} window rather than dripping all day.`);
  }
  const detail = parts.join(' ');

  return { hasData: true, headline, detail, rightNow, rightNowText, prime, dead, bursts };
}

// ── Dial geometry ────────────────────────────────────────────────────────────
// 24h clock: noon (12) at top with the sun, midnight (00) at bottom with the
// moon, 06 (dawn) at left, 18 (dusk) at right — clockwise. So the upper
// semicircle is the viewer's local daytime (06→18) and the lower is night
// (18→06). The discount-density ring is binned by local hour too, so the arc
// that lights up IS the prime window in the viewer's own day. Two hands mark
// local-now (sun/moon, gliding) and UTC-now (dashed) — the angular gap between
// them is the viewer's timezone offset, made visible.
const CX = 100, CY = 100, R = 92;
const R_RING_IN = 73, R_RING_OUT = 87;
const R_MARKER = 56;

function svgAngle(h: number): number {
  // 0° at +x (SVG), but we want 12:00 at top → rotate so h=12 → -π/2.
  return -Math.PI / 2 + ((h - 12) * Math.PI) / 12;
}
function ptXY(h: number, r: number): { x: number; y: number } {
  const a = svgAngle(h);
  return { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) };
}
function ringSegPath(h: number): string {
  const a0 = svgAngle(h - 0.5);
  const a1 = svgAngle(h + 0.5);
  const ri = R_RING_IN, ro = R_RING_OUT;
  const x0i = CX + ri * Math.cos(a0), y0i = CY + ri * Math.sin(a0);
  const x1i = CX + ri * Math.cos(a1), y1i = CY + ri * Math.sin(a1);
  const x1o = CX + ro * Math.cos(a1), y1o = CY + ro * Math.sin(a1);
  const x0o = CX + ro * Math.cos(a0), y0o = CY + ro * Math.sin(a0);
  return `M${x0i},${y0i} A${ri},${ri} 0 0 1 ${x1i},${y1i} L${x1o},${y1o} A${ro},${ro} 0 0 0 ${x0o},${y0o} Z`;
}

// Stars sprinkled in the night (lower) half — fixed positions so they don't
// reshuffle every render. Staggered twinkle via animation-delay in the loop.
const STARS: { x: number; y: number; r: number; d: number }[] = [
  { x: 38, y: 130, r: 1.1, d: 0.0 }, { x: 55, y: 150, r: 0.8, d: 0.6 },
  { x: 72, y: 138, r: 1.0, d: 1.2 }, { x: 88, y: 158, r: 0.7, d: 1.8 },
  { x: 108, y: 142, r: 1.2, d: 0.3 }, { x: 128, y: 156, r: 0.8, d: 0.9 },
  { x: 148, y: 132, r: 1.0, d: 1.5 }, { x: 162, y: 150, r: 0.7, d: 2.1 },
  { x: 30, y: 112, r: 0.7, d: 1.1 }, { x: 170, y: 116, r: 0.7, d: 1.4 },
];

export default function DiscountAdvisory({ timeSeries, selectedModel }: Props) {
  // Ticks every 10s so the sun/moon hand glides smoothly (CSS transition carries
  // the motion between ticks) instead of jumping minute-to-minute.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);

  const tz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; }
  }, []);
  const offsetStr = useMemo(() => fmtOffset(-now.getTimezoneOffset() / 60), [now]);

  const stats = useMemo(() => buildLocalHourStats(timeSeries, selectedModel), [timeSeries, selectedModel]);
  const currentDiscount = useMemo(() => currentDiscountFor(timeSeries, selectedModel, now), [timeSeries, selectedModel, now]);
  // A live deep deal is worth surfacing even before enough history accrues to
  // draw a prime-window pattern — so the advisory is never "blind" to a flash
  // sale just because the series is young.
  const liveGo = currentDiscount != null && currentDiscount.percent >= 50;
  const advisory = useMemo(() => buildAdvisory(stats, now, selectedModel, currentDiscount), [stats, now, selectedModel, currentDiscount]);

  const gid = 'adv-' + useId().replace(/:/g, '');

  const localNowH = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
  const utcNowH = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  const isDay = localNowH >= 6 && localNowH < 18;
  const marker = ptXY(localNowH, R_MARKER);
  const utcRim = ptXY(utcNowH, R);
  const utcInner = ptXY(utcNowH, R_RING_IN - 6);
  const maxCount = Math.max(1, ...stats.map(s => s.count));
  const minCount = Math.max(5, maxCount * 0.04);

  const prime = advisory.prime;
  const dead = advisory.dead;
  const localClock = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const utcClock = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}z`;

  // Local-now hand position as % of the 232×232 viewBox (origin -16,-16), for
  // the HTML sun/moon overlay that floats above the SVG.
  const markerLeft = ((marker.x + 16) / 232) * 100;
  const markerTop = ((marker.y + 16) / 232) * 100;

  return (
    <div className="card-surface p-5">
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="p-1.5 bg-accent/10 dark:bg-accent/15 rounded-lg">
            <SunHorizon weight="bold" size={16} className="text-accent" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 leading-none">
              When should you use Lilac?
            </h2>
            <p className="text-[11px] text-zinc-600 dark:text-zinc-400 mt-1">
              {selectedModel
                ? `your local read on ${MODEL_LABELS[selectedModel] || selectedModel}'s discounts — keyed to your browser timezone`
                : 'your local read on when the discounts land across all tracked models — keyed to your browser timezone'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          {tz && (
            <span className="metric-mono text-[10px] font-semibold text-zinc-600 dark:text-zinc-300 bg-zinc-100 dark:bg-white/[0.06] px-2 py-1 rounded-md">
              {tz}
            </span>
          )}
          <span className="metric-mono text-[10px] font-semibold text-accent bg-accent/10 px-2 py-1 rounded-md">
            {offsetStr}
          </span>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-5 items-start">
        {/* day / night 24h dial */}
        <div className="shrink-0 mx-auto sm:mx-0" style={{ width: 'min(220px, 70vw)' }}>
          <div className="relative" style={{ aspectRatio: '1 / 1' }}>
            <svg viewBox="-16 -16 232 232" style={{ width: '100%', height: '100%', display: 'block' }}>
              <defs>
                <linearGradient id={`${gid}-day`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" className="adv-stop-day-top" />
                  <stop offset="60%" className="adv-stop-day-mid" />
                  <stop offset="100%" className="adv-stop-day-low" />
                </linearGradient>
                <linearGradient id={`${gid}-night`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" className="adv-stop-night-top" />
                  <stop offset="100%" className="adv-stop-night-low" />
                </linearGradient>
                <clipPath id={`${gid}-upper`}><rect x="-20" y="-20" width="240" height="120" /></clipPath>
                <clipPath id={`${gid}-lower`}><rect x="-20" y="100" width="240" height="120" /></clipPath>
              </defs>

              {/* day sky (upper semicircle) */}
              <circle cx={CX} cy={CY} r={R} fill={`url(#${gid}-day)`} clipPath={`url(#${gid}-upper)`} />
              {/* night sky (lower semicircle) */}
              <circle cx={CX} cy={CY} r={R} fill={`url(#${gid}-night)`} clipPath={`url(#${gid}-lower)`} />

              {/* horizon line */}
              <line x1={CX - R} y1={CY} x2={CX + R} y2={CY} stroke="var(--border)" strokeWidth="1" opacity="0.7" />

              {/* stars in the night half */}
              <g clipPath={`url(#${gid}-lower)`}>
                {STARS.map((s, i) => (
                  <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#e2e8f0" className="advisory-star" style={{ animationDelay: `${s.d}s` }} />
                ))}
              </g>

              {/* sun's daytime arc (faint, dashed) — the path the sun marker rides */}
              <path
                d={`M ${CX - R_MARKER} ${CY} A ${R_MARKER} ${R_MARKER} 0 0 1 ${CX + R_MARKER} ${CY}`}
                fill="none" stroke="#f59e0b" strokeWidth="1" strokeDasharray="2 3" opacity="0.35"
              />

              {/* discount-density ring — binned by the viewer's LOCAL hour, so the
                  lit-up arc IS the prime window in their own day. */}
              <g>
                {stats.map((s, h) => {
                  if (s.count < minCount) return null;
                  const op = 0.18 + 0.72 * (s.count / maxCount);
                  const inPrime = prime && inWindow(h, prime.start, prime.end);
                  return (
                    <path
                      key={h}
                      d={ringSegPath(h)}
                      fill={discountColor(s.avg)}
                      opacity={inPrime ? Math.min(1, op + 0.15) : op}
                      stroke={inPrime ? discountColor(s.avg) : 'none'}
                      strokeWidth={inPrime ? 1 : 0}
                    />
                  );
                })}
              </g>

              {/* UTC-now hand (the "discount timezone") — dashed, so it reads as a
                  reference meridian vs the local sun. The gap between this and
                  the sun/moon is the viewer's offset, made visible on the dial. */}
              <line
                x1={utcInner.x} y1={utcInner.y} x2={utcRim.x} y2={utcRim.y}
                stroke="#f59e0b" strokeWidth="1.4" strokeDasharray="3 2" opacity="0.9"
              />
              <circle cx={utcRim.x} cy={utcRim.y} r="3" fill="#f59e0b" stroke="var(--surface)" strokeWidth="1.2" />

              {/* local-now hand (thin) — from center to the sun/moon marker */}
              <line x1={CX} y1={CY} x2={marker.x} y2={marker.y} stroke="var(--accent)" strokeWidth="1.2" opacity="0.55" />

              {/* hour ticks: 00 bottom, 06 left, 12 top, 18 right */}
              {[
                { h: 0, label: '00', anchor: 'middle', dx: 0, dy: 18 },
                { h: 6, label: '06', anchor: 'end', dx: -6, dy: 4 },
                { h: 12, label: '12', anchor: 'middle', dx: 0, dy: -8 },
                { h: 18, label: '18', anchor: 'start', dx: 6, dy: 4 },
              ].map(({ h, label, anchor, dx, dy }) => {
                const p = ptXY(h, R);
                return (
                  <text key={label} x={p.x + dx} y={p.y + dy} textAnchor={anchor as 'start'|'middle'|'end'} className="mercator-label" style={{ fontSize: '11px' }}>
                    {label}
                  </text>
                );
              })}

              {/* frame */}
              <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--border)" strokeWidth="1.5" />
            </svg>

            {/* sun / moon marker (HTML overlay so it can carry phosphor icons +
                a CSS glow + a smooth transition as it glides). */}
            <div
              className="advisory-dial-marker"
              style={{ left: `${markerLeft}%`, top: `${markerTop}%` }}
              aria-hidden
            >
              {isDay ? (
                <Sun weight="fill" size={24} className="advisory-sun-glow" color="#f59e0b" />
              ) : (
                <Moon weight="fill" size={22} className="advisory-moon-glow" color="#cbd5e1" />
              )}
            </div>
          </div>

          {/* dial legend */}
          <div className="mt-3 flex items-center justify-center gap-3 flex-wrap text-[10px] text-zinc-500 dark:text-zinc-400">
            <span className="flex items-center gap-1">
              <Sun weight="fill" size={11} color="#f59e0b" />
              <span className="metric-mono">{localClock} you</span>
            </span>
            <span className="text-zinc-300 dark:text-zinc-600">·</span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-0.5 bg-amber-500" style={{ backgroundImage: 'repeating-linear-gradient(90deg,#f59e0b 0 3px,transparent 3px 5px)' }} />
              <span className="metric-mono">{utcClock} Lilac</span>
            </span>
          </div>
        </div>

        {/* advisory text */}
        <div className="flex-1 min-w-0 flex flex-col">
          {advisory.hasData ? (
            <>
              <p className="text-[15px] leading-snug text-zinc-800 dark:text-zinc-100 font-medium">
                {advisory.headline}
              </p>
              {advisory.detail && (
                <p className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400 mt-2.5">
                  {advisory.detail}
                </p>
              )}

              {/* right-now pill */}
              {advisory.rightNow !== 'neutral' && (
                <div className="mt-3">
                  <span
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold"
                    style={
                      advisory.rightNow === 'prime'
                        ? { backgroundColor: 'rgba(5,150,105,0.12)', color: '#059669' }
                        : advisory.rightNow === 'warm'
                          ? { backgroundColor: 'rgba(217,119,6,0.12)', color: '#d97706' }
                          : { backgroundColor: 'rgba(220,38,38,0.10)', color: '#dc2626' }
                    }
                  >
                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: 'currentColor' }} />
                    {advisory.rightNowText}
                  </span>
                </div>
              )}

              {/* window chips */}
              <div className="mt-4 flex flex-wrap gap-2">
                {prime && (
                  <div className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5" style={{ borderColor: 'rgba(5,150,105,0.3)', backgroundColor: 'rgba(5,150,105,0.06)' }}>
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#059669' }} />
                    <span className="text-[10px] font-medium text-zinc-600 dark:text-zinc-300">prime</span>
                    <span className="metric-mono text-[11px] font-semibold text-zinc-800 dark:text-zinc-100">
                      {fmtClock(prime.start)}–{fmtClock((prime.end + 1) % 24)}
                    </span>
                    <span className="text-[10px] text-zinc-500 dark:text-zinc-400">{prime.daypart}</span>
                  </div>
                )}
                {dead && dead.len >= 3 && (
                  <div className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5" style={{ borderColor: 'rgba(220,38,38,0.25)', backgroundColor: 'rgba(220,38,38,0.05)' }}>
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#dc2626' }} />
                    <span className="text-[10px] font-medium text-zinc-600 dark:text-zinc-300">avoid</span>
                    <span className="metric-mono text-[11px] font-semibold text-zinc-800 dark:text-zinc-100">
                      {fmtClock(dead.start)}–{fmtClock((dead.end + 1) % 24)}
                    </span>
                    <span className="text-[10px] text-zinc-500 dark:text-zinc-400">{dead.daypart}</span>
                  </div>
                )}
              </div>

              <p className="mt-4 text-[10px] leading-relaxed text-zinc-500 dark:text-zinc-400 flex items-start gap-1.5">
                <ArrowUpRight size={12} weight="bold" className="text-zinc-400 dark:text-zinc-500 shrink-0 mt-0.5" />
                Lilac bills in UTC — the dashed hand is "Lilac time" right now. The arc it sits on is your local day, tinted by how often each hour actually carried a discount. The sun is your local clock; the gap between sun and dashed hand is your timezone offset, made visible.
              </p>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-full min-h-[120px]">
              <p className="text-[12px] text-zinc-400 dark:text-zinc-500 text-center leading-relaxed max-w-[280px]">
                Not enough discount history yet to advise you{selectedModel ? ` on ${MODEL_LABELS[selectedModel] || selectedModel}` : ''}. Once the tracker has a day or two of snapshots, your personalized best-time window will appear here.
              </p>
              {liveGo && (
                <div className="mt-3 flex justify-center">
                  <span
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold"
                    style={{ backgroundColor: 'rgba(5,150,105,0.12)', color: '#059669' }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: 'currentColor' }} />
                    Live deal right now — ~{currentDiscount!.percent}% off, go{selectedModel ? '' : ' (best model)'}.
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
