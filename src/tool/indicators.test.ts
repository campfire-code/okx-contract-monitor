import { describe, expect, it } from 'vitest';
import { atr, closeLocation, ema, emaSeries, macd, momentum, parseCandles, rsi, sma, volumeRatio } from './indicators';

describe('K 线解析', () => {
  it('把 OKX 的倒序字符串行转成升序数字，丢弃坏行', () => {
    const rows = [['3000', '3', '4', '2', '3.5', '10', '', '', '1'], ['bad'], ['1000', '1', '2', '0.5', '1.5', '7', '', '', '1'], ['2000', '1.5', '3', '1', 'x', '8']];
    const c = parseCandles(rows);
    expect(c.map((x) => x.ts)).toEqual([1000, 3000]);
    expect(c[1]).toEqual({ ts: 3000, o: 3, h: 4, l: 2, c: 3.5, v: 10 });
    expect(parseCandles(null)).toEqual([]);
  });
});

describe('均线与 EMA', () => {
  it('sma 取最近 n 根的平均，不足返回 null', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4);
    expect(sma([1, 2], 3)).toBeNull();
  });
  it('EMA 以前 n 根均值为种子，手算对照', () => {
    // period=3, k=0.5：种子 (1+2+3)/3=2；下一根 4 -> 4*.5+2*.5=3；再 5 -> 4
    expect(emaSeries([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(ema([1, 2, 3, 4, 5], 3)).toBe(4);
    expect(ema([1, 2], 3)).toBeNull();
  });
});

describe('RSI', () => {
  it('一直上涨为 100，一直下跌为 0', () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    const down = Array.from({ length: 30 }, (_, i) => 100 - i);
    expect(rsi(up)).toBe(100);
    expect(rsi(down)).toBeCloseTo(0, 6);
  });
  it('经典示例数据（Wilder 平滑，14 周期）', () => {
    // 数据来自常见教学示例，只取最后一个值对照：独立用 Wilder 公式在测试里再算一遍
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64];
    let g = 0, l = 0;
    for (let i = 1; i <= 14; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
    let ag = g / 14, al = l / 14;
    for (let i = 15; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; ag = (ag * 13 + Math.max(d, 0)) / 14; al = (al * 13 + Math.max(-d, 0)) / 14; }
    expect(rsi(closes, 14)).toBeCloseTo(100 - 100 / (1 + ag / al), 10);
    expect(rsi(closes, 14)).toBeGreaterThan(50);
    expect(rsi(closes, 14)).toBeLessThan(80);
  });
  it('数据不足返回 null', () => expect(rsi([1, 2, 3], 14)).toBeNull());
});

describe('MACD', () => {
  it('数据不足返回 null', () => expect(macd(Array.from({ length: 30 }, (_, i) => i))).toBeNull());
  it('持续上涨：DIF 大于 0、柱体为正', () => {
    const m = macd(Array.from({ length: 80 }, (_, i) => 100 + i * 0.5 + Math.sin(i)))!;
    expect(m.dif).toBeGreaterThan(0);
    expect(m.histogram).toBe((m.dif - m.dea) * 2);
  });
  it('价格不变时全为 0', () => {
    const m = macd(new Array(60).fill(10))!;
    expect(m.dif).toBe(0);
    expect(m.histogram).toBe(0);
    expect(m.histExpanding).toBe(false);
  });
});

describe('其他指标', () => {
  it('动量', () => {
    expect(momentum([100, 101, 102, 103, 104, 110], 5)).toBeCloseTo(0.1, 10);
    expect(momentum([1, 2], 5)).toBeNull();
  });
  it('量比：最新一根相对之前 n 根均值', () => {
    expect(volumeRatio([...new Array(20).fill(10), 25], 20)).toBe(2.5);
    expect(volumeRatio([1, 2], 20)).toBe(1);
    expect(volumeRatio([...new Array(20).fill(0), 5], 20)).toBe(1);
  });
  it('ATR 与收盘位置', () => {
    const c = [
      { ts: 1, o: 10, h: 11, l: 9, c: 10, v: 1 },
      { ts: 2, o: 10, h: 12, l: 10, c: 11, v: 1 },
      { ts: 3, o: 11, h: 13, l: 11, c: 12, v: 1 },
    ];
    expect(atr(c, 2)).toBe(2);
    expect(atr(c, 3)).toBeNull();
    expect(closeLocation({ ts: 1, o: 1, h: 3, l: 1, c: 2, v: 0 })).toBe(0.5);
    expect(closeLocation({ ts: 1, o: 1, h: 1, l: 1, c: 1, v: 0 })).toBe(0.5);
  });
});
