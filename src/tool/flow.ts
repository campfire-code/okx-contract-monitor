// 流程：拉取账户快照、跑一轮策略、（在允许时）下单。网络通过 OkxEnv 注入，测试里用录制响应。
import { effectiveMode, type AppConfig, type RunMode } from './config';
import { parseCandles, type Candle } from './indicators';
import {
  buildOrderBody, okx, parseAlgoOrders, parseBalance, parseFills, parseInstrument, parseOrders, parsePositions,
  type BalanceInfo, type OkxEnv, type PendingOrder, type Position,
} from './okx';
import { buildPlan, orderGuard, riskGate, type CooldownState, type Fill, type Gate, type TradePlan } from './risk';
import { evaluateFast, evaluateMulti, shouldCloseOnReversal, type Signal } from './strategy';

/** 按运行模式生成请求环境：模拟盘加 x-simulated-trading，其余走正式环境 */
export function envFor(base: Omit<OkxEnv, 'simulated'>, mode: RunMode): OkxEnv {
  return { ...base, simulated: mode === 'sim' };
}

// ---------------- 监控快照 ----------------

export interface Snapshot {
  at: number;
  balance: BalanceInfo | null;
  positions: Position[];
  orders: PendingOrder[];
  fills: Fill[];
  /** 哪一部分拉取失败（其余照常显示） */
  errors: string[];
}

export async function fetchSnapshot(env: OkxEnv): Promise<Snapshot> {
  const [bal, pos, ord, algo, fil] = await Promise.allSettled([
    okx(env, 'GET', '/api/v5/account/balance', { auth: true }),
    okx(env, 'GET', '/api/v5/account/positions', { query: { instType: 'SWAP' }, auth: true }),
    okx(env, 'GET', '/api/v5/trade/orders-pending', { query: { instType: 'SWAP' }, auth: true }),
    okx(env, 'GET', '/api/v5/trade/orders-algo-pending', { query: { ordType: 'conditional,oco', instType: 'SWAP' }, auth: true }),
    okx(env, 'GET', '/api/v5/trade/fills', { query: { instType: 'SWAP', limit: 100 }, auth: true }),
  ]);
  const errors: string[] = [];
  const pick = <T,>(r: PromiseSettledResult<T[]>, name: string): T[] | null => {
    if (r.status === 'fulfilled') return r.value;
    errors.push(`${name}：${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    return null;
  };
  const b = pick(bal, '账户余额');
  const p = pick(pos, '持仓');
  const o = pick(ord, '委托单');
  const a = pick(algo, '止盈止损单');
  const f = pick(fil, '成交记录');
  return {
    at: env.now(),
    balance: b ? parseBalance(b) : null,
    positions: p ? parsePositions(p) : [],
    orders: [...(o ? parseOrders(o) : []), ...(a ? parseAlgoOrders(a) : [])],
    fills: f ? parseFills(f) : [],
    errors,
  };
}

/** 比较两次快照，找出新出现的成交（用于成交提示）。首次快照（prev 为 null）不提示 */
export function newFills(prev: Fill[] | null, cur: Fill[]): Fill[] {
  if (prev === null) return [];
  const seen = new Set(prev.map((f) => `${f.ordId}|${f.fillTime}|${f.fillSz}`));
  return cur.filter((f) => !seen.has(`${f.ordId}|${f.fillTime}|${f.fillSz}`));
}

/** 已实现盈亏统计：今日、近 3 天（接口只返回最近 3 天） */
export function pnlSummary(fills: Fill[], positions: Position[], startOfDay: number) {
  const net = (list: Fill[]) => list.reduce((s, f) => s + f.fillPnl + f.fee, 0);
  return {
    realizedToday: net(fills.filter((f) => f.fillTime >= startOfDay)),
    realized3d: net(fills),
    floating: positions.reduce((s, p) => s + p.upl, 0),
  };
}

// ---------------- 策略 ----------------

export interface Memory {
  /** 各合约上一轮评分，用于判断评分反转 */
  prevScore: Record<string, number>;
  cooldown: CooldownState | null;
}
export const newMemory = (): Memory => ({ prevScore: {}, cooldown: null });

export interface SignalRow {
  instId: string;
  signal: Signal;
  plan: TradePlan | null;
  planError: string | null;
}

export type ActionKind = 'wait' | 'hint' | 'ordered' | 'blocked' | 'error';
export interface TickResult {
  at: number;
  mode: RunMode;
  rows: SignalRow[];
  /** 选中的最强信号（如有） */
  picked: SignalRow | null;
  gate: Gate | null;
  action: { kind: ActionKind; text: string };
  closeHints: string[];
  memory: Memory;
  /** 本轮拉到的账户快照（未连接账户时为 null） */
  snapshot: Snapshot | null;
}

const getCandles = async (env: OkxEnv, instId: string, bar: string, limit: number): Promise<Candle[]> =>
  parseCandles(await okx(env, 'GET', '/api/v5/market/candles', { query: { instId, bar, limit } }));

async function getInstrumentSpec(env: OkxEnv, instId: string) {
  return parseInstrument(await okx(env, 'GET', '/api/v5/public/instruments', { query: { instType: 'SWAP', instId } }));
}

async function analyse(env: OkxEnv, cfg: AppConfig, instId: string): Promise<Signal> {
  if (cfg.strategy === 'multi') {
    const [c1, c5, c15] = await Promise.all([getCandles(env, instId, '1m', 30), getCandles(env, instId, '5m', 100), getCandles(env, instId, '15m', 100)]);
    return evaluateMulti(c1, c5, c15, { threshold: cfg.scoreThreshold, breakoutCooldownMs: cfg.breakoutCooldownSec * 1000 });
  }
  const [c1, c5, tk, fr] = await Promise.all([
    getCandles(env, instId, '1m', 60),
    getCandles(env, instId, '5m', 60),
    okx<Record<string, string>>(env, 'GET', '/api/v5/market/ticker', { query: { instId } }),
    okx<Record<string, string>>(env, 'GET', '/api/v5/public/funding-rate', { query: { instId } }),
  ]);
  const t = tk[0];
  if (!t) throw new Error(`${instId} 没有行情数据`);
  return evaluateFast(
    { last: Number(t.last), open24h: Number(t.open24h), fundingTime: Number(fr[0]?.fundingTime ?? 0), nowMs: env.now() },
    c1, c5,
    { minSignalScore: cfg.minSignalScore, allowLong: cfg.allowLong, allowShort: cfg.allowShort, avoidFundingWindowMinutes: cfg.avoidFundingMinutes },
  );
}

export interface TickInput {
  env: OkxEnv;
  cfg: AppConfig;
  liveArmed: boolean;
  memory: Memory;
}

/** 跑一轮：算信号 → 风控闸门 → 只提示 / 模拟盘下单 / 实盘下单 */
export async function strategyTick(inp: TickInput): Promise<TickResult> {
  const { cfg } = inp;
  const mode = effectiveMode(cfg, inp.liveArmed);
  const env = envFor(inp.env, mode);
  const now = env.now();
  const memory: Memory = { prevScore: { ...inp.memory.prevScore }, cooldown: inp.memory.cooldown };
  const rows: SignalRow[] = [];
  const closeHints: string[] = [];

  const base = (action: TickResult['action'], extra: Partial<TickResult> = {}): TickResult => ({ at: now, mode, rows, picked: null, gate: null, action, closeHints, memory, snapshot: null, ...extra });

  // 1. 信号（只用公开行情，不需要 API Key）
  for (const instId of cfg.instruments) {
    try {
      const signal = await analyse(env, cfg, instId);
      if (signal.cooldown) memory.cooldown = { until: now + signal.cooldown.ms, reason: signal.cooldown.reason, blockSide: signal.cooldown.blockSide };
      let plan: TradePlan | null = null;
      let planError: string | null = null;
      if (signal.side) {
        try {
          const p = buildPlan(signal.side, signal.price, cfg, await getInstrumentSpec(env, instId));
          if ('error' in p) planError = p.error;
          else plan = p;
        } catch (e) {
          planError = e instanceof Error ? e.message : String(e);
        }
      }
      rows.push({ instId, signal, plan, planError });
    } catch (e) {
      return base({ kind: 'error', text: `${instId} 行情获取失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  // 2. 账户（有 Key 才有）
  let snapshot: Snapshot | null = null;
  if (env.creds) {
    snapshot = await fetchSnapshot(env);
    if (snapshot.errors.length) return base({ kind: 'error', text: `账户数据获取失败，本轮不下单：${snapshot.errors[0]}` }, { snapshot });
    if (cfg.strategy === 'multi') {
      for (const pos of snapshot.positions) {
        const row = rows.find((r) => r.instId === pos.instId);
        const prev = memory.prevScore[pos.instId];
        if (row && prev !== undefined && shouldCloseOnReversal(pos.side, prev, row.signal.score, pos.upl)) {
          closeHints.push(`${pos.instId} ${pos.side === 'long' ? '多' : '空'}单有浮盈，评分已反转，可考虑手动平仓`);
        }
      }
    }
  }
  for (const r of rows) memory.prevScore[r.instId] = r.signal.score;

  // 3. 选出最强信号
  const picked = rows.filter((r) => r.signal.side).sort((a, b) => Math.abs(b.signal.score) - Math.abs(a.signal.score))[0] ?? null;
  if (!picked) return base({ kind: 'wait', text: '没有满足条件的信号，观望' }, { snapshot });

  const side = picked.signal.side!;
  const gate = riskGate({
    cfg, fills: snapshot ? snapshot.fills : null, nowMs: now, cooldown: memory.cooldown, side,
    hasExposure: snapshot ? snapshot.positions.length > 0 || snapshot.orders.length > 0 : false,
  });
  const sideText = side === 'long' ? '做多' : '做空';

  if (!picked.plan) return base({ kind: 'blocked', text: `${picked.instId} 出现${sideText}信号，但无法生成交易计划：${picked.planError}` }, { picked, gate, snapshot });
  if (mode === 'hint') {
    return base({ kind: 'hint', text: `${picked.instId} 建议${sideText}，参考 ${picked.plan.sz} 张（约 ${picked.plan.notional.toFixed(0)} USDT）。只提示，不下单${gate.allowed ? '' : `；风控提示：${gate.reason}`}` }, { picked, gate, snapshot });
  }
  if (!gate.allowed) return base({ kind: 'blocked', text: `${picked.instId} 出现${sideText}信号，被风控拦下：${gate.reason}` }, { picked, gate, snapshot });
  const guard = orderGuard(picked.plan, cfg);
  if (guard) return base({ kind: 'blocked', text: `下单保护拦截：${guard}` }, { picked, gate, snapshot });

  // 4. 下单（模拟盘或已解锁的实盘）
  try {
    const orderId = await placeOrder(env, picked.plan);
    return base({ kind: 'ordered', text: `${mode === 'sim' ? '【模拟盘】' : '【实盘】'}已${sideText} ${picked.instId} ${picked.plan.sz} 张，止盈 ${picked.plan.tp}，止损 ${picked.plan.sl}，订单号 ${orderId}` }, { picked, gate, snapshot });
  } catch (e) {
    return base({ kind: 'error', text: `下单失败：${e instanceof Error ? e.message : String(e)}` }, { picked, gate, snapshot });
  }
}

/** 设置杠杆 → 预检 → 下单；返回订单号。任何一步失败都抛出，不会继续 */
export async function placeOrder(env: OkxEnv, plan: TradePlan): Promise<string> {
  const conf = await okx<Record<string, string>>(env, 'GET', '/api/v5/account/config', { auth: true });
  const posMode = conf[0]?.posMode ?? 'net_mode';
  await okx(env, 'POST', '/api/v5/account/set-leverage', { body: { instId: plan.instId, lever: String(plan.leverage), mgnMode: 'cross' }, auth: true });
  const body = buildOrderBody({ instId: plan.instId, side: plan.side, sz: plan.sz, tp: plan.tp, sl: plan.sl, posMode, clientTag: `cf${env.now().toString(36)}` });
  await okx(env, 'POST', '/api/v5/trade/order-precheck', { body, auth: true });
  const res = await okx<Record<string, string>>(env, 'POST', '/api/v5/trade/order', { body, auth: true });
  return res[0]?.ordId ?? '';
}
