// 用本地 K 线文件离线试算信号（不联网、不需要 API Key）。文件格式：
// { "c1": [...], "c5": [...], "c15": [...] }，每个数组都是 OKX K 线接口 data 的原样格式（新的在前）。
import type { AppConfig } from './config';
import { parseCandles } from './indicators';
import { notionalUsdt, protectionPrices } from './risk';
import { evaluateFast, evaluateMulti, type Signal } from './strategy';

export interface ReplayResult {
  signal: Signal;
  notional: number;
  tp: string;
  sl: string;
  bars: { c1: number; c5: number; c15: number };
}

export function replayFromJson(text: string, cfg: AppConfig): ReplayResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('文件不是有效的 JSON');
  }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const c1 = parseCandles(o.c1);
  const c5 = parseCandles(o.c5);
  const c15 = parseCandles(o.c15);
  if (c5.length < 30) throw new Error('c5（5 分钟 K 线）至少需要 30 根');
  if (cfg.strategy === 'multi' && c15.length < 30) throw new Error('多周期评分策略还需要 c15（15 分钟 K 线）至少 30 根');
  if (c1.length < 5) throw new Error('c1（1 分钟 K 线）至少需要 5 根');
  const last = c1[c1.length - 1].c;
  const nowMs = c1[c1.length - 1].ts;
  const signal =
    cfg.strategy === 'multi'
      ? evaluateMulti(c1, c5, c15, { threshold: cfg.scoreThreshold, breakoutCooldownMs: cfg.breakoutCooldownSec * 1000 })
      : evaluateFast({ last, open24h: c5[0].o, fundingTime: 0, nowMs }, c1, c5, { minSignalScore: cfg.minSignalScore, allowLong: cfg.allowLong, allowShort: cfg.allowShort, avoidFundingWindowMinutes: cfg.avoidFundingMinutes });
  const side = signal.side ?? 'long';
  const { tp, sl } = protectionPrices(side, last, cfg, 0.01);
  return { signal, notional: notionalUsdt(cfg), tp, sl, bars: { c1: c1.length, c5: c5.length, c15: c15.length } };
}
