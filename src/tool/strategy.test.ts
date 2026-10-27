import { describe, expect, it } from 'vitest';
import { fastScenario, flatScenario, longScenario, makeRows, shortScenario, T0 } from './fixtures';
import { parseCandles } from './indicators';
import { confirm1m, detectBreakout, evaluateFast, evaluateMulti, reverseProtection, score5m, shouldCloseOnReversal, trend15m } from './strategy';

const P = (rows: string[][]) => parseCandles(rows);
const multi = (s: ReturnType<typeof longScenario>) => evaluateMulti(P(s.c1), P(s.c5), P(s.c15), { threshold: 2.5, breakoutCooldownMs: 600_000 });
const fastCfg = { minSignalScore: 4, allowLong: true, allowShort: true, avoidFundingWindowMinutes: 5 };
const fast = (dir: 1 | -1, over: Partial<typeof fastCfg> = {}, fundingTime = T0 + 20 * 3600_000, now = T0 + 12 * 3600_000) => {
  const s = fastScenario(dir);
  const c1 = P(s.c1);
  const last = c1[c1.length - 1].c;
  return evaluateFast({ last, open24h: last / (1 + dir * 0.005), fundingTime, nowMs: now }, c1, P(s.c5), { ...fastCfg, ...over });
};

describe('multi：多周期评分', () => {
  it('上升趋势回踩后放量反弹 -> 做多，评分 2.7', () => {
    const s = multi(longScenario());
    expect(s.side).toBe('long');
    expect(s.score).toBe(2.7);
    expect(s.detail.trend15m).toBe('long');
    expect(s.reasons[0]).toContain('2.7');
  });
  it('下跌趋势反弹后放量回落 -> 做空，评分 -2.7', () => {
    const s = multi(shortScenario());
    expect(s.side).toBe('short');
    expect(s.score).toBe(-2.7);
    expect(s.detail.trend15m).toBe('short');
  });
  it('平稳震荡 -> 观望', () => {
    const f = flatScenario();
    const s = evaluateMulti(P(f.c1), P(f.c5), P(f.c15), { threshold: 2.5, breakoutCooldownMs: 1 });
    expect(s.side).toBeNull();
    expect(Math.abs(s.score)).toBeLessThan(2.5);
  });
  it('阈值调高后不再出信号', () => {
    const sc = longScenario();
    expect(evaluateMulti(P(sc.c1), P(sc.c5), P(sc.c15), { threshold: 3, breakoutCooldownMs: 1 }).side).toBeNull();
  });
  it('1 分钟没有确认时拦下，并给出原因', () => {
    const sc = longScenario();
    const flat1 = makeRows([{ bars: 30, drift: 0, noise: 0 }], { start: 65000, stepMs: 60_000, seed: 1 });
    const s = evaluateMulti(P(flat1), P(sc.c5), P(sc.c15), { threshold: 2.5, breakoutCooldownMs: 1 });
    expect(s.side).toBeNull();
    expect(s.blocks.join()).toContain('1 分钟未确认');
  });
  it('15 分钟趋势相反时被反转保护拦下', () => {
    const sc = longScenario();
    const s = evaluateMulti(P(sc.c1), P(sc.c5), P(shortScenario().c15), { threshold: 2.5, breakoutCooldownMs: 1 });
    expect(s.side).toBeNull();
    expect(s.blocks.join()).toContain('15 分钟趋势偏空');
  });
  it('score5m / trend15m 直接取值', () => {
    expect(score5m(P(longScenario().c5)).score).toBe(2.7);
    expect(trend15m(P(longScenario().c15))).toBe('long');
    expect(trend15m(P(makeRows([{ bars: 100, drift: 0, noise: 0 }], { start: 65000, stepMs: 900_000, seed: 1 })))).toBe('neutral');
  });
  it('confirm1m：数据不足时不阻断；最近三次变化至少两次同向才确认', () => {
    expect(confirm1m(P(flatScenario().c1).slice(0, 3), 'long')).toBe(true);
    const up = [1, 2, 3, 4, 5].map((c, i) => ({ ts: i, o: c, h: c, l: c, c, v: 1 }));
    expect(confirm1m(up, 'long')).toBe(true);
    expect(confirm1m(up, 'short')).toBe(false);
  });
  it('reverseProtection 各分支', () => {
    const base = { score: 3, rsi: 50, macd: null, ema9: null, ema21: null, price: 1, momentum: 0, volRatio: 1 };
    expect(reverseProtection('long', base, 'short')).toContain('15 分钟');
    expect(reverseProtection('short', { ...base, rsi: 30 }, 'neutral')).toContain('RSI 过低');
    expect(reverseProtection('long', { ...base, rsi: 70 }, 'neutral')).toContain('RSI 过高');
    expect(reverseProtection('long', { ...base, momentum: -0.006 }, 'neutral')).toContain('动量');
    expect(reverseProtection('short', { ...base, momentum: 0.006 }, 'neutral')).toContain('动量');
    expect(reverseProtection('long', { ...base, macd: { dif: -1, dea: 0, histogram: -1, prevHistogram: -0.5, histExpanding: true } }, 'neutral')).toContain('MACD');
    expect(reverseProtection('long', base, 'long')).toBeNull();
  });
  it('突破检测与冷静期方向', () => {
    const c = P(flatScenario().c5);
    expect(detectBreakout(c)).toBeNull();
    const last = c[c.length - 1];
    const up = [...c.slice(0, -1), { ...last, c: last.c * 1.02, h: last.c * 1.02 }];
    const down = [...c.slice(0, -1), { ...last, c: last.c * 0.98, l: last.c * 0.98 }];
    expect(detectBreakout(up)).toBe('up');
    expect(detectBreakout(down)).toBe('down');
    expect(detectBreakout(c.slice(0, 10))).toBeNull();
    const f = flatScenario();
    const sig = evaluateMulti(P(f.c1), up, P(f.c15), { threshold: 2.5, breakoutCooldownMs: 600_000 });
    expect(sig.cooldown).toMatchObject({ ms: 600_000, blockSide: 'short' });
    const sig2 = evaluateMulti(P(f.c1), down, P(f.c15), { threshold: 2.5, breakoutCooldownMs: 600_000 });
    expect(sig2.cooldown?.blockSide).toBe('long');
  });
  it('评分反转且有浮盈才建议平仓', () => {
    expect(shouldCloseOnReversal('long', 1.5, -0.5, 3)).toBe(true);
    expect(shouldCloseOnReversal('long', 1.5, -0.5, -3)).toBe(false);
    expect(shouldCloseOnReversal('long', 1.5, 0.5, 3)).toBe(false);
    expect(shouldCloseOnReversal('short', -1, 0.5, 1)).toBe(true);
    expect(shouldCloseOnReversal('short', 1, 0.5, 1)).toBe(false);
  });
});

describe('fast：快速趋势', () => {
  it('持续走强 -> 做多', () => {
    const s = fast(1);
    expect(s.side).toBe('long');
    expect(s.score).toBeGreaterThanOrEqual(4);
    expect(s.reasons).toContain('1 分钟均线多头');
  });
  it('持续走弱 -> 做空', () => {
    const s = fast(-1);
    expect(s.side).toBe('short');
    expect(s.score).toBeLessThanOrEqual(-4);
  });
  it('只允许做空时，多头信号被忽略', () => {
    expect(fast(1, { allowLong: false }).side).toBeNull();
  });
  it('临近资金费结算窗口内不开仓', () => {
    const s = fast(1, {}, T0 + 12 * 3600_000 + 3 * 60_000);
    expect(s.side).toBeNull();
    expect(s.blocks.join()).toContain('资金费');
  });
  it('最低方向分调高后观望', () => {
    expect(fast(1, { minSignalScore: 6 }).side).toBeNull();
  });
  it('平稳行情 -> 观望，并说明波动率不可用', () => {
    const f = flatScenario();
    const c1 = P(f.c1);
    const s = evaluateFast({ last: c1[c1.length - 1].c, open24h: c1[0].c, fundingTime: 0, nowMs: T0 }, c1, P(f.c5), fastCfg);
    expect(s.side).toBeNull();
    expect(s.blocks.join()).toContain('波动率');
  });
});
