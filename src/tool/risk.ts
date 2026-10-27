// 风控与仓位：纯函数。所有时间由参数传入。
import type { AppConfig } from './config';
import type { Side } from './strategy';

export interface Fill {
  instId: string;
  ordId: string;
  side: string;
  posSide: string;
  fillPx: number;
  fillSz: number;
  /** 已实现盈亏（平仓成交才有；USDT） */
  fillPnl: number;
  /** 手续费，扣费为负数 */
  fee: number;
  fillTime: number;
}

/** 本地时区当天 0 点的毫秒时间戳 */
export function startOfLocalDay(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 当天已实现盈亏（含手续费，所有成交都计手续费） */
export function realizedToday(fills: Fill[], nowMs: number): number {
  const start = startOfLocalDay(nowMs);
  return fills.filter((f) => f.fillTime >= start).reduce((s, f) => s + f.fillPnl + f.fee, 0);
}

interface ClosedOrder {
  ordId: string;
  time: number;
  net: number;
}

/** 把平仓成交按订单合并：同一订单的多笔成交算一次交易 */
export function closedOrders(fills: Fill[]): ClosedOrder[] {
  const map = new Map<string, ClosedOrder & { closing: boolean }>();
  for (const f of fills) {
    const cur = map.get(f.ordId) ?? { ordId: f.ordId, time: 0, net: 0, closing: false };
    cur.time = Math.max(cur.time, f.fillTime);
    cur.net += f.fillPnl + f.fee;
    if (f.fillPnl !== 0) cur.closing = true;
    map.set(f.ordId, cur);
  }
  return [...map.values()].filter((o) => o.closing).sort((a, b) => b.time - a.time);
}

/** 从最近一笔平仓往前数，连续亏损的次数（净盈亏 < 0 算亏损）；遇到盈利停止。只统计当天 */
export function consecutiveLosses(fills: Fill[], nowMs: number): number {
  const start = startOfLocalDay(nowMs);
  let n = 0;
  for (const o of closedOrders(fills)) {
    if (o.time < start) break;
    if (o.net < 0) n++;
    else break;
  }
  return n;
}

/** 最近一次平仓成交的时间，没有返回 0 */
export function lastExitTime(fills: Fill[]): number {
  return closedOrders(fills)[0]?.time ?? 0;
}

export interface CooldownState {
  until: number;
  reason: string;
  /** 只禁止这一侧；不填表示两边都禁止 */
  blockSide?: Side;
}

export interface GateInput {
  cfg: AppConfig;
  /** 已知的近期成交；账户未连接时传 null，风控无法评估 */
  fills: Fill[] | null;
  nowMs: number;
  cooldown: CooldownState | null;
  hasExposure: boolean;
  side: Side;
}

export interface Gate {
  allowed: boolean;
  reason: string;
}

/** 开仓前的风控闸门：已有仓位或挂单 / 单日亏损上限 / 连亏暂停 / 冷静期 */
export function riskGate(i: GateInput): Gate {
  if (i.hasExposure) return { allowed: false, reason: '已有持仓或挂单，不重复开仓' };
  if (i.fills === null) return { allowed: false, reason: '未连接账户，无法评估单日亏损与连亏' };
  const today = realizedToday(i.fills, i.nowMs);
  if (-today >= i.cfg.dailyLossLimitUsdt) {
    return { allowed: false, reason: `今日已实现亏损 ${(-today).toFixed(2)} USDT，达到上限 ${i.cfg.dailyLossLimitUsdt} USDT` };
  }
  const losses = consecutiveLosses(i.fills, i.nowMs);
  if (losses >= i.cfg.maxConsecutiveLosses) return { allowed: false, reason: `连续亏损 ${losses} 次，今日暂停开仓` };
  const exit = lastExitTime(i.fills);
  if (exit && i.cfg.cooldownSec > 0 && i.nowMs - exit < i.cfg.cooldownSec * 1000) {
    const left = Math.ceil((i.cfg.cooldownSec * 1000 - (i.nowMs - exit)) / 1000);
    return { allowed: false, reason: `平仓后冷静期，还剩 ${left} 秒` };
  }
  const c = i.cooldown;
  if (c && c.until > i.nowMs && (!c.blockSide || c.blockSide === i.side)) {
    return { allowed: false, reason: `${c.reason}（还剩 ${Math.ceil((c.until - i.nowMs) / 1000)} 秒）` };
  }
  return { allowed: true, reason: '' };
}

// ---------------- 仓位与止盈止损 ----------------

/** 名义金额（USDT）：按单笔最大亏损和止损幅度反推，再受单笔上限、可用保证金 × 杠杆限制 */
export function notionalUsdt(cfg: AppConfig): number {
  const byRisk = cfg.riskPerTradeUsdt / (cfg.stopLossPct / 100);
  return Math.min(byRisk, cfg.maxNotionalUsdt, cfg.maxEquityUsdt * cfg.leverage);
}

export interface InstrumentSpec {
  instId: string;
  ctType: string;
  ctVal: number;
  ctValCcy: string;
  lotSz: number;
  minSz: number;
  tickSz: number;
}

const decimals = (step: number) => {
  const t = String(step);
  if (t.includes('e-')) return Number(t.split('e-')[1]);
  return t.includes('.') ? t.split('.')[1].length : 0;
};

export function floorToStep(value: number, step: number): string {
  const n = Math.floor((value + Number.EPSILON) / step + 1e-9) * step;
  return n.toFixed(decimals(step));
}

export function roundToTick(px: number, tick: number): string {
  return (Math.round(px / tick) * tick).toFixed(decimals(tick));
}

/** 合约张数：线性合约（币本位面值）= 名义 / (面值 × 价格)，面值以计价货币计时 = 名义 / 面值；不足最小下单量返回 null */
export function contractSize(notional: number, price: number, spec: InstrumentSpec): string | null {
  const quoteDenominated = ['USDT', 'USDC', 'USD'].includes(spec.ctValCcy);
  const raw = quoteDenominated ? notional / spec.ctVal : notional / (spec.ctVal * price);
  const sz = floorToStep(raw, spec.lotSz);
  return Number(sz) >= spec.minSz ? sz : null;
}

export function protectionPrices(side: Side, entry: number, cfg: AppConfig, tickSz: number): { tp: string; sl: string } {
  const tp = cfg.takeProfitPct / 100;
  const sl = cfg.stopLossPct / 100;
  return side === 'long'
    ? { tp: roundToTick(entry * (1 + tp), tickSz), sl: roundToTick(entry * (1 - sl), tickSz) }
    : { tp: roundToTick(entry * (1 - tp), tickSz), sl: roundToTick(entry * (1 + sl), tickSz) };
}

export interface TradePlan {
  instId: string;
  side: Side;
  price: number;
  notional: number;
  sz: string;
  leverage: number;
  tp: string;
  sl: string;
  /** 止损时的预计亏损（USDT，不含手续费与滑点） */
  maxLoss: number;
}

/** 生成交易计划；仓位小于最小下单量时返回原因 */
export function buildPlan(side: Side, price: number, cfg: AppConfig, spec: InstrumentSpec): TradePlan | { error: string } {
  const notional = notionalUsdt(cfg);
  const sz = contractSize(notional, price, spec);
  if (!sz) return { error: `按当前设置算出的仓位不足该合约最小下单量 ${spec.minSz} 张，请调大单笔金额` };
  const real = quoteNotional(Number(sz), price, spec);
  const { tp, sl } = protectionPrices(side, price, cfg, spec.tickSz);
  return { instId: spec.instId, side, price, notional: real, sz, leverage: cfg.leverage, tp, sl, maxLoss: real * (cfg.stopLossPct / 100) };
}

/** 张数对应的名义金额（USDT） */
export function quoteNotional(sz: number, price: number, spec: InstrumentSpec): number {
  return ['USDT', 'USDC', 'USD'].includes(spec.ctValCcy) ? sz * spec.ctVal : sz * spec.ctVal * price;
}

/** 下单前的最后一道保护：任何一项不满足就拒绝。返回拒绝原因，通过返回 null */
export function orderGuard(plan: TradePlan, cfg: AppConfig): string | null {
  if (plan.leverage > cfg.maxLeverage) return `杠杆 ${plan.leverage} 倍超过上限 ${cfg.maxLeverage} 倍`;
  if (plan.notional > cfg.maxNotionalUsdt * 1.0001) return `名义金额 ${plan.notional.toFixed(2)} 超过单笔上限 ${cfg.maxNotionalUsdt} USDT`;
  if (plan.notional / plan.leverage > cfg.maxEquityUsdt * 1.0001) return `所需保证金超过最多动用的 ${cfg.maxEquityUsdt} USDT`;
  if (!plan.tp || !plan.sl || !(Number(plan.tp) > 0) || !(Number(plan.sl) > 0)) return '缺少止盈止损价，拒绝下单';
  return null;
}
