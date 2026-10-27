import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './config';
import { fastScenario, longScenario, shortScenario } from './fixtures';
import { replayFromJson } from './replay';

describe('K 线文件试算', () => {
  it('多周期策略：上涨回踩文件 -> 做多', () => {
    const r = replayFromJson(JSON.stringify(longScenario()), DEFAULT_CONFIG);
    expect(r.signal.side).toBe('long');
    expect(r.signal.score).toBe(2.7);
    expect(r.bars.c15).toBe(100);
    expect(Number(r.tp)).toBeGreaterThan(Number(r.sl));
    expect(r.notional).toBe(1000);
  });
  it('下跌反弹文件 -> 做空，止盈在下', () => {
    const r = replayFromJson(JSON.stringify(shortScenario()), DEFAULT_CONFIG);
    expect(r.signal.side).toBe('short');
    expect(Number(r.tp)).toBeLessThan(Number(r.sl));
  });
  it('快速趋势策略不需要 15 分钟数据', () => {
    const s = fastScenario(1);
    const r = replayFromJson(JSON.stringify({ c1: s.c1, c5: s.c5 }), { ...DEFAULT_CONFIG, strategy: 'fast' });
    expect(r.signal.strategy).toBe('fast');
  });
  it('坏文件给出中文提示', () => {
    expect(() => replayFromJson('不是json', DEFAULT_CONFIG)).toThrow('不是有效的 JSON');
    expect(() => replayFromJson('{}', DEFAULT_CONFIG)).toThrow('c5');
    expect(() => replayFromJson(JSON.stringify({ c1: longScenario().c1, c5: longScenario().c5 }), DEFAULT_CONFIG)).toThrow('c15');
    expect(() => replayFromJson(JSON.stringify({ c5: longScenario().c5, c15: longScenario().c15 }), DEFAULT_CONFIG)).toThrow('c1');
  });
  it('samples/ 里的示例文件（换行统一后）与当前生成结果一致', () => {
    const f = 'samples/示例K线-上涨回踩.json';
    if (!existsSync(f)) return;
    const text = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(longScenario())));
    expect(replayFromJson(text, DEFAULT_CONFIG).signal.side).toBe('long');
  });
});
