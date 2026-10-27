// 信号评分：两套策略，均为纯函数（不联网、不读时钟，时间由参数传入）。
//  - multi：5 分钟评分 + 15 分钟趋势过滤 + 1 分钟确认 + 反转保护（分钟级短线）
//  - fast：1 分钟 / 5 分钟均线与动量打分 + 一组过热、回撤、资金费率窗口过滤（快速趋势）
import { atr, closeLocation, ema, macd, momentum, rsi, sma, volumeRatio, type Candle, type Macd } from './indicators';

export type Side = 'long' | 'short';
export type StrategyId = 'multi' | 'fast';

export const STRATEGY_NAMES: Record<StrategyId, string> = {
  multi: '多周期评分（5 分钟评分，15 分钟定方向，1 分钟确认）',
  fast: '快速趋势（1 分钟与 5 分钟均线、动量，带过热过滤）',
};

export interface Signal {
  strategy: StrategyId;
  /** 通过全部过滤后的方向；null 表示观望 */
  side: Side | null;
  /** 综合评分：多头为正、空头为负（multi），或取较高一方的分数（fast，带符号） */
  score: number;
  price: number;
  /** 加分项，用于向用户解释 */
  reasons: string[];
  /** 被哪些过滤条件拦下 */
  blocks: string[];
  /** 突破后的冷静期：禁止在 blockSide 方向追单 */
  cooldown?: { ms: number; reason: string; blockSide: Side };
  /** 展示用的指标快照 */
  detail: Record<string, number | string | null>;
}

// ---------------- multi ----------------

export interface Score5m {
  score: number;
  rsi: number | null;
  macd: Macd | null;
  ema9: number | null;
  ema21: number | null;
  price: number;
  momentum: number;
  volRatio: number;
}

/** 5 分钟综合评分：RSI、MACD、EMA9/21、5 根动量、量比；分数为正偏多，为负偏空 */
export function score5m(candles: Candle[]): Score5m {
  const closes = candles.map((c) => c.c);
  const vols = candles.map((c) => c.v);
  const price = closes[closes.length - 1] ?? 0;
  let score = 0;

  const r = rsi(closes, 14);
  if (r !== null) {
    if (r < 30) score += 1.5;
    else if (r < 40) score += 0.8;
    else if (r < 50) score += 0.2;
    else if (r < 60) score -= 0.2;
    else if (r < 70) score -= 0.8;
    else score -= 1.5;
  }

  const m = macd(closes);
  if (m) {
    if (m.dif > 0 && m.histogram > 0) score += m.histExpanding ? 1.2 : 0.6;
    else if (m.dif < 0 && m.histogram < 0) score -= m.histExpanding ? 1.2 : 0.6;
    else if (m.dif > 0 && m.histogram < 0) score -= 0.3;
    else score += 0.3;
  }

  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  if (e9 && e21) {
    if (e9 > e21 && price > e9) score += 0.8;
    else if (e9 > e21) score += 0.4;
    else if (e9 < e21 && price < e9) score -= 0.8;
    else score -= 0.4;
  }

  const mom = momentum(closes, 5);
  if (mom !== null) {
    if (mom > 0.005) score += 1.0;
    else if (mom > 0.002) score += 0.5;
    else if (mom > 0) score += 0.2;
    else if (mom < -0.005) score -= 1.0;
    else if (mom < -0.002) score -= 0.5;
    else score -= 0.2;
  }

  // 放量只增强已有的方向
  const vr = volumeRatio(vols, 20);
  if (vr > 2.0) score += score > 0 ? 0.5 : -0.5;
  else if (vr > 1.5) score += score > 0 ? 0.3 : -0.3;

  return { score: Math.round(score * 100) / 100, rsi: r, macd: m, ema9: e9, ema21: e21, price, momentum: mom ?? 0, volRatio: vr };
}

/** 15 分钟趋势：RSI、MACD、EMA21、动量四项里至少三项同向才算有方向 */
export function trend15m(candles: Candle[]): Side | 'neutral' {
  const closes = candles.map((c) => c.c);
  const price = closes[closes.length - 1];
  const r = rsi(closes, 14);
  const m = macd(closes);
  const e21 = ema(closes, 21);
  const mom = momentum(closes, 5);
  let bull = 0;
  let bear = 0;
  if (r !== null) {
    if (r > 52) bull++;
    if (r < 48) bear++;
  }
  if (m) {
    if (m.dif > 0 && m.histogram > 0) bull++;
    if (m.dif < 0 && m.histogram < 0) bear++;
  }
  if (e21) {
    if (price > e21) bull++;
    if (price < e21) bear++;
  }
  if (mom !== null) {
    if (mom > 0.001) bull++;
    if (mom < -0.001) bear++;
  }
  if (bull >= 3) return 'long';
  if (bear >= 3) return 'short';
  return 'neutral';
}

/** 1 分钟确认：最近 3 次变化里至少 2 次与方向一致；数据不足时不阻断 */
export function confirm1m(candles: Candle[], side: Side): boolean {
  const closes = candles.map((c) => c.c);
  if (closes.length < 5) return true;
  const last = closes.slice(-4);
  let up = 0;
  let down = 0;
  for (let i = 1; i < last.length; i++) {
    if (last[i] > last[i - 1]) up++;
    else if (last[i] < last[i - 1]) down++;
  }
  return side === 'long' ? up >= 2 : down >= 2;
}

/** 反转保护：逆势、MACD 一票否决、RSI 极端、动量明显相反时拦截 */
export function reverseProtection(side: Side, s: Score5m, trend: Side | 'neutral'): string | null {
  if (side === 'long' && trend === 'short') return '15 分钟趋势偏空，不开多';
  if (side === 'short' && trend === 'long') return '15 分钟趋势偏多，不开空';
  if (side === 'short' && s.macd && s.macd.dif > 0 && s.macd.histExpanding) return 'MACD 多头扩张，否决开空';
  if (side === 'long' && s.macd && s.macd.dif < 0 && s.macd.histExpanding) return 'MACD 空头扩张，否决开多';
  if (side === 'short' && s.rsi !== null && s.rsi < 35) return `RSI 过低（${s.rsi.toFixed(1)}），反转保护不开空`;
  if (side === 'long' && s.rsi !== null && s.rsi > 65) return `RSI 过高（${s.rsi.toFixed(1)}），反转保护不开多`;
  if (side === 'long' && s.momentum < -0.005) return '5 分钟动量明显向下，不开多';
  if (side === 'short' && s.momentum > 0.005) return '5 分钟动量明显向上，不开空';
  return null;
}

/** 价格相对前 19 根 5 分钟 K 线的最高 / 最低价突破 0.2% */
export function detectBreakout(candles: Candle[]): 'up' | 'down' | null {
  if (candles.length < 20) return null;
  const price = candles[candles.length - 1].c;
  const prev = candles.slice(-20, -1);
  const maxHigh = Math.max(...prev.map((c) => c.h));
  const minLow = Math.min(...prev.map((c) => c.l));
  if (price > maxHigh * 1.002) return 'up';
  if (price < minLow * 0.998) return 'down';
  return null;
}

/** 持仓中，评分由正转负（多单）或由负转正（空单），且有浮盈时，建议主动平仓。只作为提示，本工具不据此自动平仓 */
export function shouldCloseOnReversal(posSide: Side, prevScore: number, score: number, unrealizedPnl: number): boolean {
  if (unrealizedPnl <= 0) return false;
  if (posSide === 'long') return prevScore > 0 && score < 0;
  return prevScore < 0 && score > 0;
}

export interface MultiConfig {
  /** 开仓所需的评分绝对值，默认 2.5 */
  threshold: number;
  breakoutCooldownMs: number;
}

export function evaluateMulti(c1: Candle[], c5: Candle[], c15: Candle[], cfg: MultiConfig): Signal {
  const s = score5m(c5);
  const trend = trend15m(c15);
  const reasons: string[] = [];
  const blocks: string[] = [];
  let side: Side | null = s.score >= cfg.threshold ? 'long' : s.score <= -cfg.threshold ? 'short' : null;
  if (side) reasons.push(`5 分钟评分 ${s.score.toFixed(2)}，达到阈值 ${cfg.threshold}`);

  const breakout = detectBreakout(c5);
  let cooldown: Signal['cooldown'];
  if (breakout === 'up') cooldown = { ms: cfg.breakoutCooldownMs, reason: '向上突破，冷静期内不追空', blockSide: 'short' };
  if (breakout === 'down') cooldown = { ms: cfg.breakoutCooldownMs, reason: '向下跌破，冷静期内不追多', blockSide: 'long' };

  if (side) {
    const blocked = reverseProtection(side, s, trend);
    if (blocked) {
      blocks.push(blocked);
      side = null;
    }
  }
  if (side && !confirm1m(c1, side)) {
    blocks.push(side === 'long' ? '1 分钟未确认多头，等待' : '1 分钟未确认空头，等待');
    side = null;
  }
  return {
    strategy: 'multi',
    side,
    score: s.score,
    price: s.price,
    reasons,
    blocks,
    cooldown,
    detail: { rsi5m: s.rsi, macdHist: s.macd?.histogram ?? null, ema9: s.ema9, ema21: s.ema21, momentum5m: s.momentum, volRatio: s.volRatio, trend15m: trend },
  };
}

// ---------------- fast ----------------

export interface FastConfig {
  minSignalScore: number;
  allowLong: boolean;
  allowShort: boolean;
  avoidFundingWindowMinutes: number;
}

export interface FastInput {
  last: number;
  open24h: number;
  /** 下一次资金费时间（毫秒时间戳），未知填 0 */
  fundingTime: number;
  nowMs: number;
}

export function evaluateFast(input: FastInput, c1: Candle[], c5: Candle[], cfg: FastConfig): Signal {
  const closes1 = c1.map((c) => c.c);
  const closes5 = c5.map((c) => c.c);
  const { last, open24h } = input;
  const sma9 = sma(closes1, 9);
  const sma21 = sma(closes1, 21);
  const s5a = sma(closes5, 9);
  const s5b = sma(closes5, 21);
  const mom3 = momentum(closes1, 3) ?? 0;
  const mom5 = momentum(closes1, 5) ?? 0;
  const mom10 = momentum(closes1, 10) ?? 0;
  const mom5m2 = momentum(closes5, 2) ?? 0;
  const dayMove = open24h ? last / open24h - 1 : 0;
  const a = atr(c1, 14);
  const atrPct = a && last ? a / last : 0;
  const distSma9 = sma9 ? last / sma9 - 1 : 0;
  const minutesToFunding = input.fundingTime ? (input.fundingTime - input.nowMs) / 60000 : 999;
  const latest = c1[c1.length - 1];
  const recent = c1.slice(-4);
  const recentHigh = recent.length ? Math.max(...recent.map((c) => c.h)) : 0;
  const recentLow = recent.length ? Math.min(...recent.map((c) => c.l)) : 0;
  const loc = latest ? closeLocation(latest) : 0.5;
  const candleMove = latest && latest.o ? latest.c / latest.o - 1 : 0;

  const up1 = Boolean(sma9 && sma21 && sma9 > sma21);
  const down1 = Boolean(sma9 && sma21 && sma9 < sma21);
  const up5 = Boolean(s5a && s5b && s5a > s5b);
  const down5 = Boolean(s5a && s5b && s5a < s5b);
  const posMom = mom3 > 0.0008 && mom10 > 0;
  const negMom = mom3 < -0.0008 && mom10 < 0;
  const usableVol = atrPct > 0.0015 && atrPct < 0.012;
  const nearFunding = Math.abs(minutesToFunding) <= cfg.avoidFundingWindowMinutes;
  const longHot = mom5 > 0.006 || distSma9 > 0.0045;
  const shortHot = mom5 < -0.006 || distSma9 < -0.0045;
  const longPullback = recentHigh > 0 && recentHigh / last - 1 > 0.0018;
  const shortBounce = recentLow > 0 && last / recentLow - 1 > 0.0018;
  const longWeakCandle = candleMove < -0.0006 && loc < 0.45;
  const shortWeakCandle = candleMove > 0.0006 && loc > 0.55;

  let longScore = 0;
  let shortScore = 0;
  const reasons: string[] = [];
  if (up1) { longScore++; reasons.push('1 分钟均线多头'); }
  if (down1) { shortScore++; reasons.push('1 分钟均线空头'); }
  if (up5) { longScore++; reasons.push('5 分钟均线多头'); }
  if (down5) { shortScore++; reasons.push('5 分钟均线空头'); }
  if (posMom) { longScore++; reasons.push('短期动量向上'); }
  if (negMom) { shortScore++; reasons.push('短期动量向下'); }
  if (dayMove < -0.025 && last < open24h) { shortScore++; reasons.push('24 小时走势偏弱'); }
  if (dayMove > 0.02 && last > open24h) { longScore++; reasons.push('24 小时走势偏强'); }
  if (usableVol) { longScore++; shortScore++; reasons.push('波动率适中'); }
  if (nearFunding) { longScore -= 2; shortScore -= 2; reasons.push('临近资金费结算'); }

  // 只列出与当前偏向一侧相关的拦截原因，避免同时出现多空两边的提示
  const lean: Side = longScore >= shortScore ? 'long' : 'short';
  const blocks: string[] = [];
  if (!usableVol) blocks.push('波动率不在可用区间');
  if (nearFunding) blocks.push('临近资金费结算，暂不开仓');
  if (lean === 'long') {
    if (longHot) blocks.push('多头过热，不追多');
    if (longPullback) blocks.push('距近期高点已回落，不开多');
    if (longWeakCandle) blocks.push('当前 K 线偏弱，不开多');
    if (mom5m2 <= 0) blocks.push('5 分钟动量不支持开多');
  } else {
    if (shortHot) blocks.push('空头过热，不追空');
    if (shortBounce) blocks.push('距近期低点已反弹，不开空');
    if (shortWeakCandle) blocks.push('当前 K 线偏强，不开空');
    if (mom5m2 >= 0) blocks.push('5 分钟动量不支持开空');
  }

  const longOk = cfg.allowLong && longScore >= cfg.minSignalScore && longScore - shortScore >= 3 && up1 && up5 && posMom && usableVol && !longHot && !longPullback && !longWeakCandle && mom5m2 > 0 && !nearFunding;
  const shortOk = cfg.allowShort && shortScore >= cfg.minSignalScore && shortScore - longScore >= 3 && down1 && down5 && negMom && usableVol && !shortHot && !shortBounce && !shortWeakCandle && mom5m2 < 0 && !nearFunding;
  // 与参考实现一致：两边同时满足时取空头（实际上差值 ≥ 3 的条件使两边不会同时成立）
  const side: Side | null = shortOk ? 'short' : longOk ? 'long' : null;
  const score = longScore >= shortScore ? longScore : -shortScore;
  return {
    strategy: 'fast',
    side,
    score,
    price: last,
    reasons,
    blocks: side ? [] : blocks,
    detail: { longScore, shortScore, atrPct, mom3, mom5, mom10, mom5m2, dayMove, distSma9 },
  };
}
