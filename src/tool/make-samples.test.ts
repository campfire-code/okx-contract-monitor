// 生成 samples/ 里的示例文件（只在设置了 MAKE_SAMPLES=1 时运行）。内容全部是虚构的 K 线，不对应任何真实行情。
import { it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fastScenario, longScenario, shortScenario } from './fixtures';

it.runIf(process.env.MAKE_SAMPLES === '1')('生成示例文件', () => {
  mkdirSync('samples', { recursive: true });
  const w = (name: string, v: unknown) => writeFileSync(`samples/${name}`, JSON.stringify(v) + '\n');
  w('示例K线-上涨回踩.json', longScenario());
  w('示例K线-下跌反弹.json', shortScenario());
  w('示例K线-快速趋势上行.json', fastScenario(1));
});
