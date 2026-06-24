// Types matching the server's JSONL schema

export interface ModelSnapshot {
  id: string;
  name: string;
  tps: number | null;
  ttfb_seconds: number | null;
  uptime_pct: number | null;
  supply_state: string;
  discount_percent: number;
  credit_multiplier: number;
}

export interface Snapshot {
  timestamp: string;
  supply_updated_at: string | null;
  window: string | null;
  window_secs: number | null;
  stale: boolean | null;
  models: Record<string, ModelSnapshot>;
}

export interface ModelPricing {
  input: number;
  output: number;
  cache_read: number;
}

export interface ServerStatus {
  polling: boolean;
  interval_ms: number;
  fast_mode: boolean;
  snapshot_count: number;
  tracked_models: string[];
  data_file: string;
}

export const TRACKED_MODELS = [
  "google/gemma-4-31b-it",
  "zai-org/glm-5.1",
  "zai-org/glm-5.2",
  "moonshotai/kimi-k2.6",
  "minimaxai/minimax-m2.7",
  "minimaxai/minimax-m3",
] as const;

export const MODEL_LABELS: Record<string, string> = {
  "google/gemma-4-31b-it": "Gemma 4",
  "zai-org/glm-5.1": "GLM 5.1",
  "zai-org/glm-5.2": "GLM 5.2",
  "moonshotai/kimi-k2.6": "Kimi K2.6",
  "minimaxai/minimax-m2.7": "MiniMax M2.7",
  "minimaxai/minimax-m3": "MiniMax M3",
};

export const MODEL_COLORS: Record<string, string> = {
  "google/gemma-4-31b-it": "#059669",
  "zai-org/glm-5.1": "#0891b2",
  "zai-org/glm-5.2": "#2563eb",
  "moonshotai/kimi-k2.6": "#8b5cf6",
  "minimaxai/minimax-m2.7": "#d97706",
  "minimaxai/minimax-m3": "#db2777",
};

export const SUPPLY_STATE_ORDER: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  surplus: 3,
  unknown: -1,
};

export const SUPPLY_STATE_COLORS: Record<string, string> = {
  low: "#dc2626",
  medium: "#d97706",
  high: "#0891b2",
  surplus: "#059669",
  unknown: "#71717a",
};

// Smooth "deal quality" scale for discount %: 0% off (full price) → 100% off.
// Maps to a perceptual slate→amber→teal→green→emerald gradient so color
// alone tells you how good the deal is. Used by the DiscountMercator
// projection as a continuous heatmap color (not snapped to discrete tiers).
export const DISCOUNT_STOPS: { at: number; color: string }[] = [
  { at: 0,   color: '#64748b' }, // slate — no deal, full price
  { at: 25,  color: '#d97706' }, // amber — modest
  { at: 50,  color: '#0891b2' }, // teal — good
  { at: 75,  color: '#059669' }, // green — great
  { at: 100, color: '#10b981' }, // emerald — deep discount
];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

// Linearly interpolate across DISCOUNT_STOPS. `d` is clamped to [0,100].
export function discountColor(d: number): string {
  const c = Math.min(100, Math.max(0, d));
  for (let i = 0; i < DISCOUNT_STOPS.length - 1; i++) {
    const lo = DISCOUNT_STOPS[i], hi = DISCOUNT_STOPS[i + 1];
    if (c >= lo.at && c <= hi.at) {
      const t = (c - lo.at) / (hi.at - lo.at);
      const [r0, g0, b0] = hexToRgb(lo.color);
      const [r1, g1, b1] = hexToRgb(hi.color);
      return rgbToHex(r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t);
    }
  }
  return DISCOUNT_STOPS[DISCOUNT_STOPS.length - 1].color;
}

// CSS gradient string mirroring discountColor, for legend bars.
export const DISCOUNT_GRADIENT_CSS =
  'linear-gradient(to right, ' +
  DISCOUNT_STOPS.map((s) => `${s.color} ${s.at}%`).join(', ') +
  ')';
