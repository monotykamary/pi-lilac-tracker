import { useMemo, useRef, useEffect, useState } from 'react';
import {
  createChart, ColorType, CrosshairMode, CandlestickSeries, LineSeries, LineStyle,
} from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp, Time } from 'lightweight-charts';
import { TRACKED_MODELS, MODEL_LABELS } from '../types';
import type { ModelSnapshot } from '../types';

// Hedge-fund-grade candlestick card on TradingView Lightweight Charts™.
//
// This charts a SYNTHETIC "Lilac Discount Index" — a fun market perspective,
// not a literal metric. Here is why it has to be synthetic:
//
// Every raw Lilac signal is too smooth or too quantized to candle naturally:
//   - credit_multiplier / discount_percent: quantized to 4 steps → flat
//     candles pinned to 4 levels, or long-wicked step candles.
//   - tps / ttfb: smooth slow drifts (tick-to-tick change ~0.002%, ~0%
//     sign-flips once averaged into the market index) → no intra-candle
//     movement, so no bodies and no wicks.
// No bucket size or metric blend fixes this; the data has no high-frequency
// variation. So we render a mean-reverting (Ornstein-Uhlenbeck) price
// tracking a target derived from the REAL discount level — see buildIndex:
//
//   smoothedDiscount = rollingMean(discount, MA_W)   // smooth quantized jumps
//   target_t   = BASE * (1 + SLOPE * smoothedDiscount_t / 100)
//   price_t    = price_{t-1} + KAPPA*(target_t - price_{t-1}) + NOISE_t
//
//   - TREND (target): the REAL per-tick discount, smoothed. When the discount
//     deepens the target rises; when it shrinks the target falls — exactly
//     the directional semantics requested, so models with opposite discount
//     trends render in opposite directions. Smoothing turns Lilac's quantized
//     ±25/50/75% jumps into a gradual level (a random walk of Δdiscount made
//     single-tick 57% spikes; mean-reversion caps candles at ~10%).
//   - NOISE: white noise (OU stationary σ), seeded per model (hash of the
//     model id). Per-model seed so each model gets a distinct realization —
//     without it every model shared one noise sequence and looked identical.
//   The raw signals' near-zero volatility can't form candles, so the wicks
//     are synthetic; the trend is real.
//
// It is honestly a synthetic/artistic rendering: the trend is real, the
// wicks are synthetic. We state this plainly rather than imply the raw
// metrics oscillate the way a market does. Candles are non-overlapping
// sample-count buckets sized to a target count; inactive polling gaps are
// collapsed so active sessions read consecutively. MA20 (amber) + MA50 (sky).

type CandleDensity = 60 | 120 | 240;

const DENSITY_OPTIONS: { id: CandleDensity; label: string }[] = [
  { id: 240, label: '240' },
  { id: 120, label: '120' },
  { id: 60, label: '60' },
];

const UP_COLOR = '#26a69a';   // teal-green (TradingView up)
const DOWN_COLOR = '#ef5350'; // red (TradingView down)
const WICK_UP = '#26a69a';
const WICK_DOWN = '#ef5350';

const MA_FAST_COLOR = '#f59e0b'; // amber — MA20
const MA_SLOW_COLOR = '#3b82f6'; // sky   — MA50
const MA_FAST_PERIOD = 20;
const MA_SLOW_PERIOD = 50;

// Index-construction parameters, tuned against the real snapshot series.
// The price is an Ornstein-Uhlenbeck (mean-reverting) process tracking a slow
// target derived from the REAL discount level:
//
//   smoothedDiscount = rollingMean(discount, MA_W)         // smooths the
//                                                    // ±25/50/75% quantized jumps
//   target_t   = BASE * (1 + SLOPE * smoothedDiscount_t / 100)
//   noise_t    = slow_t + fast_t                       (two OU streams, below)
//   price_t    = target_t + noise_t
//
// Why OU and not a random walk: Lilac's discount jumps in ±25/50/75 quanta, so
// differencing it (random walk of Δdiscount) produced single-tick 57% price
// spikes — the unnatural 100→65→100 candles. A SMOOTHED target drives a
// gradual trend instead of cliffs, and mean-reverting noise keeps candles
// bounded (~10–20% max move).
//
// Two noise streams (the fix for missing wicks): a single OU noise mean-reverts
// symmetrically, so the bucket high/low often lands ON the open/close tick →
// zero-length wick (23% of candles were wickless). Splitting noise into a SLOW
// OU (low κ → autocorrelated, drives candle BODIES/direction) plus a FAST OU
// (high κ → oscillates within a bucket → high/low land mid-bucket → real
// WICKS) cuts wickless candles to ~5% and gives natural body+wick shapes.
//
//   - SLOPE: target sensitivity to discount. A 50% discount swing → ~60%
//           target move, enough that rising-discount models trend up and
//           falling-discount models trend down (opposite trends, opposite
//           directions).
//   - SLOW (K1/S1): low mean-reversion → autocorrelated → candle bodies.
//   - FAST (K2/S2): high mean-reversion → intra-bucket oscillation → wicks.
//   - Seeds are per model (hash of model id) so each model gets a distinct
//     realization — without this every model shared one noise sequence and
//     looked identical.
//   - MA_W: rolling-mean window on the raw discount — turns the quantized
//           ±75% jumps into a smooth level so the target drifts gradually.
const SLOPE = 1.2;    // target = BASE*(1 + SLOPE*disc/100)
const MA_W = 40;     // rolling-mean window for the discount level
const BASE_PRICE = 100;
// Slow OU (bodies/direction): low κ → autocorrelated noise drives the open↔close.
const K1 = 0.02, S1 = 0.6;
// Fast OU (wicks): high κ → oscillates within a bucket → high/low off the body.
const K2 = 0.5, S2 = 3.0;

interface Point { timestamp: string; snapshot: ModelSnapshot }

interface Tick {
  realTime: number; // ms since epoch
  discount: number; // discount_percent (per-model, or cross-model average)
}

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  realTime: number; // real timestamp of the candle's close tick
}

// Integer hash → uniform in [-1, 1]. Deterministic so the synthetic series is
// stable across renders (no flicker when data/props update).
function hash(n: number): number {
  let h = (n * 2654435761) >>> 0;
  h ^= h >>> 13;
  h = (h * 1597334677) >>> 0;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

// Per-model noise seed: hash the model id (or 'market' for the aggregate) so
// each model gets a distinct volatility realization. This is what makes
// models look different from each other; without it the seed was just the
// tick index and every model shared one noise sequence.
function seedForId(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function collectTicks(points: Point[]): Tick[] {
  // Average discount across models present in each snapshot for the market
  // index; for a single model the caller passes only that model's points.
  const out: Tick[] = [];
  // Group by timestamp: merge points sharing a timestamp into one tick.
  const byTs = new Map<number, { sumDisc: number; count: number }>();
  for (const p of points) {
    const t = new Date(p.timestamp).getTime();
    const m = p.snapshot;
    if (typeof m.discount_percent !== 'number' || !isFinite(m.discount_percent)) continue;
    let e = byTs.get(t);
    if (!e) { e = { sumDisc: 0, count: 0 }; byTs.set(t, e); }
    e.sumDisc += m.discount_percent;
    e.count++;
  }
  for (const [t, e] of [...byTs.entries()].sort((a, b) => a[0] - b[0])) {
    out.push({ realTime: t, discount: e.sumDisc / e.count });
  }
  return out;
}

// Rolling mean of the raw discount level — smooths the quantized ±25/50/75%
// jumps into a gradual level so the target drifts instead of cliff-jumping.
function rollingMean(vals: number[], w: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= w) sum -= vals[i - w];
    out.push(i >= w - 1 ? sum / w : sum / (i + 1));
  }
  return out;
}

// Build the synthetic price index = smooth target (from the REAL discount)
// plus two mean-reverting (Ornstein-Uhlenbeck) noise streams: a slow one for
// candle bodies/direction and a fast one for wicks. See the parameter comment
// above for why each piece is here. Mean-reversion (not a random walk) bounds
// per-tick moves so candles stay natural; the two-κ split keeps wicks visible.
function buildIndex(ticks: Tick[], seedOffset: number): number[] {
  if (ticks.length === 0) return [];
  const discs = ticks.map(t => t.discount);
  const smoothed = rollingMean(discs, MA_W);
  let z1 = 0, z2 = 0;
  const n1 = S1 * Math.sqrt(2 * K1);
  const n2 = S2 * Math.sqrt(2 * K2);
  const prices: number[] = [BASE_PRICE * (1 + SLOPE * smoothed[0] / 100)];
  for (let i = 1; i < ticks.length; i++) {
    z1 = K1 * (0 - z1) + n1 * hash(seedOffset + i * 7919);
    z2 = K2 * (0 - z2) + n2 * hash(seedOffset + i * 7919 + 1);
    const target = BASE_PRICE * (1 + SLOPE * smoothed[i] / 100);
    prices.push(target + z1 + z2);
  }
  return prices;
}

// NON-overlapping sample-count buckets sized to a target candle count.
function bucketCandles(prices: number[], realTimes: number[], target: number): Candle[] {
  if (prices.length < 2) return [];
  const w = Math.max(2, Math.floor(prices.length / target));
  const candles: Candle[] = [];
  for (let i = 0; i + w <= prices.length; i += w) {
    let high = -Infinity;
    let low = Infinity;
    for (let j = i; j < i + w; j++) {
      const v = prices[j];
      if (v > high) high = v;
      if (v < low) low = v;
    }
    candles.push({
      open: prices[i],
      high, low,
      close: prices[i + w - 1],
      realTime: realTimes[i + w - 1],
    });
  }
  return candles;
}

// Simple moving average over an array, returning nulls until the period fills.
function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const mo = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  const hr = d.getHours().toString().padStart(2, '0');
  const min = d.getMinutes().toString().padStart(2, '0');
  return `${mo}/${day} ${hr}:${min}`;
}

interface CandlestickCardProps {
  timeSeries: Record<string, { timestamp: string; snapshot: ModelSnapshot; supply_updated_at: string | null }[]>;
  selectedModel: string | null;
  onSelectModel: (id: string) => void;
}

export default function CandlestickCard({ timeSeries, selectedModel, onSelectModel }: CandlestickCardProps) {
  const [density, setDensity] = useState<CandleDensity>(60);
  const [showMA, setShowMA] = useState(true);
  const [isDark, setIsDark] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const maFastRef = useRef<ISeriesApi<'Line'> | null>(null);
  const maSlowRef = useRef<ISeriesApi<'Line'> | null>(null);
  // Real-time lookup for the gap-collapsing synthetic axis. Index = bar index.
  const realTimesRef = useRef<number[]>([]);
  // True when data has been set but the time scale hasn't been fit yet (e.g.
  // data arrived before the container had a real width). The creation effect's
  // ResizeObserver fits once width arrives; the data-push effect fits eagerly
  // if width is already present.
  const needsFitRef = useRef(true);
  // Latest derived series, pushed into the chart on creation AND on data change.
  // The creation effect re-runs when the theme toggles (the theme MutationObserver
  // fires on mount too), recreating the chart with fresh EMPTY series — but the
  // data-push effect doesn't re-fire (candleData unchanged), so the chart stayed
  // blank until a density change. Pushing latestDataRef after setup fixes that.
  const latestDataRef = useRef<{ candle: typeof candleData; fast: typeof maFastData; slow: typeof maSlowData } | null>(null);

  useEffect(() => {
    const check = () => setIsDark(document.documentElement.classList.contains('dark'));
    check();
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  const candles = useMemo(() => {
    let pts: Point[];
    if (selectedModel) {
      pts = (timeSeries[selectedModel] || []) as Point[];
    } else {
      const merged: Point[] = [];
      for (const id of TRACKED_MODELS) {
        for (const p of (timeSeries[id] || []) as Point[]) {
          merged.push({ timestamp: p.timestamp, snapshot: p.snapshot });
        }
      }
      merged.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      pts = merged;
    }
    const ticks = collectTicks(pts);
    const prices = buildIndex(ticks, seedForId(selectedModel ?? 'market'));
    const realTimes = ticks.map(t => t.realTime);
    return bucketCandles(prices, realTimes, density);
  }, [timeSeries, selectedModel, density]);

  // Derive series with synthetic sequential time (gap-free axis).
  const { candleData, maFastData, maSlowData } = useMemo(() => {
    const cdata = candles.map((c, i) => ({
      time: i as UTCTimestamp,
      open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    const closes = candles.map(c => c.close);
    const fastRaw = sma(closes, MA_FAST_PERIOD);
    const slowRaw = sma(closes, MA_SLOW_PERIOD);
    const toLine = (arr: (number | null)[]) =>
      candles.map((_, i) => ({ time: i as UTCTimestamp, value: arr[i] }))
        .filter(p => p.value !== null) as { time: UTCTimestamp; value: number }[];
    return { candleData: cdata, maFastData: toLine(fastRaw), maSlowData: toLine(slowRaw) };
  }, [candles]);

  // Keep real-time lookup in sync for the synthetic-axis formatters.
  useEffect(() => {
    realTimesRef.current = candles.map(c => c.realTime);
  }, [candles]);

  // Create the chart once on mount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const realTimeLabel = (t: Time): string => {
      const idx = Math.round(Number(t));
      const rt = realTimesRef.current[idx];
      return rt !== undefined ? fmtTime(rt) : '';
    };

    const chart = createChart(container, {
      width: container.clientWidth,
      height: 320,
      // No autoSize: we manage sizing ourselves in the ResizeObserver below so
      // we control the order (resize THEN fitContent). With autoSize, its
      // internal observer raced ours — fitContent ran at stale 0-width on first
      // load and the candles stayed off-screen until a density button forced a
      // re-fit.
      autoSize: false,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: isDark ? '#a1a1aa' : '#71717a',
        fontFamily: "'Geist Mono', 'JetBrains Mono', monospace",
        fontSize: 10,
        attributionLogo: false,
      },
      localization: {
        timeFormatter: (t: Time) => realTimeLabel(t),
      },
      timeScale: {
        borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 3,
        minBarSpacing: 2,
        // Synthetic bar index → real tick date, so the gap-collapsed axis
        // still reads truthfully on tick marks and the crosshair label.
        tickMarkFormatter: (t: Time) => realTimeLabel(t),
      },
      grid: {
        // Minimal canvas — faint horizontal grid only, no vertical lines, to
        // match the clean reference look rather than a busy terminal panel.
        vertLines: { visible: false },
        horzLines: { color: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.05)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)', width: 1, style: LineStyle.Dashed, labelBackgroundColor: isDark ? '#3f3f46' : '#3b82f6' },
        horzLine: { color: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)', width: 1, style: LineStyle.Dashed, labelBackgroundColor: isDark ? '#3f3f46' : '#3b82f6' },
      },
      rightPriceScale: {
        borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
        scaleMargins: { top: 0.10, bottom: 0.10 },
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      wickUpColor: WICK_UP,
      wickDownColor: WICK_DOWN,
      borderVisible: true,
      priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
    });

    const maFastSeries = chart.addSeries(LineSeries, {
      color: MA_FAST_COLOR,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
    });
    const maSlowSeries = chart.addSeries(LineSeries, {
      color: MA_SLOW_COLOR,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    maFastRef.current = maFastSeries;
    maSlowRef.current = maSlowSeries;

    // Size the chart to its container and fit the time scale. We own sizing
    // (no autoSize) so resize + fitContent happen in a deterministic order:
    // chart.resize(forceRepaint=true) updates the chart's internal width
    // synchronously, THEN fitContent lays out the candles. On first mount the
    // container often starts at 0 width (the grid hasn't laid out yet), so we
    // keep re-fitting until width arrives, then stop (so later user zoom/pan
    // isn't clobbered). Density switches set needsFit and re-fit directly.
    const resizeAndFit = (forceFit: boolean) => {
      if (container.clientWidth === 0) return;
      chart.resize(container.clientWidth, 320, true);
      if (forceFit || needsFitRef.current) {
        chart.timeScale().fitContent();
        needsFitRef.current = false;
      }
    };
    // Initial size + fit once data is present.
    resizeAndFit(true);
    // If data was already derived (e.g. the chart was recreated by a theme
    // toggle AFTER initial mount), push it now — the data-push effect won't
    // re-fire because candleData is unchanged, so without this the recreated
    // chart stays empty.
    const d = latestDataRef.current;
    if (d) {
      candleSeries.setData(d.candle);
      maFastSeries.setData(d.fast);
      maSlowSeries.setData(d.slow);
      needsFitRef.current = true;
      resizeAndFit(true);
    }
    // On resize, resize always; fit only when data is pending a fit so we
    // don't clobber user zoom/pan on later window resizes.
    const ro = new ResizeObserver(() => resizeAndFit(false));
    ro.observe(container);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      maFastRef.current = null;
      maSlowRef.current = null;
    };
  }, [isDark]);

  // Push data when series change.
  useEffect(() => {
    latestDataRef.current = { candle: candleData, fast: maFastData, slow: maSlowData };
    const chart = chartRef.current;
    const container = containerRef.current;
    if (!chart || !container) return;
    candleSeriesRef.current?.setData(candleData);
    maFastRef.current?.setData(maFastData);
    maSlowRef.current?.setData(maSlowData);
    // Mark that a fit is needed; if the container already has width, fit now.
    // Otherwise the ResizeObserver in the creation effect will fit once layout
    // gives us a real width (the first-load case).
    needsFitRef.current = true;
    if (container.clientWidth > 0) {
      chart.resize(container.clientWidth, 320, true);
      chart.timeScale().fitContent();
      needsFitRef.current = false;
    }
  }, [candleData, maFastData, maSlowData]);

  // Toggle MA visibility.
  useEffect(() => {
    maFastRef.current?.applyOptions({ visible: showMA });
    maSlowRef.current?.applyOptions({ visible: showMA });
  }, [showMA]);

  const candleCount = candleData.length;

  return (
    <div className="card-surface p-5">
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Discount Index</h2>
            <span className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wide">
              {selectedModel ? (MODEL_LABELS[selectedModel] || selectedModel) : 'all models · market index'}
            </span>
            <span className="text-[10px] text-zinc-400 dark:text-zinc-500 metric-mono" title="Synthetic Lilac Discount Index — a fun market perspective. Trend driven by real discount changes; wicks are synthetic volatility, since the raw metrics are too smooth to candle naturally.">
              synthetic
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowMA(v => !v)}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors border ${
              showMA
                ? 'border-amber-400/40 bg-amber-400/10 text-amber-600 dark:text-amber-400'
                : 'border-zinc-200/60 dark:border-white/[0.06] bg-zinc-100 dark:bg-white/[0.06] text-zinc-500 dark:text-zinc-400'
            }`}
            title="Toggle moving averages"
          >
            MA 20/50
          </button>
          <div className="flex items-center gap-1 p-0.5 rounded-lg bg-zinc-100 dark:bg-white/[0.06] border border-zinc-200/60 dark:border-white/[0.06]">
            {DENSITY_OPTIONS.map(opt => (
              <button
                key={opt.id}
                onClick={() => setDensity(opt.id)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  density === opt.id
                    ? 'bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 shadow-sm'
                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300'
                }`}
                title={`~${opt.id} candles`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div ref={containerRef} className="w-full min-w-0" style={{ height: 320 }} />

      <div className="flex items-center gap-4 mt-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: UP_COLOR }} />
          <span className="text-[10px] text-zinc-500 dark:text-zinc-400 font-medium uppercase tracking-wide">up</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: DOWN_COLOR }} />
          <span className="text-[10px] text-zinc-500 dark:text-zinc-400 font-medium uppercase tracking-wide">down</span>
        </div>
        {showMA && (
          <>
            <span className="text-zinc-300 dark:text-zinc-600">·</span>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 rounded" style={{ backgroundColor: MA_FAST_COLOR }} />
              <span className="text-[10px] text-zinc-500 dark:text-zinc-400 font-medium uppercase tracking-wide">MA{MA_FAST_PERIOD}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 rounded" style={{ backgroundColor: MA_SLOW_COLOR }} />
              <span className="text-[10px] text-zinc-500 dark:text-zinc-400 font-medium uppercase tracking-wide">MA{MA_SLOW_PERIOD}</span>
            </div>
          </>
        )}
        <span className="text-[10px] text-zinc-400 dark:text-zinc-500 ml-auto">
          {candleCount} candles · {selectedModel ? 'click a model card to switch' : 'market index of all models'}
          {!selectedModel && (
            <button
              onClick={() => onSelectModel(TRACKED_MODELS[0])}
              className="ml-2 text-accent hover:underline"
            >
              isolate a model
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
