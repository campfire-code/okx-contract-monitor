import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, LIVE_CONFIRM_TEXT, canArmLive, effectiveMode, sanitizeConfig } from './config';
import { instrumentResp } from './fixtures';
import { parseInstrument } from './okx';
import {
  buildPlan, consecutiveLosses, contractSize, floorToStep, lastExitTime, notionalUsdt, orderGuard, protectionPrices, realizedToday, riskGate, roundToTick, startOfLocalDay,
  type Fill,
} from './risk';

const NOW = new Date(2026, 9, 27, 15, 0, 0).getTime(); // 本地时间 2026-10-27 15:00
const H = 3600_000;
const fill = (ordId: string, ago: number, pnl: number, fee = -0.2): Fill => ({ instId: 'BTC-USDT-SWAP', ordId, side: 'sell', posSide: 'net', fillPx: 65000, fillSz: 1, fillPnl: pnl, fee, fillTime: NOW - ago });
const cfg = DEFAULT_CONFIG;
const spec = parseInstrument(instrumentResp().data);

describe('当日盈亏与连亏', () => {
  it('当天 0 点按本地时区计算', () => {
    expect(startOfLocalDay(NOW)).toBe(new Date(2026, 9, 27, 0, 0, 0).getTime());
  });
  it('已实现盈亏含手续费，只统计当天', () => {
    const fills = [fill('a', 1 * H, 5), fill('b', 2 * H, -3), fill('c', 30 * H, -100)];
    expect(realizedToday(fills, NOW)).toBeCloseTo(5 - 0.2 - 3 - 0.2, 10);
  });
  it('连续亏损：同一订单的多笔成交合并为一次，遇盈利中断', () => {
    const fills = [fill('l3', 1 * H, -1), fill('l3', 1 * H + 1000, -1), fill('l2', 2 * H, -2), fill('w', 3 * H, 4), fill('l0', 4 * H, -1)];
    expect(consecutiveLosses(fills, NOW)).toBe(2);
  });
  it('开仓成交（盈亏为 0）不算一次交易', () => {
    expect(consecutiveLosses([fill('open', 1 * H, 0), fill('l1', 2 * H, -1)], NOW)).toBe(1);
  });
  it('昨天的亏损不计入今天的连亏', () => {
    expect(consecutiveLosses([fill('old', 20 * H, -5)], NOW)).toBe(0);
  });
  it('毛盈亏为正但扣费后为负，算亏损', () => {
    expect(consecutiveLosses([fill('x', H, 0.1, -0.3)], NOW)).toBe(1);
  });
  it('最近一次平仓时间', () => {
    expect(lastExitTime([fill('open', H, 0), fill('c', 2 * H, 3)])).toBe(NOW - 2 * H);
    expect(lastExitTime([])).toBe(0);
  });
});

describe('风控闸门', () => {
  const base = { cfg, nowMs: NOW, cooldown: null, hasExposure: false, side: 'long' as const };
  it('正常放行', () => expect(riskGate({ ...base, fills: [] })).toEqual({ allowed: true, reason: '' }));
  it('已有持仓或挂单不重复开仓', () => expect(riskGate({ ...base, fills: [], hasExposure: true }).reason).toContain('已有持仓'));
  it('未连接账户无法评估', () => expect(riskGate({ ...base, fills: null }).allowed).toBe(false));
  it('单日亏损达到上限就停（含手续费）', () => {
    expect(riskGate({ ...base, fills: [fill('a', 5 * H, -19.9, -0.1)] }).reason).toContain('达到上限');
    expect(riskGate({ ...base, fills: [fill('a', 5 * H, -19.0, -0.1)] }).allowed).toBe(true);
  });
  it('连续亏损达到次数后暂停', () => {
    const fills = [fill('a', 3 * H, -1), fill('b', 4 * H, -1), fill('c', 5 * H, -1)];
    const g = riskGate({ ...base, fills });
    expect(g.allowed).toBe(false);
    expect(g.reason).toContain('连续亏损 3 次');
  });
  it('平仓后冷静期内禁止，过后放行', () => {
    expect(riskGate({ ...base, fills: [fill('a', 2 * 60_000, 3)] }).reason).toContain('冷静期');
    expect(riskGate({ ...base, fills: [fill('a', 11 * 60_000, 3)] }).allowed).toBe(true);
  });
  it('突破冷静期只禁止指定一侧', () => {
    const cooldown = { until: NOW + 60_000, reason: '向上突破，冷静期内不追空', blockSide: 'short' as const };
    expect(riskGate({ ...base, fills: [], cooldown, side: 'short' }).allowed).toBe(false);
    expect(riskGate({ ...base, fills: [], cooldown, side: 'long' }).allowed).toBe(true);
    expect(riskGate({ ...base, fills: [], cooldown: { ...cooldown, until: NOW - 1 }, side: 'short' }).allowed).toBe(true);
  });
});

describe('仓位与止盈止损', () => {
  it('名义金额按单笔亏损反推，再受上限约束', () => {
    expect(notionalUsdt({ ...cfg, riskPerTradeUsdt: 2, stopLossPct: 0.5, maxNotionalUsdt: 5000, maxEquityUsdt: 5000, leverage: 2 })).toBeCloseTo(400, 8);
    expect(notionalUsdt({ ...cfg, riskPerTradeUsdt: 50, stopLossPct: 0.5, maxNotionalUsdt: 300, maxEquityUsdt: 5000 })).toBe(300);
    expect(notionalUsdt({ ...cfg, riskPerTradeUsdt: 50, stopLossPct: 0.5, maxNotionalUsdt: 5000, maxEquityUsdt: 100, leverage: 3 })).toBe(300);
  });
  it('张数向下取整到最小下单单位，不足最小量返回 null', () => {
    // 面值 0.01 BTC，价格 65000 -> 一张 650 USDT
    expect(contractSize(1500, 65000, spec)).toBe('2');
    expect(contractSize(649, 65000, spec)).toBeNull();
    const fine = { ...spec, lotSz: 0.01, minSz: 0.01 };
    expect(contractSize(1000, 65000, fine)).toBe('1.53');
  });
  it('以计价货币计面值的合约：张数 = 名义 / 面值', () => {
    expect(contractSize(1000, 65000, { ...spec, ctVal: 100, ctValCcy: 'USD' })).toBe('10');
  });
  it('步长取整', () => {
    expect(floorToStep(1.239, 0.01)).toBe('1.23');
    expect(floorToStep(7, 1)).toBe('7');
    expect(roundToTick(65012.34, 0.1)).toBe('65012.3');
    expect(roundToTick(3.456, 0.01)).toBe('3.46');
  });
  it('多单止盈在上、止损在下；空单相反', () => {
    const c = { ...cfg, stopLossPct: 0.5, takeProfitPct: 1 };
    expect(protectionPrices('long', 65000, c, 0.1)).toEqual({ tp: '65650.0', sl: '64675.0' });
    expect(protectionPrices('short', 65000, c, 0.1)).toEqual({ tp: '64350.0', sl: '65325.0' });
  });
  it('交易计划：张数、名义金额、止损亏损', () => {
    const plan = buildPlan('long', 65000, { ...cfg, maxNotionalUsdt: 1500, riskPerTradeUsdt: 20, maxEquityUsdt: 1000 }, spec);
    expect('error' in plan).toBe(false);
    if ('error' in plan) return;
    expect(plan.sz).toBe('2');
    expect(plan.notional).toBe(1300);
    expect(plan.maxLoss).toBeCloseTo(6.5, 8);
    expect(plan.leverage).toBe(2);
  });
  it('仓位小于最小下单量时给出原因', () => {
    const plan = buildPlan('long', 65000, { ...cfg, maxNotionalUsdt: 300 }, spec);
    expect(plan).toHaveProperty('error');
  });
});

describe('下单前保护', () => {
  const plan = { instId: 'BTC-USDT-SWAP', side: 'long' as const, price: 65000, notional: 650, sz: '1', leverage: 2, tp: '65650.0', sl: '64675.0', maxLoss: 3.25 };
  it('正常通过', () => expect(orderGuard(plan, cfg)).toBeNull());
  it('杠杆超过上限被拒', () => expect(orderGuard({ ...plan, leverage: 5 }, cfg)).toContain('杠杆'));
  it('名义金额超过单笔上限被拒', () => expect(orderGuard({ ...plan, notional: 5000 }, cfg)).toContain('单笔上限'));
  it('保证金超过最多动用金额被拒', () => expect(orderGuard({ ...plan, notional: 900, leverage: 1 }, { ...cfg, maxEquityUsdt: 500 })).toContain('保证金'));
  it('缺止盈止损被拒', () => expect(orderGuard({ ...plan, tp: '' }, cfg)).toContain('止盈止损'));
});

describe('配置校验与实盘开关', () => {
  it('非法输入回到默认值，数值夹在范围内', () => {
    const c = sanitizeConfig({ leverage: 'abc', maxLeverage: 500, stopLossPct: -1, dailyLossLimitUsdt: 0, strategyIntervalSec: 1, instruments: ['btc-usdt-swap', 'BTC-USD-SWAP', 'bad'], baseUrl: 'http://evil' });
    expect(c.maxLeverage).toBe(20);
    expect(c.leverage).toBe(DEFAULT_CONFIG.leverage);
    expect(c.stopLossPct).toBe(0.1);
    expect(c.dailyLossLimitUsdt).toBe(1);
    expect(c.strategyIntervalSec).toBe(20);
    expect(c.instruments).toEqual(['BTC-USDT-SWAP']);
    expect(c.baseUrl).toBe(DEFAULT_CONFIG.baseUrl);
    expect(sanitizeConfig(null)).toEqual(DEFAULT_CONFIG);
  });
  it('杠杆不会超过杠杆上限', () => {
    const c = sanitizeConfig({ leverage: 10, maxLeverage: 3 });
    expect(c.leverage).toBe(3);
  });
  it('默认是只提示模式、保守参数', () => {
    expect(DEFAULT_CONFIG.mode).toBe('hint');
    expect(DEFAULT_CONFIG.maxLeverage).toBeLessThanOrEqual(3);
  });
  it('接口地址只接受 https 域名', () => {
    expect(sanitizeConfig({ baseUrl: 'https://www.okx.com/' }).baseUrl).toBe('https://www.okx.com');
    expect(sanitizeConfig({ baseUrl: 'ftp://x' }).baseUrl).toBe(DEFAULT_CONFIG.baseUrl);
  });
  it('选了实盘但没解锁时，实际按只提示运行', () => {
    const live = { ...DEFAULT_CONFIG, mode: 'live' as const };
    expect(effectiveMode(live, false)).toBe('hint');
    expect(effectiveMode(live, true)).toBe('live');
    expect(effectiveMode({ ...DEFAULT_CONFIG, mode: 'sim' }, false)).toBe('sim');
  });
  it('解锁实盘必须勾选并输入完全一致的确认文字', () => {
    expect(canArmLive(true, LIVE_CONFIRM_TEXT)).toBe(true);
    expect(canArmLive(false, LIVE_CONFIRM_TEXT)).toBe(false);
    expect(canArmLive(true, '确认')).toBe(false);
    expect(canArmLive(true, LIVE_CONFIRM_TEXT.slice(0, -1))).toBe(false);
  });
});
