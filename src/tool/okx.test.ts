import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { balanceResp, fillsResp, instrumentResp, positionsResp } from './fixtures';
import {
  OkxError, buildOrderBody, buildRequest, maskKey, okx, parseAlgoOrders, parseBalance, parseFills, parseInstrument, parseOrders, parsePositions, redact, sign, withQuery,
  type Creds, type OkxEnv,
} from './okx';

const creds: Creds = { apiKey: 'demo-key-1234567890', secret: 'demo-secret-ABCDEFGH', passphrase: 'demo-pass-9876' };
const NOW = Date.UTC(2026, 9, 27, 7, 8, 9, 123);
const env = (over: Partial<OkxEnv> = {}): OkxEnv => ({ fetch: async () => { throw new Error('不应联网'); }, baseUrl: 'https://openapi.okx.com', simulated: false, creds, now: () => NOW, ...over });
const reply = (body: unknown, status = 200) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

describe('签名', () => {
  it('与 Node 自带 HMAC-SHA256 + Base64 结果一致', async () => {
    const ts = '2020-12-08T09:08:57.715Z';
    const path = '/api/v5/account/balance?ccy=BTC,ETH';
    const expected = createHmac('sha256', creds.secret).update(ts + 'GET' + path).digest('base64');
    expect(await sign(creds.secret, ts, 'get', path)).toBe(expected);
    const body = '{"a":"1"}';
    expect(await sign(creds.secret, ts, 'POST', '/api/v5/trade/order', body)).toBe(createHmac('sha256', creds.secret).update(ts + 'POST/api/v5/trade/order' + body).digest('base64'));
  });
  it('查询串保留逗号（官方多值写法），其余转义', () => {
    expect(withQuery('/p', { ordType: 'conditional,oco', instType: 'SWAP' })).toBe('/p?ordType=conditional,oco&instType=SWAP');
    expect(withQuery('/p', { a: undefined, b: '', c: 'x y' })).toBe('/p?c=x%20y');
    expect(withQuery('/p')).toBe('/p');
  });
});

describe('请求构造', () => {
  it('带鉴权头：毫秒精度 ISO 时间戳，签名覆盖含查询串的路径', async () => {
    const r = await buildRequest(env(), 'GET', '/api/v5/trade/fills', { query: { instType: 'SWAP', limit: 100 }, auth: true });
    expect(r.url).toBe('https://openapi.okx.com/api/v5/trade/fills?instType=SWAP&limit=100');
    expect(r.headers['OK-ACCESS-TIMESTAMP']).toBe('2026-10-27T07:08:09.123Z');
    expect(r.headers['OK-ACCESS-KEY']).toBe(creds.apiKey);
    expect(r.headers['OK-ACCESS-PASSPHRASE']).toBe(creds.passphrase);
    expect(r.headers['OK-ACCESS-SIGN']).toBe(createHmac('sha256', creds.secret).update('2026-10-27T07:08:09.123Z' + 'GET' + '/api/v5/trade/fills?instType=SWAP&limit=100').digest('base64'));
    expect(r.headers['x-simulated-trading']).toBeUndefined();
  });
  it('POST 把请求体计入签名', async () => {
    const body = { instId: 'BTC-USDT-SWAP', sz: '1' };
    const r = await buildRequest(env(), 'POST', '/api/v5/trade/order', { body, auth: true });
    expect(r.body).toBe(JSON.stringify(body));
    expect(r.headers['OK-ACCESS-SIGN']).toBe(createHmac('sha256', creds.secret).update('2026-10-27T07:08:09.123Z' + 'POST' + '/api/v5/trade/order' + JSON.stringify(body)).digest('base64'));
  });
  it('模拟盘加 x-simulated-trading: 1', async () => {
    const r = await buildRequest(env({ simulated: true }), 'GET', '/api/v5/market/candles', { query: { instId: 'BTC-USDT-SWAP' } });
    expect(r.headers['x-simulated-trading']).toBe('1');
    expect(r.headers['OK-ACCESS-KEY']).toBeUndefined();
  });
  it('公开行情不带鉴权头，也不要求填 Key', async () => {
    const r = await buildRequest(env({ creds: null }), 'GET', '/api/v5/market/ticker', { query: { instId: 'BTC-USDT-SWAP' } });
    expect(Object.keys(r.headers)).toEqual(['Content-Type']);
  });
  it('需要鉴权但没填 Key 时给出中文提示', async () => {
    await expect(buildRequest(env({ creds: null }), 'GET', '/api/v5/account/balance', { auth: true })).rejects.toThrow('API Key');
  });
});

describe('响应处理与打码', () => {
  it('code=0 返回 data', async () => {
    const data = await okx(env({ fetch: async () => reply(balanceResp) }), 'GET', '/api/v5/account/balance', { auth: true });
    expect(data).toHaveLength(1);
  });
  it('code 非 0 抛出带错误码的中文报错', async () => {
    const e = env({ fetch: async () => reply({ code: '50111', msg: 'Invalid OK-ACCESS-KEY', data: [] }) });
    await expect(okx(e, 'GET', '/x', { auth: true })).rejects.toThrow('OKX 报错 50111');
    await expect(okx(e, 'GET', '/x', { auth: true })).rejects.toBeInstanceOf(OkxError);
  });
  it('下单类接口外层 code 非 0 时，优先报告 data 里的 sCode / sMsg', async () => {
    const e = env({ fetch: async () => reply({ code: '1', msg: 'All operations failed', data: [{ sCode: '51008', sMsg: 'Insufficient balance' }] }) });
    await expect(okx(e, 'POST', '/api/v5/trade/order', { body: {}, auth: true })).rejects.toThrow('51008：Insufficient balance');
  });
  it('网络错误和乱码响应都转成中文提示，且不含密钥', async () => {
    await expect(okx(env({ fetch: async () => { throw new Error(`connect failed ${creds.secret}`); } }), 'GET', '/x')).rejects.toThrow(/网络请求失败：connect failed \*\*\*/);
    await expect(okx(env({ fetch: async () => reply('<html>', 502) }), 'GET', '/x')).rejects.toThrow('HTTP 502');
  });
  it('报错信息里出现的密钥、口令、Key 会被打码', async () => {
    const e = env({ fetch: async () => reply({ code: '50105', msg: `bad passphrase ${creds.passphrase} for ${creds.apiKey}`, data: [] }) });
    await expect(okx(e, 'GET', '/x', { auth: true })).rejects.toThrow(/bad passphrase \*\*\* for \*\*\*/);
  });
  it('redact 处理 JSON / 请求头样式的字段', () => {
    const t = redact('{"secret":"abcdefgh","passphrase":"xyz12345"} OK-ACCESS-SIGN: QWxhZGRpbg==', null);
    expect(t).not.toContain('abcdefgh');
    expect(t).not.toContain('xyz12345');
    expect(t).not.toContain('QWxhZGRpbg');
    expect(redact(`k=${creds.apiKey}`, creds)).toBe('k=***');
  });
  it('maskKey 只显示前 4 位和后 2 位', () => {
    expect(maskKey('demo-key-1234567890')).toBe('demo****90');
    expect(maskKey('abc')).toBe('***');
    expect(maskKey('')).toBe('');
  });
});

describe('解析', () => {
  it('余额', () => {
    const b = parseBalance(balanceResp.data);
    expect(b.totalEq).toBe(1523.46);
    expect(b.upl).toBe(3.82);
    expect(b.details.map((d) => d.ccy)).toEqual(['USDT', 'BTC']);
    expect(parseBalance([])).toEqual({ totalEq: 0, upl: 0, details: [] });
  });
  it('持仓：净持仓按张数正负判断多空，跳过空仓', () => {
    const p = parsePositions(positionsResp.data);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ instId: 'BTC-USDT-SWAP', side: 'long', size: 3, upl: 8.09, lever: 2 });
    expect(p[1]).toMatchObject({ side: 'short', size: 5, upl: -5.85 });
  });
  it('成交按时间从新到旧', () => {
    const f = parseFills(fillsResp(NOW).data);
    expect(f.map((x) => x.ordId)).toEqual(['9001', '9000', '8999']);
    expect(f[0]).toMatchObject({ fillPnl: 6.2, fee: -0.26 });
  });
  it('委托单与止盈止损单', () => {
    expect(parseOrders([{ ordId: '1', instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'limit', sz: '2', px: '64000', state: 'live' }])[0]).toMatchObject({ kind: '委托', price: 64000, size: 2 });
    expect(parseAlgoOrders([{ algoId: '7', instId: 'BTC-USDT-SWAP', side: 'sell', ordType: 'oco', sz: '2', tpTriggerPx: '65650', slTriggerPx: '64675', state: 'live' }])[0]).toMatchObject({ kind: '止盈止损', tpTrigger: 65650, slTrigger: 64675 });
  });
  it('合约规格：缺字段或不可交易时报错', () => {
    expect(parseInstrument(instrumentResp().data)).toMatchObject({ ctVal: 0.01, lotSz: 1, minSz: 1, tickSz: 0.1 });
    expect(() => parseInstrument([{ instId: 'X' }])).toThrow('不完整');
    expect(() => parseInstrument([{ ...instrumentResp().data[0], state: 'suspend' }])).toThrow('不可交易');
  });
});

describe('下单请求体', () => {
  const input = { instId: 'BTC-USDT-SWAP', side: 'long' as const, sz: '2', tp: '65650.0', sl: '64675.0', clientTag: 'cfabc' };
  it('净持仓模式：市价单 + 随单止盈止损，不带 posSide', () => {
    const b = buildOrderBody({ ...input, posMode: 'net_mode' });
    expect(b).toMatchObject({ instId: 'BTC-USDT-SWAP', tdMode: 'cross', side: 'buy', ordType: 'market', sz: '2' });
    expect(b.posSide).toBeUndefined();
    expect(b.attachAlgoOrds).toEqual([{ attachAlgoClOrdId: 'cfabc', tpTriggerPx: '65650.0', tpOrdPx: '-1', slTriggerPx: '64675.0', slOrdPx: '-1' }]);
  });
  it('双向持仓模式：带 posSide，空单为 sell', () => {
    const b = buildOrderBody({ ...input, side: 'short', posMode: 'long_short_mode' });
    expect(b).toMatchObject({ side: 'sell', posSide: 'short' });
  });
});
