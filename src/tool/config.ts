// 配置：全部可由用户修改，默认值取保守档。sanitizeConfig 负责把任何输入夹到合法范围，实盘保护以这里的上限为准。
import type { StrategyId } from './strategy';

export type RunMode = 'hint' | 'sim' | 'live';

export const MODE_NAMES: Record<RunMode, string> = {
  hint: '只提示（只显示信号，不下单）',
  sim: '模拟盘（OKX 模拟交易，用模拟盘 API Key）',
  live: '实盘自动下单（真实资金）',
};

/** 实盘解锁必须原样输入的确认文字 */
export const LIVE_CONFIRM_TEXT = '我已了解风险并确认实盘自动下单';

export interface AppConfig {
  mode: RunMode;
  /** OKX 接口地址；不同地区的域名见 OKX 官方文档 */
  baseUrl: string;
  instruments: string[];
  strategy: StrategyId;
  /** 策略检查间隔（秒） */
  strategyIntervalSec: number;
  /** 监控刷新间隔（秒） */
  monitorIntervalSec: number;
  leverage: number;
  /** 杠杆上限：下单前再校验一次，超过就拒绝 */
  maxLeverage: number;
  /** 最多动用的保证金（USDT） */
  maxEquityUsdt: number;
  /** 单笔最大亏损（USDT），按止损幅度反推名义金额 */
  riskPerTradeUsdt: number;
  /** 单笔最大名义金额（USDT） */
  maxNotionalUsdt: number;
  /** 止损、止盈幅度，单位 %（0.5 表示 0.5%） */
  stopLossPct: number;
  takeProfitPct: number;
  /** 单日已实现亏损上限（USDT），达到后当天不再开仓 */
  dailyLossLimitUsdt: number;
  maxConsecutiveLosses: number;
  /** 平仓后的冷静期（秒） */
  cooldownSec: number;
  /** 突破后的冷静期（秒） */
  breakoutCooldownSec: number;
  /** multi 策略：开仓评分阈值 */
  scoreThreshold: number;
  /** fast 策略：最低方向分 */
  minSignalScore: number;
  allowLong: boolean;
  allowShort: boolean;
  avoidFundingMinutes: number;
}

export const DEFAULT_BASE_URL = 'https://openapi.okx.com';

export const DEFAULT_CONFIG: AppConfig = {
  mode: 'hint',
  baseUrl: DEFAULT_BASE_URL,
  instruments: ['BTC-USDT-SWAP'],
  strategy: 'multi',
  strategyIntervalSec: 60,
  monitorIntervalSec: 30,
  leverage: 2,
  maxLeverage: 3,
  maxEquityUsdt: 500,
  riskPerTradeUsdt: 5,
  maxNotionalUsdt: 1000,
  stopLossPct: 0.5,
  takeProfitPct: 1,
  dailyLossLimitUsdt: 20,
  maxConsecutiveLosses: 3,
  cooldownSec: 600,
  breakoutCooldownSec: 600,
  scoreThreshold: 2.5,
  minSignalScore: 4,
  allowLong: true,
  allowShort: true,
  avoidFundingMinutes: 5,
};

/** 只接受 USDT 本位永续合约，保证盈亏、金额都以 USDT 计 */
export const INST_RE = /^[A-Z0-9]{2,15}-USDT-SWAP$/;

const num = (v: unknown, d: number, lo: number, hi: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

export function sanitizeConfig(raw: unknown): AppConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const D = DEFAULT_CONFIG;
  const maxLeverage = Math.round(num(r.maxLeverage, D.maxLeverage, 1, 20));
  const baseUrlRaw = typeof r.baseUrl === 'string' ? r.baseUrl.trim().replace(/\/+$/, '') : '';
  const insts = Array.isArray(r.instruments) ? r.instruments.map((x) => String(x).trim().toUpperCase()).filter((x) => INST_RE.test(x)) : [];
  return {
    mode: r.mode === 'sim' || r.mode === 'live' || r.mode === 'hint' ? r.mode : D.mode,
    baseUrl: /^https:\/\/[a-z0-9.-]+$/i.test(baseUrlRaw) ? baseUrlRaw : D.baseUrl,
    instruments: insts.length ? [...new Set(insts)].slice(0, 5) : D.instruments,
    strategy: r.strategy === 'fast' ? 'fast' : 'multi',
    strategyIntervalSec: Math.round(num(r.strategyIntervalSec, D.strategyIntervalSec, 20, 3600)),
    monitorIntervalSec: Math.round(num(r.monitorIntervalSec, D.monitorIntervalSec, 10, 600)),
    maxLeverage,
    // 杠杆不能超过杠杆上限
    leverage: Math.min(maxLeverage, Math.round(num(r.leverage, D.leverage, 1, 20))),
    maxEquityUsdt: num(r.maxEquityUsdt, D.maxEquityUsdt, 1, 1_000_000),
    riskPerTradeUsdt: num(r.riskPerTradeUsdt, D.riskPerTradeUsdt, 0.1, 100_000),
    maxNotionalUsdt: num(r.maxNotionalUsdt, D.maxNotionalUsdt, 1, 1_000_000),
    stopLossPct: num(r.stopLossPct, D.stopLossPct, 0.1, 20),
    takeProfitPct: num(r.takeProfitPct, D.takeProfitPct, 0.1, 50),
    dailyLossLimitUsdt: num(r.dailyLossLimitUsdt, D.dailyLossLimitUsdt, 1, 1_000_000),
    maxConsecutiveLosses: Math.round(num(r.maxConsecutiveLosses, D.maxConsecutiveLosses, 1, 20)),
    cooldownSec: Math.round(num(r.cooldownSec, D.cooldownSec, 0, 86400)),
    breakoutCooldownSec: Math.round(num(r.breakoutCooldownSec, D.breakoutCooldownSec, 0, 86400)),
    scoreThreshold: num(r.scoreThreshold, D.scoreThreshold, 1, 8),
    minSignalScore: Math.round(num(r.minSignalScore, D.minSignalScore, 1, 8)),
    allowLong: r.allowLong === false ? false : true,
    allowShort: r.allowShort === false ? false : true,
    avoidFundingMinutes: Math.round(num(r.avoidFundingMinutes, D.avoidFundingMinutes, 0, 60)),
  };
}

/** 实际生效的运行模式：选了实盘但没有在本次运行中解锁时，退回「只提示」 */
export function effectiveMode(cfg: AppConfig, liveArmed: boolean): RunMode {
  return cfg.mode === 'live' && !liveArmed ? 'hint' : cfg.mode;
}

/** 实盘解锁：必须勾选并原样输入确认文字（只在本次运行内有效，关闭应用即失效） */
export function canArmLive(acknowledged: boolean, typed: string): boolean {
  return acknowledged && typed.trim() === LIVE_CONFIRM_TEXT;
}
