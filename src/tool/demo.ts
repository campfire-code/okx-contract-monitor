// 截图 / 预览用的示例数据：虚构账户、虚构持仓，所有数字由 fixtures.ts 的确定性公式生成。
import { DEFAULT_CONFIG } from './config';
import { balanceResp, fillsResp, instrumentResp, longScenario, positionsResp } from './fixtures';
import type { Snapshot, SignalRow, TickResult } from './flow';
import { newMemory } from './flow';
import { parseCandles } from './indicators';
import { parseBalance, parseFills, parseInstrument, parsePositions } from './okx';
import { buildPlan } from './risk';
import { evaluateMulti } from './strategy';

export const DEMO_NOW = new Date(2026, 9, 27, 15, 0, 0).getTime();

export function demoSnapshot(): Snapshot {
  return {
    at: DEMO_NOW,
    balance: parseBalance(balanceResp.data),
    positions: parsePositions(positionsResp.data),
    orders: [
      { id: '7001', kind: '止盈止损', instId: 'BTC-USDT-SWAP', side: 'sell', posSide: 'net', ordType: 'oco', size: 3, price: 0, tpTrigger: 65777.5, slTrigger: 64794.7, state: 'live' },
      { id: '7002', kind: '委托', instId: 'ETH-USDT-SWAP', side: 'buy', posSide: 'net', ordType: 'limit', size: 5, price: 3180, tpTrigger: 0, slTrigger: 0, state: 'live' },
    ],
    fills: parseFills(fillsResp(DEMO_NOW).data),
    errors: [],
  };
}

export function demoTick(): TickResult {
  const s = longScenario();
  const signal = evaluateMulti(parseCandles(s.c1), parseCandles(s.c5), parseCandles(s.c15), { threshold: DEFAULT_CONFIG.scoreThreshold, breakoutCooldownMs: 600_000 });
  const plan = buildPlan('long', signal.price, DEFAULT_CONFIG, parseInstrument(instrumentResp().data));
  const row: SignalRow = { instId: 'BTC-USDT-SWAP', signal, plan: 'error' in plan ? null : plan, planError: null };
  const eth: SignalRow = {
    instId: 'ETH-USDT-SWAP',
    signal: { ...signal, side: null, score: 0.8, price: 3217, reasons: [], blocks: [], detail: { ...signal.detail, trend15m: 'neutral' } },
    plan: null, planError: null,
  };
  return {
    at: DEMO_NOW, mode: 'hint', rows: [row, eth], picked: row, gate: { allowed: false, reason: '已有持仓或挂单，不重复开仓' },
    action: { kind: 'hint', text: `BTC-USDT-SWAP 建议做多，参考 ${row.plan?.sz ?? 1} 张（约 ${row.plan?.notional.toFixed(0) ?? 0} USDT）。只提示，不下单；风控提示：已有持仓或挂单，不重复开仓` },
    closeHints: [], memory: newMemory(), snapshot: null,
  };
}

export const DEMO_LOG = [
  { at: DEMO_NOW - 2 * 60_000, level: 'info' as const, text: '策略检查完成：BTC-USDT-SWAP 做多信号（只提示）' },
  { at: DEMO_NOW - 40 * 60_000, level: 'fill' as const, text: '新成交（示例）：BTC-USDT-SWAP sell 2 张 @ 65402.1，已实现 +6.20 USDT' },
  { at: DEMO_NOW - 41 * 60_000, level: 'info' as const, text: '开始监控，刷新间隔 30 秒' },
];
