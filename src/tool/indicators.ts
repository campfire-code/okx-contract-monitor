// 技术指标：纯函数，输入为按时间升序排列的数组。数据不足时返回 null。

export interface Candle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

/** 把 OKX K 线接口 data（每行 [ts,o,h,l,c,vol,...]，新的在前）转成升序的 Candle 数组，丢弃格式不对的行 */
export function parseCandles(rows: unknown): Candle[] {
  if (!Array.isArray(rows)) return [];
  const out: Candle[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const [ts, o, h, l, c, v] = r.slice(0, 6).map(Number);
    if ([ts, o, h, l, c, v].some((x) => !Number.isFinite(x))) continue;
    out.push({ ts, o, h, l, c, v });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  return sum(values.slice(-period)) / period;
}

/** EMA 序列：前 period-1 项为 null，第 period 项为简单平均作种子 */
export function emaSeries(values: number[], period: number): (number | null)[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: (number | null)[] = new Array(period - 1).fill(null);
  let ema = sum(values.slice(0, period)) / period;
  out.push(ema);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

export function ema(values: number[], period: number): number | null {
  const s = emaSeries(values, period);
  return s.length ? (s[s.length - 1] as number) : null;
}

/** RSI（Wilder 平滑） */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export interface Macd {
  dif: number;
  dea: number;
  histogram: number;
  prevHistogram: number;
  /** 柱体绝对值比上一根更大 */
  histExpanding: boolean;
}

/** MACD(12,26,9)。与参考实现不同：上一根柱体用真实的上一根 DEA 计算，而不是用当前 DEA 近似 */
export function macd(closes: number[], fast = 12, slow = 26, signal = 9): Macd | null {
  if (closes.length < slow + signal) return null;
  const f = emaSeries(closes, fast);
  const s = emaSeries(closes, slow);
  const dif: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const a = f[i];
    const b = s[i];
    if (a != null && b != null) dif.push(a - b);
  }
  const deaSeries = emaSeries(dif, signal);
  if (deaSeries.length < 2) return null;
  const dea = deaSeries[deaSeries.length - 1] as number;
  const prevDea = deaSeries[deaSeries.length - 2];
  const d = dif[dif.length - 1];
  const prevD = dif[dif.length - 2];
  if (prevDea == null) return null;
  const histogram = (d - dea) * 2;
  const prevHistogram = (prevD - prevDea) * 2;
  return { dif: d, dea, histogram, prevHistogram, histExpanding: Math.abs(histogram) > Math.abs(prevHistogram) };
}

/** 最近 n 根的涨跌幅（小数，0.01 = 1%） */
export function momentum(values: number[], n: number): number | null {
  if (values.length < n + 1) return null;
  const prev = values[values.length - 1 - n];
  if (!prev) return null;
  return (values[values.length - 1] - prev) / prev;
}

/** 最新一根成交量 / 之前 period 根的平均成交量 */
export function volumeRatio(volumes: number[], period = 20): number {
  if (volumes.length < period + 1) return 1;
  const avg = sum(volumes.slice(-period - 1, -1)) / period;
  if (avg === 0) return 1;
  return volumes[volumes.length - 1] / avg;
}

/** 平均真实波幅（简单平均），取最近 n 根 */
export function atr(candles: Candle[], n: number): number | null {
  if (candles.length < n + 1) return null;
  let total = 0;
  for (let i = candles.length - n; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    total += Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
  }
  return total / n;
}

/** 收盘价在当根 K 线高低区间中的位置，0 = 最低，1 = 最高 */
export function closeLocation(c: Candle): number {
  const range = c.h - c.l;
  return range ? (c.c - c.l) / range : 0.5;
}
