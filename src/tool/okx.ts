// OKX API v5：签名、请求、响应解析。
// 依据 OKX 官方文档（https://www.okx.com/docs-v5/en/）：
//  - 请求头 OK-ACCESS-KEY / OK-ACCESS-SIGN / OK-ACCESS-TIMESTAMP / OK-ACCESS-PASSPHRASE
//  - 时间戳为 ISO 8601 UTC，毫秒精度，例如 2020-12-08T09:08:57.715Z；与服务器相差超过 30 秒会被拒绝
//  - 签名 = Base64(HmacSHA256(时间戳 + 大写方法 + 请求路径含查询串 + 请求体, SecretKey))
//  - 模拟盘：同一个接口地址，请求头加 x-simulated-trading: 1，并使用在「模拟交易」里创建的 API Key
import type { Fill, InstrumentSpec } from './risk';

export interface Creds {
  apiKey: string;
  secret: string;
  passphrase: string;
}

export interface HttpResponse {
  status: number;
  text(): Promise<string>;
}
export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpResponse>;

export interface OkxEnv {
  fetch: FetchFn;
  baseUrl: string;
  simulated: boolean;
  creds: Creds | null;
  now: () => number;
}

export class OkxError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const enc = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export async function sign(secret: string, timestamp: string, method: string, requestPath: string, body = ''): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(timestamp + method.toUpperCase() + requestPath + body));
  return toBase64(new Uint8Array(sig));
}

/** 查询串：逗号不转义（官方文档示例里多值参数直接写逗号），签名与实际发送的路径保持一致 */
export function withQuery(path: string, query?: Record<string, string | number | undefined>): string {
  const parts = Object.entries(query ?? {})
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%2C/gi, ',')}`);
  return parts.length ? `${path}?${parts.join('&')}` : path;
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body?: string;
  method: string;
}

export async function buildRequest(env: OkxEnv, method: 'GET' | 'POST', path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown; auth?: boolean } = {}): Promise<BuiltRequest> {
  const requestPath = withQuery(path, opts.query);
  const body = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.simulated) headers['x-simulated-trading'] = '1';
  if (opts.auth) {
    if (!env.creds) throw new Error('还没有填写 API Key，请先到「设置」里填写');
    const ts = new Date(env.now()).toISOString();
    headers['OK-ACCESS-KEY'] = env.creds.apiKey;
    headers['OK-ACCESS-SIGN'] = await sign(env.creds.secret, ts, method, requestPath, body);
    headers['OK-ACCESS-TIMESTAMP'] = ts;
    headers['OK-ACCESS-PASSPHRASE'] = env.creds.passphrase;
  }
  return { url: env.baseUrl + requestPath, headers, body: body || undefined, method };
}

/** 日志 / 报错里的打码：把密钥、口令、Key 的原文替换掉 */
export function redact(text: string, creds: Creds | null): string {
  let out = text;
  if (creds) {
    for (const s of [creds.secret, creds.passphrase, creds.apiKey]) {
      if (s && s.length >= 4) out = out.split(s).join('***');
    }
  }
  return out.replace(/("?(?:OK-ACCESS-(?:KEY|SIGN|PASSPHRASE)|secret|passphrase|apiKey)"?\s*[:=]\s*"?)[^",\s}]+/gi, '$1***');
}

/** 显示用：只露出前 4 位和后 2 位 */
export function maskKey(k: string): string {
  if (!k) return '';
  return k.length <= 8 ? '*'.repeat(k.length) : `${k.slice(0, 4)}****${k.slice(-2)}`;
}

export async function okx<T = unknown>(env: OkxEnv, method: 'GET' | 'POST', path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown; auth?: boolean } = {}): Promise<T[]> {
  const req = await buildRequest(env, method, path, opts);
  let res: HttpResponse;
  try {
    res = await env.fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  } catch (e) {
    throw new Error(redact(`网络请求失败：${e instanceof Error ? e.message : String(e)}`, env.creds));
  }
  const text = await res.text();
  let json: { code?: string; msg?: string; data?: T[] };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(redact(`OKX 返回了无法解析的内容（HTTP ${res.status}）`, env.creds));
  }
  if (json.code !== '0') {
    const detail = (json.data as { sCode?: string; sMsg?: string }[] | undefined)?.find((d) => d?.sCode && d.sCode !== '0');
    throw new OkxError(detail?.sCode ?? String(json.code ?? res.status), redact(`OKX 报错 ${detail?.sCode ?? json.code}：${detail?.sMsg || json.msg || '未知'}`, env.creds));
  }
  return json.data ?? [];
}

// ---------------- 响应解析 ----------------

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
type Row = Record<string, string | undefined>;

export interface BalanceInfo {
  totalEq: number;
  upl: number;
  details: { ccy: string; eq: number; availBal: number; upl: number }[];
}

export function parseBalance(data: unknown[]): BalanceInfo {
  const d = (data[0] ?? {}) as Row & { details?: Row[] };
  const details = (d.details ?? []).map((x) => ({ ccy: x.ccy ?? '', eq: n(x.eq), availBal: n(x.availBal), upl: n(x.upl) })).filter((x) => x.eq !== 0 || x.availBal !== 0);
  return { totalEq: n(d.totalEq), upl: n(d.upl) || details.reduce((s, x) => s + x.upl, 0), details };
}

export interface Position {
  instId: string;
  /** long / short（净持仓模式下由张数正负判断） */
  side: 'long' | 'short';
  size: number;
  avgPx: number;
  markPx: number;
  upl: number;
  uplRatio: number;
  lever: number;
  liqPx: number;
  mgnMode: string;
}

export function parsePositions(data: unknown[]): Position[] {
  return (data as Row[])
    .filter((p) => n(p.pos) !== 0)
    .map((p) => {
      const pos = n(p.pos);
      const side = p.posSide === 'long' || p.posSide === 'short' ? p.posSide : pos > 0 ? 'long' : 'short';
      return { instId: p.instId ?? '', side, size: Math.abs(pos), avgPx: n(p.avgPx), markPx: n(p.markPx), upl: n(p.upl), uplRatio: n(p.uplRatio), lever: n(p.lever), liqPx: n(p.liqPx), mgnMode: p.mgnMode ?? '' };
    });
}

export interface PendingOrder {
  id: string;
  kind: '委托' | '止盈止损';
  instId: string;
  side: string;
  posSide: string;
  ordType: string;
  size: number;
  price: number;
  tpTrigger: number;
  slTrigger: number;
  state: string;
}

export function parseOrders(data: unknown[]): PendingOrder[] {
  return (data as Row[]).map((o) => ({ id: o.ordId ?? '', kind: '委托', instId: o.instId ?? '', side: o.side ?? '', posSide: o.posSide ?? '', ordType: o.ordType ?? '', size: n(o.sz), price: n(o.px), tpTrigger: 0, slTrigger: 0, state: o.state ?? '' }));
}

export function parseAlgoOrders(data: unknown[]): PendingOrder[] {
  return (data as Row[]).map((o) => ({ id: o.algoId ?? '', kind: '止盈止损', instId: o.instId ?? '', side: o.side ?? '', posSide: o.posSide ?? '', ordType: o.ordType ?? '', size: n(o.sz), price: 0, tpTrigger: n(o.tpTriggerPx), slTrigger: n(o.slTriggerPx), state: o.state ?? '' }));
}

export function parseFills(data: unknown[]): Fill[] {
  return (data as Row[]).map((f) => ({ instId: f.instId ?? '', ordId: f.ordId ?? '', side: f.side ?? '', posSide: f.posSide ?? '', fillPx: n(f.fillPx), fillSz: n(f.fillSz), fillPnl: n(f.fillPnl), fee: n(f.fee), fillTime: n(f.fillTime ?? f.ts) })).sort((a, b) => b.fillTime - a.fillTime);
}

export function parseInstrument(data: unknown[]): InstrumentSpec {
  const r = (data[0] ?? {}) as Row;
  const spec: InstrumentSpec = { instId: r.instId ?? '', ctType: r.ctType ?? '', ctVal: n(r.ctVal), ctValCcy: r.ctValCcy ?? '', lotSz: n(r.lotSz), minSz: n(r.minSz), tickSz: n(r.tickSz) };
  if (!spec.instId || !spec.ctVal || !spec.lotSz || !spec.minSz || !spec.tickSz) throw new Error('合约规格不完整，无法计算下单张数');
  if (r.state && r.state !== 'live') throw new Error(`${spec.instId} 当前不可交易（状态 ${r.state}）`);
  return spec;
}

// ---------------- 下单 ----------------

export interface OrderBodyInput {
  instId: string;
  side: 'long' | 'short';
  sz: string;
  tp: string;
  sl: string;
  /** 账户持仓模式：long_short_mode 需要传 posSide */
  posMode: string;
  clientTag: string;
}

/** 市价开仓并随单附带止盈止损（attachAlgoOrds；tpOrdPx / slOrdPx 为 -1 表示触发后按市价） */
export function buildOrderBody(i: OrderBodyInput) {
  const body: Record<string, unknown> = {
    instId: i.instId,
    tdMode: 'cross',
    side: i.side === 'long' ? 'buy' : 'sell',
    ordType: 'market',
    sz: i.sz,
    attachAlgoOrds: [{ attachAlgoClOrdId: i.clientTag, tpTriggerPx: i.tp, tpOrdPx: '-1', slTriggerPx: i.sl, slOrdPx: '-1' }],
  };
  if (i.posMode === 'long_short_mode') body.posSide = i.side;
  return body;
}
