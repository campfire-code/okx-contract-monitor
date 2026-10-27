// 主界面：监控 / 策略 / 设置 / 日志 四个页签。关闭应用即停止，不做后台常驻。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Eye, FlaskConical, KeyRound, Play, RefreshCw, ShieldAlert, Square, Upload, Zap } from 'lucide-react';
import type { CustomTool } from '../kit/types';
import { CopyButton } from '../kit/parts';
import { httpFetch, pickFiles } from '../kit/platform';
import {
  DEFAULT_CONFIG, LIVE_CONFIRM_TEXT, MODE_NAMES, canArmLive, effectiveMode, sanitizeConfig, type AppConfig, type RunMode,
} from './config';
import { DEMO_LOG, DEMO_NOW, demoSnapshot, demoTick } from './demo';
import { envFor, fetchSnapshot, newFills, newMemory, pnlSummary, strategyTick, type Memory, type Snapshot, type TickResult } from './flow';
import { maskKey, redact, type Creds, type FetchFn, type OkxEnv } from './okx';
import { replayFromJson, type ReplayResult } from './replay';
import { startOfLocalDay } from './risk';
import { STRATEGY_NAMES, type StrategyId } from './strategy';
import { loadConfig, loadCreds, saveConfig, saveCreds } from './store';
import './tool.css';

type Ctx = Parameters<CustomTool['Main']>[0]['ctx'];
type Tab = 'monitor' | 'strategy' | 'settings' | 'log';
interface LogRow { at: number; level: 'info' | 'warn' | 'err' | 'fill'; text: string }

const isPreview = typeof location !== 'undefined' && /preview\.html$/.test(location.pathname);
const previewTab = (): Tab => {
  const t = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('tab') : null;
  return t === 'strategy' || t === 'settings' || t === 'log' ? t : 'monitor';
};

const fetchFn: FetchFn = async (url, init) => {
  const r = await httpFetch(url, { method: init.method, headers: init.headers, body: init.body, connectTimeout: 10_000 });
  return { status: r.status, text: () => r.text() };
};

const sign = (v: number, d = 2) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`;
const cls = (v: number) => (v > 0 ? 'okx-pos' : v < 0 ? 'okx-neg' : '');
const hhmmss = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
const mmdd = (t: number) => new Date(t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const STATE_NAMES: Record<string, string> = { live: '等待成交 / 触发', partially_filled: '部分成交', pause: '已暂停' };
const sideName = (s: string) => (s === 'long' || s === 'buy' ? '多' : s === 'short' || s === 'sell' ? '空' : s);

export function Main(_props: { ctx?: Ctx }) {
  const [tab, setTab] = useState<Tab>(isPreview ? previewTab() : 'monitor');
  const [cfg, setCfg] = useState<AppConfig>(DEFAULT_CONFIG);
  const [creds, setCreds] = useState<Creds | null>(isPreview ? { apiKey: 'demo-key-1234567890', secret: 'x', passphrase: 'x' } : null);
  const [loaded, setLoaded] = useState(isPreview);
  const [liveArmed, setLiveArmed] = useState(false);
  const [snap, setSnap] = useState<Snapshot | null>(isPreview ? demoSnapshot() : null);
  const [snapErr, setSnapErr] = useState('');
  const [watching, setWatching] = useState(!isPreview);
  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState<TickResult | null>(isPreview ? demoTick() : null);
  const [log, setLog] = useState<LogRow[]>(isPreview ? DEMO_LOG : []);
  const [toast, setToast] = useState('');

  const cfgRef = useRef(cfg);
  const credsRef = useRef(creds);
  const armedRef = useRef(liveArmed);
  const memRef = useRef<Memory>(newMemory());
  const prevFills = useRef<Snapshot['fills'] | null>(null);
  const busy = useRef({ snap: false, tick: false });
  cfgRef.current = cfg;
  credsRef.current = creds;
  armedRef.current = liveArmed;

  const addLog = useCallback((level: LogRow['level'], text: string) => {
    // 所有日志落地前统一打码
    setLog((l) => [{ at: Date.now(), level, text: redact(text, credsRef.current) }, ...l].slice(0, 300));
  }, []);

  useEffect(() => {
    if (isPreview) return;
    void Promise.all([loadConfig(), loadCreds()]).then(([c, k]) => {
      // 每次启动实盘都处于未解锁状态：即使上次选的是实盘，这次也先按「只提示」运行
      setCfg(c);
      setCreds(k);
      setLoaded(true);
    });
  }, []);

  const mode = effectiveMode(cfg, liveArmed);
  const makeEnv = useCallback((m: RunMode): OkxEnv => envFor({ fetch: fetchFn, baseUrl: cfgRef.current.baseUrl, creds: credsRef.current, now: Date.now }, m), []);

  // ---- 监控 ----
  const refresh = useCallback(async () => {
    if (isPreview || busy.current.snap || !credsRef.current) return;
    busy.current.snap = true;
    try {
      const s = await fetchSnapshot(makeEnv(effectiveMode(cfgRef.current, armedRef.current)));
      setSnap(s);
      setSnapErr(s.errors.join('；'));
      if (!s.errors.length) {
        for (const f of newFills(prevFills.current, s.fills)) {
          const net = f.fillPnl ? `，已实现 ${sign(f.fillPnl)} USDT` : '';
          addLog('fill', `新成交：${f.instId} ${sideName(f.side)} ${f.fillSz} 张 @ ${f.fillPx}${net}`);
          setToast(`新成交：${f.instId} ${sideName(f.side)} ${f.fillSz} 张`);
        }
        prevFills.current = s.fills;
      }
    } catch (e) {
      setSnapErr(errText(e));
    } finally {
      busy.current.snap = false;
    }
  }, [addLog, makeEnv]);

  useEffect(() => {
    if (!loaded || !watching || !creds) return;
    void refresh();
    const t = setInterval(() => void refresh(), cfg.monitorIntervalSec * 1000);
    return () => clearInterval(t);
  }, [loaded, watching, creds, cfg.monitorIntervalSec, cfg.mode, refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // ---- 策略 ----
  const runTick = useCallback(async () => {
    if (isPreview || busy.current.tick) return;
    busy.current.tick = true;
    try {
      const c = cfgRef.current;
      const r = await strategyTick({ env: makeEnv(effectiveMode(c, armedRef.current)), cfg: c, liveArmed: armedRef.current, memory: memRef.current });
      memRef.current = r.memory;
      setTick(r);
      if (r.snapshot) setSnap(r.snapshot);
      addLog(r.action.kind === 'error' ? 'err' : r.action.kind === 'ordered' ? 'warn' : 'info', r.action.text);
      for (const h of r.closeHints) addLog('info', h);
    } catch (e) {
      addLog('err', `策略检查出错：${errText(e)}`);
    } finally {
      busy.current.tick = false;
    }
  }, [addLog, makeEnv]);

  useEffect(() => {
    if (!running) return;
    void runTick();
    const t = setInterval(() => void runTick(), cfg.strategyIntervalSec * 1000);
    return () => clearInterval(t);
  }, [running, cfg.strategyIntervalSec, runTick]);

  const stop = (why: string) => {
    if (running) {
      setRunning(false);
      addLog('info', why);
    }
  };

  const updateCfg = (next: AppConfig) => {
    const clean = sanitizeConfig(next);
    // 模式、策略、合约变了：停掉正在跑的策略，必须重新点「启动」
    if (clean.mode !== cfg.mode || clean.strategy !== cfg.strategy || clean.instruments.join() !== cfg.instruments.join()) {
      stop('运行模式 / 策略 / 合约已更改，策略已停止，请重新启动');
      memRef.current = newMemory();
    }
    if (clean.mode !== 'live') setLiveArmed(false);
    setCfg(clean);
    void saveConfig(clean);
  };

  const start = () => {
    if (mode === 'sim' && !creds) return addLog('warn', '模拟盘需要先在「设置」里填写模拟盘 API Key');
    memRef.current = newMemory();
    addLog('info', `启动策略：${STRATEGY_NAMES[cfg.strategy]}，模式「${MODE_NAMES[mode].split('（')[0]}」，每 ${cfg.strategyIntervalSec} 秒检查一次`);
    setRunning(true);
  };

  return (
    <div className="okx-root">
      <div className="okx-risk" role="note">
        <ShieldAlert size={16} aria-hidden />
        <span>加密货币合约交易风险极高，可能亏光本金。本工具不构成投资建议，请遵守所在地法律法规。</span>
      </div>
      <div className="okx-tabs" role="tablist" aria-label="功能">
        {([['monitor', '监控'], ['strategy', '策略'], ['settings', '设置'], ['log', `日志${log.length ? ` ${log.length}` : ''}`]] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`k-chip${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
        <span className="okx-sp" />
        <ModeBadge mode={mode} configured={cfg.mode} running={running} />
      </div>
      {isPreview && <div className="okx-demo">示例数据：虚构账户与虚构持仓，不对应任何真实账户或行情</div>}
      {toast && <div className="okx-toast" role="status">{toast}</div>}

      {tab === 'monitor' && <MonitorTab snap={snap} err={snapErr} hasCreds={!!creds} watching={watching} setWatching={setWatching} refresh={refresh} goSettings={() => setTab('settings')} mode={mode} />}
      {tab === 'strategy' && <StrategyTab cfg={cfg} mode={mode} running={running} start={start} stop={() => stop('已手动停止策略')} tick={tick} ctx={_props.ctx} />}
      {tab === 'settings' && (
        <SettingsTab
          cfg={cfg} update={updateCfg} creds={creds} liveArmed={liveArmed}
          setLiveArmed={(v) => { setLiveArmed(v); if (!v) stop('实盘已上锁，策略已停止'); addLog(v ? 'warn' : 'info', v ? '已解锁本次运行的实盘自动下单（关闭应用后自动失效）' : '实盘已上锁'); }}
          saveKeys={async (k) => { const ok = await saveCreds(k); setCreds(k); credsRef.current = k; prevFills.current = null; setSnap(null); stop('API Key 已更改，策略已停止'); return ok; }}
          testKeys={async (k) => { const s = await fetchSnapshot(envFor({ fetch: fetchFn, baseUrl: cfg.baseUrl, creds: k, now: Date.now }, effectiveMode(cfg, liveArmed))); return s.errors.length ? s.errors[0] : null; }}
          loaded={loaded}
        />
      )}
      {tab === 'log' && <LogTab log={log} clear={() => setLog([])} />}
    </div>
  );
}

function ModeBadge({ mode, configured, running }: { mode: RunMode; configured: RunMode; running: boolean }) {
  const downgraded = configured === 'live' && mode !== 'live';
  return (
    <span className={`okx-badge ${mode}`} title={downgraded ? '已选择实盘，但本次运行还没有解锁，按「只提示」运行' : undefined}>
      {mode === 'hint' ? <Eye size={14} aria-hidden /> : mode === 'sim' ? <FlaskConical size={14} aria-hidden /> : <Zap size={14} aria-hidden />}
      {mode === 'hint' ? '只提示' : mode === 'sim' ? '模拟盘' : '实盘'}
      {downgraded && '（未解锁）'}
      {running ? ' · 运行中' : ' · 未运行'}
    </span>
  );
}

// ---------------- 监控 ----------------

function MonitorTab({ snap, err, hasCreds, watching, setWatching, refresh, goSettings, mode }: {
  snap: Snapshot | null; err: string; hasCreds: boolean; watching: boolean; setWatching: (v: boolean) => void; refresh: () => void; goSettings: () => void; mode: RunMode;
}) {
  const sum = useMemo(() => (snap ? pnlSummary(snap.fills, snap.positions, startOfLocalDay(isPreview ? DEMO_NOW : Date.now())) : null), [snap]);
  if (!hasCreds) {
    return (
      <div className="okx-empty k-panel">
        <KeyRound size={30} aria-hidden />
        <b>还没有填写 OKX API Key</b>
        <p className="k-muted">监控账户余额、持仓和盈亏需要 API Key。建议只开「读取」权限；策略页的信号不需要 Key。</p>
        <button className="k-btn primary" onClick={goSettings}>去设置</button>
      </div>
    );
  }
  const usdt = snap?.balance?.details.find((d) => d.ccy === 'USDT');
  return (
    <div className="okx-page">
      <div className="okx-bar">
        <button className="k-btn" onClick={refresh}><RefreshCw size={15} aria-hidden />立即刷新</button>
        <label className="okx-check"><input type="checkbox" checked={watching} onChange={(e) => setWatching(e.target.checked)} />自动刷新</label>
        <span className="k-muted okx-small">{snap ? `更新于 ${hhmmss(snap.at)}` : '尚未获取'} · {mode === 'sim' ? '模拟盘账户' : '正式账户'}</span>
      </div>
      {err && <div className="okx-alert" role="alert"><AlertTriangle size={15} aria-hidden />{err}</div>}
      <div className="okx-cards">
        <Stat label="总权益（USDT）" value={snap?.balance ? snap.balance.totalEq.toFixed(2) : '—'} />
        <Stat label="可用 USDT" value={usdt ? usdt.availBal.toFixed(2) : '—'} />
        <Stat label="浮动盈亏" value={sum ? sign(sum.floating) : '—'} tone={sum?.floating} />
        <Stat label="今日已实现" value={sum ? sign(sum.realizedToday) : '—'} tone={sum?.realizedToday} hint="含手续费，按本机时区当天" />
        <Stat label="近 3 天已实现" value={sum ? sign(sum.realized3d) : '—'} tone={sum?.realized3d} hint="OKX 只返回最近 3 天成交，最多 100 条" />
      </div>
      <Section title={`持仓（${snap?.positions.length ?? 0}）`}>
        <Table head={['合约', '方向', '张数', '开仓均价', '标记价格', '浮动盈亏', '收益率', '杠杆', '强平价']} empty="当前没有持仓"
          rows={(snap?.positions ?? []).map((p) => [p.instId, <span className={p.side === 'long' ? 'okx-pos' : 'okx-neg'}>{p.side === 'long' ? '多' : '空'}</span>, p.size, p.avgPx, p.markPx, <span className={cls(p.upl)}>{sign(p.upl)}</span>, <span className={cls(p.uplRatio)}>{sign(p.uplRatio * 100)}%</span>, `${p.lever}x`, p.liqPx || '—'])} />
      </Section>
      <Section title={`委托与止盈止损（${snap?.orders.length ?? 0}）`}>
        <Table head={['类型', '合约', '方向', '张数', '价格 / 触发价', '状态']} empty="没有未完成的委托"
          rows={(snap?.orders ?? []).map((o) => [o.kind === '止盈止损' ? `止盈止损 ${o.ordType}` : `委托 ${o.ordType}`, o.instId, sideName(o.side), o.size, o.kind === '止盈止损' ? `止盈 ${o.tpTrigger || '—'} / 止损 ${o.slTrigger || '—'}` : o.price || '市价', STATE_NAMES[o.state] ?? o.state])} />
      </Section>
      <Section title="最近成交">
        <Table head={['时间', '合约', '方向', '张数', '成交价', '已实现盈亏', '手续费']} empty="最近 3 天没有成交"
          rows={(snap?.fills ?? []).slice(0, 12).map((f) => [mmdd(f.fillTime), f.instId, sideName(f.side), f.fillSz, f.fillPx, f.fillPnl ? <span className={cls(f.fillPnl)}>{sign(f.fillPnl)}</span> : '—', f.fee.toFixed(4)])} />
      </Section>
    </div>
  );
}

const Stat = ({ label, value, tone, hint }: { label: string; value: string; tone?: number; hint?: string }) => (
  <div className="okx-stat k-panel" title={hint}>
    <span className="k-muted okx-small">{label}</span>
    <b className={`okx-big k-num ${tone === undefined ? '' : cls(tone)}`}>{value}</b>
  </div>
);
const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="k-panel okx-sec"><h3>{title}</h3>{children}</section>
);
function Table({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  if (!rows.length) return <p className="k-muted okx-none">{empty}</p>;
  return (
    <div className="k-table-wrap">
      <table className="k-table k-num">
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

// ---------------- 策略 ----------------

function StrategyTab({ cfg, mode, running, start, stop, tick, ctx }: { cfg: AppConfig; mode: RunMode; running: boolean; start: () => void; stop: () => void; tick: TickResult | null; ctx?: Ctx }) {
  const [replay, setReplay] = useState<ReplayResult | null>(null);
  const [replayErr, setReplayErr] = useState('');
  const loadFile = async () => {
    setReplayErr('');
    try {
      const [p] = await pickFiles(['json'], 'K 线文件');
      if (!p || !ctx) return;
      setReplay(replayFromJson(await ctx.readText(p), cfg));
    } catch (e) {
      setReplay(null);
      setReplayErr(errText(e));
    }
  };
  return (
    <div className="okx-page">
      <section className="k-panel okx-sec">
        <div className="okx-bar">
          {running ? <button className="k-btn" onClick={stop}><Square size={15} aria-hidden />停止策略</button> : <button className="k-btn primary" onClick={start}><Play size={15} aria-hidden />启动策略</button>}
          <span className="k-muted okx-small">{STRATEGY_NAMES[cfg.strategy]} · 合约 {cfg.instruments.join('、')} · 每 {cfg.strategyIntervalSec} 秒检查</span>
        </div>
        <p className="okx-mode-note">
          {mode === 'hint' && '当前为「只提示」：只显示信号和建议仓位，不会下任何单。'}
          {mode === 'sim' && '当前为「模拟盘」：满足条件时会在 OKX 模拟交易里下单（需要模拟盘 API Key）。'}
          {mode === 'live' && '当前为「实盘自动下单」：满足条件时会用真实资金下单。关闭应用即停止。'}
        </p>
      </section>

      {!tick ? (
        <p className="okx-empty-line k-muted">点「启动策略」后，这里显示每一轮的信号、建议仓位、止盈止损和风控判断。</p>
      ) : (
        <>
          <section className={`okx-action ${tick.action.kind}`} role="status">
            <b>{tick.action.kind === 'ordered' ? '已下单' : tick.action.kind === 'hint' ? '信号提示' : tick.action.kind === 'blocked' ? '被拦下' : tick.action.kind === 'error' ? '出错' : '观望'}</b>
            <span>{tick.action.text}</span>
            <span className="k-muted okx-small">{hhmmss(tick.at)}</span>
          </section>
          {tick.closeHints.map((h) => <div key={h} className="okx-alert"><AlertTriangle size={15} aria-hidden />{h}</div>)}
          <Section title="各合约信号">
            <Table head={['合约', '方向', '评分', '价格', '建议张数', '名义金额', '止盈', '止损', '止损亏损']} empty="没有数据"
              rows={tick.rows.map((r) => [
                r.instId,
                r.signal.side ? <b className={r.signal.side === 'long' ? 'okx-pos' : 'okx-neg'}>{r.signal.side === 'long' ? '做多' : '做空'}</b> : <span className="k-muted">观望</span>,
                sign(r.signal.score, 1), r.signal.price, r.plan?.sz ?? '—', r.plan ? r.plan.notional.toFixed(0) : '—', r.plan?.tp ?? '—', r.plan?.sl ?? '—', r.plan ? `-${r.plan.maxLoss.toFixed(2)}` : '—',
              ])} />
          </Section>
          <div className="okx-two">
            <Section title="信号依据 / 被拦原因">
              <ul className="okx-list">
                {tick.rows.flatMap((r) => [...r.signal.reasons.map((x) => `${r.instId}：${x}`), ...r.signal.blocks.map((x) => `${r.instId}：拦下 - ${x}`)]).slice(0, 10).map((x) => <li key={x}>{x}</li>)}
                {!tick.rows.some((r) => r.signal.reasons.length || r.signal.blocks.length) && <li className="k-muted">暂无</li>}
              </ul>
            </Section>
            <Section title="风控状态">
              <ul className="okx-list">
                <li>单日亏损上限 {cfg.dailyLossLimitUsdt} USDT · 连亏 {cfg.maxConsecutiveLosses} 次暂停 · 平仓后冷静 {cfg.cooldownSec} 秒</li>
                <li>{tick.gate ? (tick.gate.allowed ? '风控放行' : `风控：${tick.gate.reason}`) : '没有信号，风控未触发'}</li>
                <li>杠杆 {cfg.leverage}x（上限 {cfg.maxLeverage}x）· 单笔最大名义金额 {cfg.maxNotionalUsdt} USDT</li>
              </ul>
            </Section>
          </div>
        </>
      )}

      <Section title="用 K 线文件离线试算">
        <p className="k-muted okx-small">不联网、不需要 API Key。选一个 JSON 文件（格式见 README 的 samples 示例），按当前策略和参数算出信号。</p>
        <div className="okx-bar"><button className="k-btn" onClick={loadFile}><Upload size={15} aria-hidden />选择 K 线文件</button></div>
        {replayErr && <div className="okx-alert" role="alert"><AlertTriangle size={15} aria-hidden />{replayErr}</div>}
        {replay && (
          <div className="okx-replay">
            <b className={replay.signal.side === 'long' ? 'okx-pos' : replay.signal.side === 'short' ? 'okx-neg' : ''}>{replay.signal.side === 'long' ? '做多' : replay.signal.side === 'short' ? '做空' : '观望'}</b>
            <span className="k-num">评分 {sign(replay.signal.score, 1)} · 价格 {replay.signal.price}{replay.signal.side ? ` · 名义金额约 ${replay.notional.toFixed(0)} USDT · 止盈 ${replay.tp} · 止损 ${replay.sl}` : ''}</span>
            <span className="k-muted okx-small">{[...replay.signal.reasons, ...replay.signal.blocks.map((b) => `拦下：${b}`)].join('；')}</span>
          </div>
        )}
      </Section>
    </div>
  );
}

// ---------------- 设置 ----------------

function NumField({ label, value, unit, help, onCommit, step }: { label: string; value: number; unit?: string; help?: string; onCommit: (v: number) => void; step?: number }) {
  const [txt, setTxt] = useState(String(value));
  useEffect(() => setTxt(String(value)), [value]);
  return (
    <label className="k-field">
      <span className="k-label">{label}</span>
      <span className="okx-inline">
        <input className="k-input k-num" inputMode="decimal" step={step} value={txt} onChange={(e) => setTxt(e.target.value)} onBlur={() => { const n = Number(txt); if (txt.trim() !== '' && Number.isFinite(n)) onCommit(n); else setTxt(String(value)); }} />
        {unit && <span className="k-muted okx-small">{unit}</span>}
      </span>
      {help && <span className="k-help">{help}</span>}
    </label>
  );
}

function SettingsTab({ cfg, update, creds, liveArmed, setLiveArmed, saveKeys, testKeys, loaded }: {
  cfg: AppConfig; update: (c: AppConfig) => void; creds: Creds | null; liveArmed: boolean; setLiveArmed: (v: boolean) => void;
  saveKeys: (k: Creds | null) => Promise<boolean>; testKeys: (k: Creds) => Promise<string | null>; loaded: boolean;
}) {
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [pass, setPass] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState('');
  const set = <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => update({ ...cfg, [k]: v });
  const filled = key.trim() && secret.trim() && pass.trim();
  const mask = (t: string) => (creds ? redact(t, creds) : t);

  return (
    <div className="okx-page okx-settings">
      <Section title="OKX API Key">
        <p className="k-muted okx-small">只保存在本机，日志里自动打码。<b>建议只开「读取」权限</b>（只看账户不下单）；模拟盘请使用在 OKX「模拟交易」里创建的 API Key。不要开提现权限。保存的 Key 在本机设置文件里是明文，请保管好你的电脑。</p>
        {creds && <p className="okx-saved">已保存 Key：<code>{maskKey(creds.apiKey)}</code></p>}
        <div className="okx-grid">
          <label className="k-field"><span className="k-label">API Key</span><input className="k-input" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={creds ? '留空表示不修改' : ''} /></label>
          <label className="k-field"><span className="k-label">Secret Key</span><input className="k-input" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></label>
          <label className="k-field"><span className="k-label">Passphrase</span><input className="k-input" type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} /></label>
        </div>
        <div className="okx-bar">
          <button className="k-btn primary" disabled={!filled} onClick={async () => { const k = { apiKey: key.trim(), secret: secret.trim(), passphrase: pass.trim() }; const ok = await saveKeys(k); setKey(''); setSecret(''); setPass(''); setMsg({ ok, text: ok ? '已保存到本机' : '保存失败：本机设置文件不可写' }); }}>保存</button>
          <button className="k-btn" disabled={!filled && !creds} onClick={async () => { setMsg({ ok: true, text: '测试中…' }); const k = filled ? { apiKey: key.trim(), secret: secret.trim(), passphrase: pass.trim() } : creds!; const e = await testKeys(k); setMsg(e ? { ok: false, text: mask(e) } : { ok: true, text: '连接成功，已能读取账户数据' }); }}>测试连接</button>
          <button className="k-btn ghost" disabled={!creds} onClick={async () => { await saveKeys(null); setMsg({ ok: true, text: '已清除本机保存的 Key' }); }}>清除</button>
          {msg && <span className={msg.ok ? 'okx-ok' : 'okx-neg'} role="status">{msg.text}</span>}
        </div>
      </Section>

      <Section title="运行模式">
        <div className="okx-modes" role="radiogroup" aria-label="运行模式">
          {(['hint', 'sim', 'live'] as RunMode[]).map((m) => (
            <label key={m} className={`okx-mode${cfg.mode === m ? ' on' : ''}`}>
              <input type="radio" name="mode" checked={cfg.mode === m} onChange={() => set('mode', m)} />
              <span><b>{MODE_NAMES[m].split('（')[0]}</b><small>{MODE_NAMES[m].match(/（(.*)）/)?.[1]}</small></span>
            </label>
          ))}
        </div>
        {cfg.mode === 'live' && (
          <div className="okx-live" role="group" aria-label="实盘解锁">
            <p><b>实盘自动下单会用真实资金开仓，可能亏光本金。</b>下单受下方的最大杠杆、单笔最大金额、单日亏损上限保护，但这些保护不能保证不亏损。解锁只在本次运行有效，关闭应用后自动上锁。</p>
            <label className="okx-check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />我了解合约交易风险极高，愿意自行承担全部后果</label>
            <label className="k-field"><span className="k-label">请原样输入：{LIVE_CONFIRM_TEXT}</span><input className="k-input" value={typed} onChange={(e) => setTyped(e.target.value)} disabled={liveArmed} /></label>
            <div className="okx-bar">
              {liveArmed
                ? <button className="k-btn" onClick={() => { setLiveArmed(false); setTyped(''); setAck(false); }}>重新上锁</button>
                : <button className="k-btn primary" disabled={!canArmLive(ack, typed)} onClick={() => setLiveArmed(true)}>解锁实盘自动下单</button>}
              <span className={liveArmed ? 'okx-neg' : 'k-muted'}>{liveArmed ? '已解锁（仅本次运行）' : '未解锁：当前按「只提示」运行'}</span>
            </div>
          </div>
        )}
      </Section>

      <Section title="策略与合约">
        <div className="okx-grid">
          <label className="k-field"><span className="k-label">策略</span>
            <select className="k-input" value={cfg.strategy} onChange={(e) => set('strategy', e.target.value as StrategyId)}>
              {(Object.keys(STRATEGY_NAMES) as StrategyId[]).map((s) => <option key={s} value={s}>{STRATEGY_NAMES[s]}</option>)}
            </select></label>
          <label className="k-field"><span className="k-label">合约（USDT 本位永续，逗号分隔，最多 5 个）</span>
            <input className="k-input" defaultValue={cfg.instruments.join(',')} key={cfg.instruments.join()} onBlur={(e) => set('instruments', e.target.value.split(/[,，\s]+/).filter(Boolean))} /></label>
          <NumField label="策略检查间隔" unit="秒" value={cfg.strategyIntervalSec} onCommit={(v) => set('strategyIntervalSec', v)} help="20 秒起" />
          <NumField label="监控刷新间隔" unit="秒" value={cfg.monitorIntervalSec} onCommit={(v) => set('monitorIntervalSec', v)} help="10 秒起" />
          {cfg.strategy === 'multi' ? <NumField label="开仓评分阈值" value={cfg.scoreThreshold} onCommit={(v) => set('scoreThreshold', v)} help="5 分钟评分绝对值达到它才算信号，越高越谨慎" />
            : <NumField label="最低方向分" value={cfg.minSignalScore} onCommit={(v) => set('minSignalScore', v)} help="方向分达到它且领先另一方至少 3 分" />}
          <NumField label="突破后冷静期" unit="秒" value={cfg.breakoutCooldownSec} onCommit={(v) => set('breakoutCooldownSec', v)} help="多周期策略：向上突破后不追空，向下跌破后不追多" />
        </div>
        {cfg.strategy === 'fast' && (
          <div className="okx-bar">
            <label className="okx-check"><input type="checkbox" checked={cfg.allowLong} onChange={(e) => set('allowLong', e.target.checked)} />允许做多</label>
            <label className="okx-check"><input type="checkbox" checked={cfg.allowShort} onChange={(e) => set('allowShort', e.target.checked)} />允许做空</label>
            <NumField label="资金费结算前后避开" unit="分钟" value={cfg.avoidFundingMinutes} onCommit={(v) => set('avoidFundingMinutes', v)} />
          </div>
        )}
      </Section>

      <Section title="仓位与风控（实盘与模拟盘下单都受这些限制）">
        <div className="okx-grid">
          <NumField label="杠杆" unit="倍" value={cfg.leverage} onCommit={(v) => set('leverage', v)} help="不能超过下面的最大杠杆" />
          <NumField label="最大杠杆" unit="倍" value={cfg.maxLeverage} onCommit={(v) => set('maxLeverage', v)} help="下单前再校验一次，超过就拒绝" />
          <NumField label="最多动用保证金" unit="USDT" value={cfg.maxEquityUsdt} onCommit={(v) => set('maxEquityUsdt', v)} />
          <NumField label="单笔最大亏损" unit="USDT" value={cfg.riskPerTradeUsdt} onCommit={(v) => set('riskPerTradeUsdt', v)} help="按止损幅度反推仓位大小" />
          <NumField label="单笔最大名义金额" unit="USDT" value={cfg.maxNotionalUsdt} onCommit={(v) => set('maxNotionalUsdt', v)} help="BTC 每张约 0.01 BTC，太小会算不出整数张" />
          <NumField label="止损" unit="%" value={cfg.stopLossPct} onCommit={(v) => set('stopLossPct', v)} step={0.1} />
          <NumField label="止盈" unit="%" value={cfg.takeProfitPct} onCommit={(v) => set('takeProfitPct', v)} step={0.1} />
          <NumField label="单日亏损上限" unit="USDT" value={cfg.dailyLossLimitUsdt} onCommit={(v) => set('dailyLossLimitUsdt', v)} help="当天已实现亏损（含手续费）达到后不再开仓" />
          <NumField label="连续亏损暂停" unit="次" value={cfg.maxConsecutiveLosses} onCommit={(v) => set('maxConsecutiveLosses', v)} />
          <NumField label="平仓后冷静期" unit="秒" value={cfg.cooldownSec} onCommit={(v) => set('cooldownSec', v)} />
        </div>
        <label className="k-field okx-url"><span className="k-label">OKX 接口地址</span>
          <input className="k-input" defaultValue={cfg.baseUrl} key={cfg.baseUrl} onBlur={(e) => set('baseUrl', e.target.value)} />
          <span className="k-help">默认使用官方文档给出的 https://openapi.okx.com；部分地区需要使用 OKX 为该地区提供的域名，请以官方文档为准。</span></label>
        {!loaded && <p className="k-muted okx-small">正在读取本机设置…</p>}
      </Section>
    </div>
  );
}

// ---------------- 日志 ----------------

function LogTab({ log, clear }: { log: LogRow[]; clear: () => void }) {
  const text = log.map((l) => `${new Date(l.at).toLocaleString('zh-CN', { hour12: false })}  ${l.text}`).join('\n');
  return (
    <div className="okx-page">
      <div className="okx-bar">
        <CopyButton text={text} label="复制日志" />
        <button className="k-btn ghost" onClick={clear} disabled={!log.length}>清空</button>
        <span className="k-muted okx-small">日志只保存在内存里，关闭应用即清空；密钥、口令已自动打码。</span>
      </div>
      <section className="k-panel okx-logs">
        {log.length === 0 && <p className="k-muted okx-none">还没有日志</p>}
        {log.map((l, i) => (
          <div key={`${l.at}-${i}`} className={`okx-log ${l.level}`}>
            <span className="k-muted k-num">{hhmmss(l.at)}</span>
            <span>{l.text}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
