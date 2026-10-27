// 配置与 API Key 保存在本机应用数据目录的 settings.json（kit 的 settingsStore），不上传。
// 注意：Key / Secret / Passphrase 在该文件里是明文，请只开「读取」权限，或使用模拟盘 Key。
import { settingsStore } from '../kit/platform';
import { sanitizeConfig, type AppConfig } from './config';
import type { Creds } from './okx';

const CFG_KEY = 'config.a10';
const CRED_KEY = 'creds.a10';

export async function loadConfig(): Promise<AppConfig> {
  try {
    return sanitizeConfig(await (await settingsStore()).get(CFG_KEY));
  } catch {
    return sanitizeConfig(null);
  }
}

export async function saveConfig(c: AppConfig): Promise<void> {
  try {
    const st = await settingsStore();
    await st.set(CFG_KEY, c);
    await st.save();
  } catch {
    /* 预览环境没有本机存储 */
  }
}

export async function loadCreds(): Promise<Creds | null> {
  try {
    const v = await (await settingsStore()).get<Partial<Creds>>(CRED_KEY);
    return v && v.apiKey && v.secret && v.passphrase ? { apiKey: v.apiKey, secret: v.secret, passphrase: v.passphrase } : null;
  } catch {
    return null;
  }
}

export async function saveCreds(c: Creds | null): Promise<boolean> {
  try {
    const st = await settingsStore();
    if (c) await st.set(CRED_KEY, c);
    else await st.delete(CRED_KEY);
    await st.save();
    return true;
  } catch {
    return false;
  }
}
