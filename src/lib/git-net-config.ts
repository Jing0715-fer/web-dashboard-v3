import { db } from '@/lib/db';

/**
 * Git network configuration (dashboard v1.27).
 *
 * Users on links where github.com:443 is unstable (connection resets mid-TLS,
 * stalled transfers reaped at the timeout) need ONE knob that makes every
 * network git call go through their local proxy (clash / v2ray / corporate
 * gateway). The setting is admin-owned, stored in AppSetting 'git.network'
 * as {"proxy": "http://127.0.0.1:7890"}, with process env as a fallback for
 * headless deployments:
 *
 *   DASHBOARD_GIT_PROXY > HTTPS_PROXY > https_proxy
 *
 * Consumers wire it into a single git invocation via -c args (never written
 * to the repo's .git/config — the proxy URL may embed credentials):
 *
 *   const { proxy } = await getGitNetConfig();
 *   execGitNetwork([...gitProxyArgs(proxy), 'fetch', 'origin', '--prune'], …)
 */

export interface GitNetConfig {
  /** '' = no proxy configured — direct connections. */
  proxy: string;
  /** Where the effective proxy came from ('setting' | 'env' | null). */
  proxySource: 'setting' | 'env' | null;
}

const SETTING_KEY = 'git.network';

/** Shape check: http(s):// or socks5(h):// proxy URLs only. */
export function isValidProxyUrl(raw: string): boolean {
  const s = String(raw || '').trim();
  if (!s) return false;
  if (!/^(https?|socks5h?):\/\/[^/\s]+(\/\S*)?$/i.test(s)) return false;
  try {
    const u = new URL(s);
    return ['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol);
  } catch {
    return false;
  }
}

/** Strip credentials from a proxy URL for display (admin UI / logs). */
export function maskProxyUrl(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    return u.toString();
  } catch {
    return s.slice(0, 48);
  }
}

/** Read the effective git network config (AppSetting → env fallback). */
export async function getGitNetConfig(): Promise<GitNetConfig> {
  let proxy = '';
  let source: GitNetConfig['proxySource'] = null;
  try {
    const row = await db.appSetting.findUnique({ where: { key: SETTING_KEY } });
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      const p = String(parsed?.proxy || '').trim();
      if (p && isValidProxyUrl(p)) {
        proxy = p;
        source = 'setting';
      }
    }
  } catch { /* missing table / bad JSON → env fallback */ }
  if (!proxy) {
    const env = (process.env.DASHBOARD_GIT_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || '').trim();
    if (env && isValidProxyUrl(env)) {
      proxy = env;
      source = 'env';
    }
  }
  return { proxy, proxySource: source };
}

/** Persist (or clear, when proxy === '') the git proxy setting. */
export async function saveGitNetProxy(proxy: string): Promise<void> {
  const p = String(proxy || '').trim();
  if (p && !isValidProxyUrl(p)) {
    throw new Error('proxy must be an http(s):// or socks5:// URL');
  }
  await db.appSetting.upsert({
    where: { key: SETTING_KEY },
    update: { value: JSON.stringify({ proxy: p }) },
    create: { key: SETTING_KEY, value: JSON.stringify({ proxy: p }) },
  });
}

/**
 * Per-invocation git args that route the call through the proxy. Applied via
 * `git -c http.proxy=…` so nothing is persisted inside any repository.
 */
export function gitProxyArgs(proxy: string): string[] {
  const p = String(proxy || '').trim();
  return p ? ['-c', `http.proxy=${p}`] : [];
}
