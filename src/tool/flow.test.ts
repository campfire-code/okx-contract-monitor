import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type AppConfig } from './config';
import { balanceResp, fastScenario, fillsResp, flatScenario, instrumentResp, longScenario, positionsResp, type Scenario } from './fixtures';
import { envFor, fetchSnapshot, newFills, newMemory, pnlSummary, strategyTick } from './flow';
import type { FetchFn, OkxEnv } from './okx';
import { parseFills, parsePositions } from './okx';
import { startOfLocalDay } from './risk';

const NOW = new Date(2026, 9, 27, 15, 0, 0).getTime();
const creds = { apiKey: 'demo-key-1234567890', secret: 'demo-secret-ABCDEFGH', passphrase: 'demo-pass-9876' };
const ok = (data: unknown[]) => ({ code: '0', msg: '', data });

interface Call { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: Record<string, unknown> | null }

/** 假的 OKX：按路径返回录制格式的响应，并记录每次调用 */
function fake(opts: { scenario?: Scenario; positions?: unknown; fills?: unknown; orders?: unknown[]; posMode?: string; failPath?: string; failResp?: unknown; fast?: boolean } = {}) {
  const calls: Call[] = [];
  const sc = opts.scenario ?? longScenario();
  const fetchFn: FetchFn = async (url, init) => {
    const u = new URL(url);
    const call: Call = { method: init.method, path: u.pathname, query: u.searchParams, headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const reply = (b: unknown) => ({ status: 200, text: async () => JSON.stringify(b) });
    if (opts.failPath && u.pathname === opts.failPath) return reply(opts.failResp ?? { code: '50000', msg: 'boom', data: [] });
    switch (u.pathname) {
      case '/api/v5/market/candles': {
        const bar = u.searchParams.get('bar');
        return reply(ok(bar === '1m' ? sc.c1 : bar === '5m' ? sc.c5 : sc.c15));
      }
      case '/api/v5/market/ticker': return reply(ok([{ last: sc.c1[0][4], open24h: String(Number(sc.c1[0][4]) / 1.005) }]));
      case '/api/v5/public/funding-rate': return reply(ok([{ fundingTime: String(NOW + 5 * 3600_000), fundingRate: '0.0001' }]));
      case '/api/v5/public/instruments': return reply(instrumentResp(u.searchParams.get('instId') ?? undefined));
      case '/api/v5/account/balance': return reply(balanceResp);
      case '/api/v5/account/positions': return reply(opts.positions ?? ok([]));
      case '/api/v5/trade/orders-pending': return reply(ok(opts.orders ?? []));
      case '/api/v5/trade/orders-algo-pending': return reply(ok([]));
      case '/api/v5/trade/fills': return reply(opts.fills ?? ok([]));
      case '/api/v5/account/config': return reply(ok([{ posMode: opts.posMode ?? 'net_mode' }]));
      case '/api/v5/account/set-leverage': return reply(ok([{ lever: '2' }]));
      case '/api/v5/trade/order-precheck': return reply(ok([{ adjEq: '1000' }]));
      case '/api/v5/trade/order': return reply(ok([{ ordId: '123456', sCode: '0', sMsg: '' }]));
      default: return reply({ code: '50000', msg: `未录制：${u.pathname}`, data: [] });
    }
  };
  const base: Omit<OkxEnv, 'simulated'> = { fetch: fetchFn, baseUrl: 'https://openapi.okx.com', creds, now: () => NOW };
  return { calls, base };
}
const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST').map((c) => c.path);
const cfg = (o: Partial<AppConfig> = {}): AppConfig => ({ ...DEFAULT_CONFIG, ...o });

describe('快照', () => {
  it('拉取余额、持仓、委托、成交；某一项失败不影响其他', async () => {
    const f = fake({ positions: positionsResp, fills: fillsResp(NOW), failPath: '/api/v5/trade/orders-pending' });
    const s = await fetchSnapshot(envFor(f.base, 'hint'));
    expect(s.balance?.totalEq).toBe(1523.46);
    expect(s.positions).toHaveLength(2);
    expect(s.fills).toHaveLength(3);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]).toContain('委托单');
    // 所有账户请求都带鉴权头，止盈止损单用 conditional,oco
    expect(f.calls.every((c) => c.headers['OK-ACCESS-SIGN'])).toBe(true);
    expect(f.calls.find((c) => c.path.endsWith('orders-algo-pending'))!.query.get('ordType')).toBe('conditional,oco');
  });
  it('盈亏汇总：今日已实现（含手续费）、近 3 天、浮动', () => {
    const fills = parseFills(fillsResp(NOW).data);
    const r = pnlSummary(fills, parsePositions(positionsResp.data), startOfLocalDay(NOW));
    expect(r.realizedToday).toBeCloseTo(6.2 - 0.26 - 0.26 - 3.1 - 0.13, 8); // 5 小时前仍在今天 10:00
    expect(r.floating).toBeCloseTo(8.09 - 5.85, 8);
  });
  it('新成交检测：首次不提示，之后只报新增', () => {
    const all = parseFills(fillsResp(NOW).data);
    expect(newFills(null, all)).toEqual([]);
    expect(newFills(all.slice(1), all).map((f) => f.ordId)).toEqual(['9001']);
    expect(newFills(all, all)).toEqual([]);
  });
});

describe('策略：只提示模式（默认）', () => {
  it('不填 API Key 也能出信号，且从不发送任何 POST', async () => {
    const f = fake();
    const r = await strategyTick({ env: { ...f.base, creds: null, simulated: false }, cfg: cfg(), liveArmed: false, memory: newMemory() });
    expect(r.mode).toBe('hint');
    expect(r.action.kind).toBe('hint');
    expect(r.action.text).toContain('只提示，不下单');
    expect(r.picked?.signal.side).toBe('long');
    expect(r.picked?.plan?.sz).toBe('1');
    expect(posts(f.calls)).toEqual([]);
    expect(f.calls.every((c) => !c.headers['OK-ACCESS-KEY'])).toBe(true);
  });
  it('选了实盘但未解锁：按只提示运行，不下单', async () => {
    const f = fake();
    const r = await strategyTick({ env: { ...f.base, simulated: false }, cfg: cfg({ mode: 'live' }), liveArmed: false, memory: newMemory() });
    expect(r.mode).toBe('hint');
    expect(posts(f.calls)).toEqual([]);
  });
  it('没有信号时观望', async () => {
    const f = fake({ scenario: flatScenario() });
    const r = await strategyTick({ env: { ...f.base, simulated: false }, cfg: cfg(), liveArmed: false, memory: newMemory() });
    expect(r.action.kind).toBe('wait');
    expect(r.picked).toBeNull();
  });
  it('行情接口出错时返回错误，不抛出', async () => {
    const f = fake({ failPath: '/api/v5/market/candles' });
    const r = await strategyTick({ env: { ...f.base, simulated: false }, cfg: cfg(), liveArmed: false, memory: newMemory() });
    expect(r.action.kind).toBe('error');
  });
  it('评分反转且有浮盈时提示手动平仓（不自动平仓）', async () => {
    const f = fake({ positions: ok([{ instId: 'BTC-USDT-SWAP', posSide: 'net', pos: '-1', avgPx: '70000', markPx: '66000', upl: '40', uplRatio: '0.05', lever: '2', liqPx: '90000', mgnMode: 'cross' }]) });
    const mem = newMemory();
    mem.prevScore['BTC-USDT-SWAP'] = -1.5;
    const r = await strategyTick({ env: { ...f.base, simulated: false }, cfg: cfg(), liveArmed: false, memory: mem });
    expect(r.closeHints[0]).toContain('可考虑手动平仓');
    expect(posts(f.calls)).toEqual([]);
    expect(r.memory.prevScore['BTC-USDT-SWAP']).toBe(2.7);
  });
});

describe('策略：模拟盘与实盘下单', () => {
  it('模拟盘：按顺序设置杠杆、预检、下单；每个请求都带 x-simulated-trading: 1', async () => {
    const f = fake();
    const r = await strategyTick({ env: { ...f.base, simulated: false }, cfg: cfg({ mode: 'sim' }), liveArmed: false, memory: newMemory() });
    expect(r.action.kind).toBe('ordered');
    expect(r.action.text).toContain('【模拟盘】');
    expect(posts(f.calls)).toEqual(['/api/v5/account/set-leverage', '/api/v5/trade/order-precheck', '/api/v5/trade/order']);
    expect(f.calls.every((c) => c.headers['x-simulated-trading'] === '1')).toBe(true);
    const order = f.calls.find((c) => c.path === '/api/v5/trade/order')!;
    expect(order.body).toMatchObject({ instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'market', tdMode: 'cross', sz: '1' });
    const algo = (order.body!.attachAlgoOrds as Record<string, string>[])[0];
    expect(Number(algo.tpTriggerPx)).toBeGreaterThan(Number(algo.slTriggerPx));
    expect(f.calls.find((c) => c.path === '/api/v5/account/set-leverage')!.body).toMatchObject({ lever: '2', mgnMode: 'cross' });
  });
  it('实盘已解锁：下单，且不带模拟盘请求头', async () => {
    const f = fake();
    const r = await strategyTick({ env: { ...f.base, simulated: false }, cfg: cfg({ mode: 'live' }), liveArmed: true, memory: newMemory() });
    expect(r.mode).toBe('live');
    expect(r.action.text).toContain('【实盘】');
    expect(f.calls.some((c) => c.headers['x-simulated-trading'])).toBe(false);
    expect(posts(f.calls)).toContain('/api/v5/trade/order');
  });
  it('双向持仓账户下单带 posSide', async () => {
    const f = fake({ posMode: 'long_short_mode' });
    await strategyTick({ env: { ...f.base, simulated: false }, cfg: cfg({ mode: 'sim' }), liveArmed: false, memory: newMemory() });
    expect(f.calls.find((c) => c.path === '/api/v5/trade/order')!.body!.posSide).toBe('long');
  });
  it('已有持仓：不重复开仓', async () => {
    const f = fake({ positions: positionsResp });
    const r = await strategyTick({ env: { ...f.base, simulated: false }, cfg: cfg({ mode: 'sim' }), liveArmed: false, memory: newMemory() });
    expect(r.action.kind).toBe('blocked');
    expect(r.action.text).toContain('已有持仓');
    expect(posts(f.calls)).toEqual([]);
  });
  it('已有挂单：不重复开仓', async () => {
    const f = fake({ orders: [{ ordId: '1', instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'limit', sz: '1', px: '60000', state: 'live' }] });
    const r = await strategyTick({ env: { ...f.base, simulated: false }, cfg: cfg({ mode: 'sim' }), liveArmed: false, memory: newMemory() });
    expect(r.action.kind).toBe('blocked');
  });
  it('单日亏损达到上限：被风控拦下，不下单', async () => {
    const fills = ok([{ instId: 'BTC-USDT-SWAP', ordId: '5', side: 'sell', posSide: 'net', fillPx: '65000', fillSz: '1', fillPnl: '-25', fee: '-0.3', fillTime: String(NOW - 4 * 3600_000) }]);
    const f = fake({ fills });
    const r = await strategyTick({ env: { ...f.base, simulated: false }, cfg: cfg({ mode: 'sim' }), liveArmed: false, memory: newMemory() });
    expect(r.action.kind).toBe('blocked');
    expect(r.action.text).toContain('达到上限');
    expect(posts(f.calls)).toEqual([]);
  });
  it('连续亏损达到次数：暂停', async () => {
    const fill = (id: string, ago: number) => ({ instId: 'BTC-USDT-SWAP', ordId: id, side: 'sell', posSide: 'net', fillPx: '65000', fillSz: '1', fillPnl: '-2', fee: '-0.2', fillTime: String(NOW - ago) });
    const f = fake({ fills: ok([fill('1', 2 * 3600_000), fill('2', 3 * 3600_000)]) });
    const r = await strategyTick({ env: { ...f.base, simulated: false }, cfg: cfg({ mode: 'sim', maxConsecutiveLosses: 2 }), liveArmed: false, memory: newMemory() });
    expect(r.action.text).toContain('连续亏损 2 次');
    expect(posts(f.calls)).toEqual([]);
  });
  it('平仓后冷静期内：被拦下', async () => {
    const fills = ok([{ instId: 'BTC-USDT-SWAP', ordId: '5', side: 'sell', posSide: 'net', fillPx: '65000', fillSz: '1', fillPnl: '3', fee: '-0.2', fillTime: String(NOW - 60_000) }]);
    const f = fake({ fills });
    const r = await strategyTick({ env: { ...f.base, simulated: false }, cfg: cfg({ mode: 'sim' }), liveArmed: false, memory: newMemory() });
    expect(r.action.text).toContain('冷静期');
  });
  it('突破冷静期（记在内存里）拦下被禁止一侧', async () => {
    const f = fake();
    const mem = newMemory();
    mem.cooldown = { until: NOW + 120_000, reason: '向下跌破，冷静期内不追多', blockSide: 'long' };
    const r = await strategyTick({ env: { ...f.base, simulated: false }, cfg: cfg({ mode: 'sim' }), liveArmed: false, memory: mem });
    expect(r.action.kind).toBe('blocked');
    expect(posts(f.calls)).toEqual([]);
  });
  it('预检失败：不会发出真正的下单请求', async () => {
    const f = fake({ failPath: '/api/v5/trade/order-precheck', failResp: { code: '1', msg: 'fail', data: [{ sCode: '51008', sMsg: 'Insufficient margin' }] } });
    const r = await strategyTick({ env: { ...f.base, simulated: false }, cfg: cfg({ mode: 'sim' }), liveArmed: false, memory: newMemory() });
    expect(r.action.kind).toBe('error');
    expect(r.action.text).toContain('51008');
    expect(posts(f.calls)).not.toContain('/api/v5/trade/order');
  });
  it('账户数据拉取失败：本轮不下单', async () => {
    const f = fake({ failPath: '/api/v5/trade/fills' });
    const r = await strategyTick({ env: { ...f.base, simulated: false }, cfg: cfg({ mode: 'sim' }), liveArmed: false, memory: newMemory() });
    expect(r.action.kind).toBe('error');
    expect(posts(f.calls)).toEqual([]);
  });
  it('仓位不足最小下单量：不下单并说明', async () => {
    const f = fake();
    const r = await strategyTick({ env: { ...f.base, simulated: false }, cfg: cfg({ mode: 'sim', maxNotionalUsdt: 300 }), liveArmed: false, memory: newMemory() });
    expect(r.action.text).toContain('最小下单量');
    expect(posts(f.calls)).toEqual([]);
  });
  it('杠杆超过上限的计划被下单保护拦下（配置被绕过时的最后一道）', async () => {
    const f = fake();
    // 直接构造越界配置，绕过 sanitizeConfig，验证 orderGuard 仍然生效
    const r = await strategyTick({ env: { ...f.base, simulated: false }, cfg: cfg({ mode: 'sim', leverage: 10, maxLeverage: 3 }), liveArmed: false, memory: newMemory() });
    expect(r.action.text).toContain('下单保护拦截');
    expect(posts(f.calls)).toEqual([]);
  });
});

describe('策略：fast', () => {
  it('用 ticker 与资金费率算信号', async () => {
    const s = fastScenario(1);
    const f = fake({ scenario: { ...s, c15: [] } });
    const r = await strategyTick({ env: { ...f.base, creds: null, simulated: false }, cfg: cfg({ strategy: 'fast' }), liveArmed: false, memory: newMemory() });
    expect(r.rows[0].signal.strategy).toBe('fast');
    expect(f.calls.some((c) => c.path === '/api/v5/public/funding-rate')).toBe(true);
    expect(posts(f.calls)).toEqual([]);
  });
});
