import { useState, useMemo, useCallback, useEffect, useDeferredValue } from 'react';
import { motion } from 'framer-motion';
import {
  Sun, Moon, ChartBar, ArrowClockwise,
} from '@phosphor-icons/react';
import { useTheme } from './hooks/useTheme';
import { useServerStatus, useSnapshots } from './hooks/useApi';
import { MODEL_LABELS, MODEL_COLORS, TRACKED_MODELS } from './types';
import type { Snapshot, ModelSnapshot } from './types';
import ModelCard from './components/ModelCard';
import TimelineChart from './components/TimelineChart';
import StateTimeline from './components/StateTimeline';
import CandlestickCard from './components/CandlestickCard';
import DataSummary from './components/DataSummary';
import DiscountMercator from './components/DiscountMercator';
import DiscountAdvisory from './components/DiscountAdvisory';

// Module-level extractors / formatters / y-domains for the timeline charts.
// Defined once so their references never change between renders — keeping the
// charts' React.memo + useMemo deps stable, so a status-poll re-render of App
// (every ~10s) no longer busts every chart's data memo and re-pivots 6MB.
const extractDiscount = (m: ModelSnapshot) => m.discount_percent;
const extractTps = (m: ModelSnapshot) => m.tps;
const extractTtfb = (m: ModelSnapshot) => m.ttfb_seconds;
const extractUptime = (m: ModelSnapshot) => m.uptime_pct;
const fmtInt0 = (v: number) => v.toFixed(0);
const fmt1 = (v: number) => v.toFixed(1);
const fmt2 = (v: number) => v.toFixed(2);
const Y_DOMAIN_DISCOUNT: [number, number] = [0, 100];
const Y_DOMAIN_UPTIME: [number, number] = [99, 100.1];

// Tailwind class registry — ensures utilities from component files are generated
// since Tailwind v4's scanner doesn't discover files in src/components/
function _TailwindSafelist() {
  return (
    <div className="hidden">
      <div className="p-5 gap-2.5 mb-5 space-y-4 w-1/2 pr-3 pl-3 border-l mb-0.5" />
      <div className="h-9 space-y-2.5 w-24 rounded-lg mb-5 justify-between" />
      <div className="h-[280px] min-w-0" />
      <div className="p-4" />
    </div>
  );
}

export default function App() {
  const { theme, toggle } = useTheme();
  const serverStatus = useServerStatus();
  const { snapshots, loading, error, refetch } = useSnapshots(
    30000,
    7,
    serverStatus?.snapshot_count ?? null,
  );
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  // Stable model-selection toggle shared by every card/chart that selects a
  // model. A single useCallback so none of them receive a fresh closure per
  // render (which would defeat their React.memo).
  const toggleModel = useCallback((id: string | null) => {
    setSelectedModel((prev) => (id == null ? null : prev === id ? null : id));
  }, []);

  const modelTimeSeries = useMemo(() => {
    const series: Record<string, { timestamp: string; snapshot: ModelSnapshot; supply_updated_at: string | null }[]> = {};
    for (const id of TRACKED_MODELS) {
      series[id] = [];
    }
    for (const snap of snapshots as Snapshot[]) {
      for (const [id, model] of Object.entries(snap.models)) {
        if (series[id]) {
          series[id].push({ timestamp: snap.timestamp, snapshot: model, supply_updated_at: snap.supply_updated_at });
        }
      }
    }
    return series;
  }, [snapshots]);

  // Deferred copy of the series for the heavy below-the-fold charts. On a
  // data refresh React paints the urgent pass with the previous series (top
  // of page + cards update immediately) and the charts re-pivot the new series
  // at lower priority — keeping the ~30s refresh jank-free.
  const deferredTimeSeries = useDeferredValue(modelTimeSeries);

  const latestByModel = useMemo(() => {
    const latest: Record<string, ModelSnapshot | null> = {};
    for (const id of TRACKED_MODELS) {
      const s = modelTimeSeries[id];
      latest[id] = s.length > 0 ? s[s.length - 1].snapshot : null;
    }
    return latest;
  }, [modelTimeSeries]);

  const lastSnapshot: Snapshot | null = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

  // Lazy-mount the below-the-fold heavy sections (state timeline, candlestick,
  // advisory, mercator, the four recharts) after first paint. They all do O(n)
  // derived work; mounting them in the next idle frame lets the initial render
  // commit the header + summary + model cards without blocking on pivoting
  // ~6MB of snapshots. Stays true once set, so later updates run normally.
  const [heavyReady, setHeavyReady] = useState(false);
  useEffect(() => {
    if (heavyReady || snapshots.length === 0) return;
    const run = () => setHeavyReady(true);
    const ric = window.requestIdleCallback;
    if (typeof ric === 'function') {
      const handle = ric(run, { timeout: 300 });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(run, 0);
    return () => window.clearTimeout(handle);
  }, [heavyReady, snapshots.length]);

  return (
    <div className="h-dvh flex flex-col overflow-hidden bg-[#fafafa] dark:bg-[#18181b]">
      <_TailwindSafelist />
      <header className="sticky top-0 z-40 bg-[#fafafa] dark:bg-[#18181b] border-b border-zinc-200/60 dark:border-white/[0.08]">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-3 sm:py-4 flex flex-wrap items-center justify-between gap-y-2">
          <div className="flex items-center gap-3 shrink-0">
            <div className="p-2 bg-accent/10 dark:bg-accent/15 rounded-xl">
              <ChartBar weight="bold" size={22} className="text-accent" />
            </div>
            <div className="hidden sm:block">
              <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-300 leading-none">lilac-tracker</h1>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-400 font-medium tracking-wide mt-0.5">SUPPLY & DISCOUNT MONITOR</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {serverStatus && (
              <div className="flex items-center gap-1.5 bg-white/60 dark:bg-zinc-800/40 border border-zinc-200/60 dark:border-white/[0.06] rounded-lg px-2.5 py-1.5">
                <div className={`w-1.5 h-1.5 rounded-full ${serverStatus.polling ? 'bg-moss animate-pulse' : 'bg-ember'}`} />
                <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 metric-mono">
                  {serverStatus.snapshot_count} snapshots
                </span>
                {serverStatus.fast_mode && (
                  <span className="text-[10px] font-medium text-amber bg-amber/10 px-1.5 py-0.5 rounded-md">FAST</span>
                )}
              </div>
            )}

            <button
              onClick={refetch}
              className="p-2 rounded-lg text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/[0.06] transition-colors"
              title="Refresh data"
            >
              <ArrowClockwise size={16} weight="bold" />
            </button>

            <button
              onClick={toggle}
              className="p-2 rounded-lg text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/[0.06] transition-colors"
              title="Toggle theme"
            >
              {theme === 'dark' ? <Sun size={16} weight="bold" /> : <Moon size={16} weight="bold" />}
            </button>
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && snapshots.length === 0 ? (
          <div className="flex items-center justify-center min-h-[60dvh]">
            <div className="flex flex-col items-center gap-4">
              <div className="w-10 h-10 border-2 border-zinc-200 dark:border-white/[0.06] border-t-accent rounded-full animate-spin" />
              <p className="text-sm text-zinc-400 dark:text-zinc-400 font-medium">Loading snapshots…</p>
            </div>
          </div>
        ) : error && snapshots.length === 0 ? (
          <div className="flex items-center justify-center min-h-[60dvh] px-4">
            <div className="text-center">
              <p className="text-sm text-ember font-medium mb-2">Failed to load data</p>
              <p className="text-xs text-zinc-400 mb-4">{error}</p>
              <p className="text-xs text-zinc-400">
                Make sure the server is running: <code className="metric-mono bg-zinc-100 dark:bg-white/[0.06] px-1.5 py-0.5 rounded">npm run dev:server</code>
              </p>
            </div>
          </div>
        ) : snapshots.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center justify-center min-h-[70dvh] px-4 sm:px-6"
          >
            <div className="max-w-md w-full text-center p-12 rounded-[2.5rem] border-2 border-dashed border-zinc-200 dark:border-white/[0.06] bg-white dark:bg-zinc-800/40">
              <div className="w-16 h-16 mx-auto mb-6 bg-zinc-50 dark:bg-white/[0.06] rounded-3xl flex items-center justify-center">
                <ChartBar size={28} className="text-zinc-300 dark:text-zinc-400" weight="duotone" />
              </div>
              <h2 className="text-xl font-semibold text-zinc-700 dark:text-zinc-300 mb-2">No snapshots yet</h2>
              <p className="text-sm text-zinc-400 mb-6 leading-relaxed">
                The server is running and will begin polling the Lilac status API. Data will appear here automatically.
              </p>
              <p className="text-xs text-zinc-400">
                Set <code className="metric-mono bg-zinc-100 dark:bg-white/[0.06] px-1.5 py-0.5 rounded">LILAC_API_KEY</code> in your <code className="metric-mono bg-zinc-100 dark:bg-white/[0.06] px-1.5 py-0.5 rounded">.env</code> file if you haven't already.
              </p>
            </div>
          </motion.div>
        ) : (
          <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-6">
            <DataSummary
              snapshotCount={snapshots.length}
              lastTimestamp={lastSnapshot?.timestamp ?? null}
              supplyUpdatedAt={lastSnapshot?.supply_updated_at ?? null}
              serverStatus={serverStatus}
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {TRACKED_MODELS.map(id => (
                <ModelCard
                  key={id}
                  modelId={id}
                  latest={latestByModel[id]}
                  isSelected={selectedModel === id}
                  onToggle={toggleModel}
                />
              ))}
            </div>

            {heavyReady ? (
              <>
                <StateTimeline
                  timeSeries={deferredTimeSeries}
                  selectedModel={selectedModel}
                />

                <CandlestickCard
                  timeSeries={deferredTimeSeries}
                  selectedModel={selectedModel}
                  onSelectModel={toggleModel}
                  theme={theme}
                />

                <section>
                  <DiscountAdvisory timeSeries={deferredTimeSeries} selectedModel={selectedModel} />
                  <div className="mt-6">
                    <DiscountMercator
                      timeSeries={deferredTimeSeries}
                      selectedModel={selectedModel}
                      onSelectModel={toggleModel}
                    />
                  </div>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-3 leading-relaxed">
                    The world's longitudes <em>are</em> time of day — but not yours: each longitude's <span className="font-medium text-zinc-700 dark:text-zinc-300">local-noon time</span> is the UTC moment the sun crosses it (noon at −120° happens at 20:00z, at 0° at 12:00z, at +120° at 04:00z). Lilac's discounts are global events keyed to UTC, so the question this map answers is: <em>where on earth is it local noon when the discount fires?</em> Each snapshot is attributed to the longitude at local noon at that UTC moment, then painted onto the actual continents — so the map IS the data, not a backdrop. Default view is <span className="font-medium text-zinc-700 dark:text-zinc-300">all</span> tiers (each longitude colored by its dominant tier); pick a single tier to isolate it. The Americas light up, because Lilac's discounts cluster in the UTC afternoon/evening = the Americas' daytime. The dashed line is the meridian at local noon right now, sweeping west as the earth rotates. The <span className="font-medium text-zinc-700 dark:text-zinc-300">day/night</span> overlay shades the live night side (longitudes &gt;90° from that noon meridian) with a soft twilight band — the same sweep, made visible as light and dark across the continents; toggle it off for a pure-data view. Continents tint as days accrue.
                  </p>
                </section>

                <TimelineChart
                  title="Discount Rate"
                  timeSeries={deferredTimeSeries}
                  selectedModel={selectedModel}
                  extractValue={extractDiscount}
                  unit="%"
                  yDomain={Y_DOMAIN_DISCOUNT}
                  colorByModel={MODEL_COLORS}
                  labelByModel={MODEL_LABELS}
                  formatValue={fmtInt0}
                  theme={theme}
                />

                <TimelineChart
                  title="Throughput (TPS)"
                  timeSeries={deferredTimeSeries}
                  selectedModel={selectedModel}
                  extractValue={extractTps}
                  unit=" tok/s"
                  colorByModel={MODEL_COLORS}
                  labelByModel={MODEL_LABELS}
                  formatValue={fmt1}
                  theme={theme}
                />

                <TimelineChart
                  title="Time to First Byte"
                  timeSeries={deferredTimeSeries}
                  selectedModel={selectedModel}
                  extractValue={extractTtfb}
                  unit="s"
                  colorByModel={MODEL_COLORS}
                  labelByModel={MODEL_LABELS}
                  formatValue={fmt2}
                  theme={theme}
                />

                <TimelineChart
                  title="Uptime %"
                  timeSeries={deferredTimeSeries}
                  selectedModel={selectedModel}
                  extractValue={extractUptime}
                  unit="%"
                  yDomain={Y_DOMAIN_UPTIME}
                  colorByModel={MODEL_COLORS}
                  labelByModel={MODEL_LABELS}
                  formatValue={fmt2}
                  theme={theme}
                />
              </>
            ) : (
              <div className="card-surface p-5 flex items-center justify-center" style={{ minHeight: 120 }}>
                <div className="w-6 h-6 border-2 border-zinc-200 dark:border-white/[0.06] border-t-accent rounded-full animate-spin" />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
