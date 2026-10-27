// 虚构的 K 线与账户响应，格式与 OKX 接口一致（K 线：[ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]，新的在前）。
// 数据完全由确定性的公式生成，不对应任何真实行情，只用于测试、示例文件和截图。
export const T0 = Date.UTC(2026, 9, 26, 0, 0, 0); // 虚构的起点：2026-10-26 00:00 UTC

/** 确定性伪随机数（mulberry32） */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Leg {
  /** 这一段有多少根 K 线 */
  bars: number;
  /** 每根收盘价相对上一根的平均涨跌幅（小数） */
  drift: number;
  /** 随机波动幅度（小数） */
  noise: number;
  /** 成交量基数倍数 */
  vol?: number;
}

/** 按分段走势生成 K 线行（OKX 格式，新的在前）。end 为最后一根 K 线的开盘时间 */
export function makeRows(legs: Leg[], opts: { start: number; stepMs: number; seed: number; end?: number }): string[][] {
  const rand = rng(opts.seed);
  const total = legs.reduce((s, l) => s + l.bars, 0);
  const end = opts.end ?? T0 + 12 * 3600_000;
  let px = opts.start;
  const rows: string[][] = [];
  let i = 0;
  for (const leg of legs) {
    for (let k = 0; k < leg.bars; k++, i++) {
      const o = px;
      const c = o * (1 + leg.drift + (rand() - 0.5) * 2 * leg.noise);
      const h = Math.max(o, c) * (1 + rand() * leg.noise * 0.6);
      const l = Math.min(o, c) * (1 - rand() * leg.noise * 0.6);
      const vol = Math.round(1000 * (leg.vol ?? 1) * (0.8 + rand() * 0.4));
      const ts = end - (total - 1 - i) * opts.stepMs;
      rows.push([String(ts), o.toFixed(1), h.toFixed(1), l.toFixed(1), c.toFixed(1), String(vol), String(vol / 100), String(vol * c / 100), '1']);
      px = c;
    }
  }
  return rows.reverse();
}

export interface Scenario {
  c1: string[][];
  c5: string[][];
  c15: string[][];
}

/** 平稳震荡 */
export const flatScenario = (seed = 1): Scenario => ({
  c1: makeRows([{ bars: 30, drift: 0, noise: 0.0002 }], { start: 65000, stepMs: 60_000, seed }),
  c5: makeRows([{ bars: 100, drift: 0, noise: 0.0004 }], { start: 65000, stepMs: 300_000, seed: seed + 1 }),
  c15: makeRows([{ bars: 100, drift: 0, noise: 0.0006 }], { start: 65000, stepMs: 900_000, seed: seed + 2 }),
});

export const OKX_BASE = 'https://openapi.okx.com';

/** 账户余额响应（虚构账户） */
export const balanceResp = {
  code: '0', msg: '',
  data: [{ totalEq: '1523.46', upl: '3.82', details: [{ ccy: 'USDT', eq: '1519.64', availBal: '1346.10', upl: '3.82' }, { ccy: 'BTC', eq: '0.00005', availBal: '0.00005', upl: '0' }] }],
};

export const positionsResp = {
  code: '0', msg: '',
  data: [
    { instId: 'BTC-USDT-SWAP', posSide: 'net', pos: '3', avgPx: '65120.5', markPx: '65390.2', upl: '8.09', uplRatio: '0.0415', lever: '2', liqPx: '33850.1', mgnMode: 'cross' },
    { instId: 'ETH-USDT-SWAP', posSide: 'net', pos: '-5', avgPx: '3205.30', markPx: '3217.00', upl: '-5.85', uplRatio: '-0.0361', lever: '2', liqPx: '6120.4', mgnMode: 'cross' },
    { instId: 'SOL-USDT-SWAP', posSide: 'net', pos: '0', avgPx: '', markPx: '', upl: '0', uplRatio: '', lever: '2', liqPx: '', mgnMode: 'cross' },
  ],
};

export const fillsResp = (now: number) => ({
  code: '0', msg: '',
  data: [
    { instId: 'BTC-USDT-SWAP', ordId: '9001', side: 'sell', posSide: 'net', fillPx: '65402.1', fillSz: '2', fillPnl: '6.20', fee: '-0.26', fillTime: String(now - 40 * 60_000) },
    { instId: 'BTC-USDT-SWAP', ordId: '9000', side: 'buy', posSide: 'net', fillPx: '65090.0', fillSz: '2', fillPnl: '0', fee: '-0.26', fillTime: String(now - 3 * 3600_000) },
    { instId: 'ETH-USDT-SWAP', ordId: '8999', side: 'buy', posSide: 'net', fillPx: '3190.0', fillSz: '4', fillPnl: '-3.10', fee: '-0.13', fillTime: String(now - 5 * 3600_000) },
  ],
});

export const instrumentResp = (instId = 'BTC-USDT-SWAP') => ({
  code: '0', msg: '',
  data: [{ instId, ctType: 'linear', ctVal: instId.startsWith('BTC') ? '0.01' : '0.1', ctValCcy: instId.split('-')[0], lotSz: '1', minSz: '1', tickSz: instId.startsWith('BTC') ? '0.1' : '0.01', state: 'live' }],
});

const mk = (legs5: Leg[], seed: number, d15: number, dir: 1 | -1): Scenario => ({
  c1: makeRows([{ bars: 26, drift: 0, noise: 0.0003 }, { bars: 4, drift: dir * 0.0006, noise: 0.0001 }], { start: 65000, stepMs: 60_000, seed: seed + 2 }),
  c5: makeRows(legs5, { start: 65000, stepMs: 300_000, seed }),
  c15: makeRows([{ bars: 100, drift: d15, noise: 0.001 }], { start: 65000, stepMs: 900_000, seed: seed + 1 }),
});

/** 上升趋势中回踩后放量反弹：多周期评分策略应给出做多信号 */
export const longScenario = (): Scenario => mk([{ bars: 89, drift: 0.0002, noise: 0.0007 }, { bars: 5, drift: -0.00315, noise: 0.0007 }, { bars: 5, drift: 0.00342, noise: 0.00036, vol: 2.58 }], 6, 0.00197, 1);

/** 下跌趋势中反弹后放量回落：应给出做空信号 */
export const shortScenario = (): Scenario => mk([{ bars: 88, drift: -0.00016, noise: 0.00116 }, { bars: 4, drift: 0.00295, noise: 0.00116 }, { bars: 5, drift: -0.0027, noise: 0.00058, vol: 2.56 }], 9, -0.00042, -1);

/** 快速趋势策略用：1 分钟与 5 分钟 K 线同向缓慢走强（dir=1）或走弱（dir=-1） */
export const fastScenario = (dir: 1 | -1): Pick<Scenario, 'c1' | 'c5'> =>
  dir === 1
    ? { c1: makeRows([{ bars: 60, drift: 0.00045, noise: 0.00193 }], { start: 65000, stepMs: 60_000, seed: 46 }), c5: makeRows([{ bars: 60, drift: 0.00097, noise: 0.0006 }], { start: 65000, stepMs: 300_000, seed: 47 }) }
    : { c1: makeRows([{ bars: 60, drift: -0.00065, noise: 0.00112 }], { start: 65000, stepMs: 60_000, seed: 28 }), c5: makeRows([{ bars: 60, drift: -0.00079, noise: 0.0006 }], { start: 65000, stepMs: 300_000, seed: 29 }) };
