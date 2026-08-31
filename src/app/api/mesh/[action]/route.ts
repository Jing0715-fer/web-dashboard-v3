import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Device mesh pairing — simple device interconnection.
 *
 *   POST /api/mesh/pair          → create a pairing code for this dashboard
 *   GET  /api/mesh/pair          → current pending pairing info (code + one-liner)
 *   POST /api/mesh/register      → a remote agent registers itself with {code, name, ip, port, apiKey}
 *   GET  /api/mesh/local-agent   → auto-detect the agent running on THIS machine (for web-UI join)
 *   POST /api/mesh/join          → this dashboard joins another dashboard's mesh by entering
 *                                  {target, code} in the web UI (no CLI needed on this device)
 *
 * Two ways to join a mesh:
 *   A. CLI (agent-only devices):  node agent.js --pair http://<dashboard-host>:3000 --code <CODE>
 *   B. Web UI (devices running the full dashboard): 设备 → 加入网络 → 输入对方地址 + 验证码
 */

interface PendingPair {
  code: string;
  createdAt: number;
  expiresAt: number;
}

// In-memory pending pairing codes (5-minute validity, multi-device use).
const pendingPairs = new Map<string, PendingPair>();

// Simple in-memory rate limiter for register attempts (per client IP).
const registerAttempts = new Map<string, { count: number; resetAt: number }>();
const REGISTER_LIMIT = 12; // attempts per window
const REGISTER_WINDOW_MS = 60_000;

function registerRateLimited(clientIp: string): boolean {
  const now = Date.now();
  const entry = registerAttempts.get(clientIp);
  if (!entry || entry.resetAt < now) {
    registerAttempts.set(clientIp, { count: 1, resetAt: now + REGISTER_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > REGISTER_LIMIT;
}

// Agent service directories shipped with the project (platform variants).
const AGENT_DIRS = ['agent', 'agent-linux', 'agent-macos', 'agent-win', 'agent-windows'];

function hostFromReq(req: NextRequest): string {
  const url = new URL(req.url);
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host;
  return host;
}

function lanIp(): string {
  const ifaces = Object.values(os.networkInterfaces()).flat();
  const ipv4 = ifaces.find((i) => i && i.family === 'IPv4' && !i.internal);
  return ipv4?.address || '127.0.0.1';
}

interface LocalAgentInfo {
  port: number;
  apiKey: string;
  name: string;
  running: boolean;
  dir: string;
}

async function probeAgent(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Auto-detect the agent service on this machine.
 * Reads agent-config.json (written by the agent on startup) from each
 * mini-services/agent-* dir, prefers a live (health-probe OK) instance.
 */
async function detectLocalAgent(): Promise<LocalAgentInfo | null> {
  const root = process.cwd();
  const candidates: Array<Omit<LocalAgentInfo, 'running'>> = [];
  for (const dir of AGENT_DIRS) {
    const base = path.join(root, 'mini-services', dir);
    try {
      const cfg = JSON.parse(await fs.readFile(path.join(base, 'agent-config.json'), 'utf-8'));
      let port = Number(cfg.port) || 3100;
      // start.sh writes the actually-used port here (agent-config.json may
      // hold the default 3100 when a different port was picked).
      try {
        const envTxt = await fs.readFile(path.join(base, '.agent-session.env'), 'utf-8');
        const m = envTxt.match(/^AGENT_PORT=(\d+)\s*$/m);
        if (m) port = parseInt(m[1], 10);
      } catch { /* no session file */ }
      if (cfg.apiKey) {
        candidates.push({
          port,
          apiKey: String(cfg.apiKey),
          name: String(cfg.name || os.hostname()),
          dir,
        });
      }
    } catch { /* no config in this dir */ }
  }
  if (candidates.length === 0) return null;
  for (const c of candidates) {
    if (await probeAgent(c.port)) return { ...c, running: true };
  }
  return { ...candidates[0], running: false };
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const action = url.pathname.split('/').pop();

  try {
    if (action === 'pair') {
      // Invalidate ALL previous pending codes — only the newest code is
      // valid at any time (a fresh code supersedes older ones).
      pendingPairs.clear();
      // 8 hex chars (4 bytes) — harder to brute-force within the 5-minute
      // window than the previous 6-char code.
      const code = randomBytes(4).toString('hex').toUpperCase();
      const entry: PendingPair = {
        code,
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000,
      };
      pendingPairs.set(code, entry);
      const host = hostFromReq(req);
      const proto = req.headers.get('x-forwarded-proto') || (host.includes('localhost') || host.includes('127.0.0.1') ? 'http' : 'http');
      return NextResponse.json({
        code,
        expiresAt: entry.expiresAt,
        dashboardUrl: `${proto}://${host}`,
        command: `node agent.js --pair ${proto}://${host} --code ${code}`,
        curlCommand: `curl -X POST ${proto}://${host}/api/mesh/register -H 'Content-Type: application/json' -d '{"code":"${code}","name":"<device-name>","ip":"<device-ip>","port":3100,"apiKey":"<agent-api-key>"}'`,
      });
    }

    if (action === 'register') {
      const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
      if (registerRateLimited(clientIp)) {
        return NextResponse.json({ error: '尝试过于频繁，请稍后再试' }, { status: 429 });
      }
      const body = await req.json();
      const { code, name, ip, port, apiKey } = body || {};
      if (!code || !pendingPairs.has(String(code).toUpperCase())) {
        return NextResponse.json({ error: '无效或已过期的配对码' }, { status: 400 });
      }
      const entry = pendingPairs.get(String(code).toUpperCase())!;
      if (entry.expiresAt < Date.now()) {
        pendingPairs.delete(entry.code);
        return NextResponse.json({ error: '配对码已过期，请重新生成' }, { status: 400 });
      }
      if (!name || !ip || !port || !apiKey) {
        return NextResponse.json({ error: '缺少 name / ip / port / apiKey' }, { status: 400 });
      }

      const existing = await db.device.findFirst({ where: { ip: String(ip), port: Number(port) } });
      let device;
      if (existing) {
        device = await db.device.update({
          where: { id: existing.id },
          data: { name: String(name), apiKey: String(apiKey), status: 'online', lastSeen: new Date() },
        });
      } else {
        device = await db.device.create({
          data: {
            name: String(name),
            ip: String(ip),
            port: Number(port),
            apiKey: String(apiKey),
            status: 'online',
          },
        });
      }
      // The code stays valid until expiry so several devices can join with
      // the same code within the 5-minute window.

      return NextResponse.json({
        ok: true,
        deviceId: device.id,
        dashboard: { name: 'Dashboard', registered: true },
      });
    }

    if (action === 'join') {
      // This machine joins ANOTHER dashboard's mesh via the web UI.
      const body = await req.json().catch(() => ({}));
      const target = String(body?.target || '').trim().replace(/\/+$/, '');
      const code = String(body?.code || '').trim().toUpperCase();
      if (!target || !/^https?:\/\/.+/i.test(target)) {
        return NextResponse.json({ error: '请输入对方仪表盘地址（如 http://192.168.1.100:3000）' }, { status: 400 });
      }
      if (!code) {
        return NextResponse.json({ error: '请输入对方仪表盘显示的配对码' }, { status: 400 });
      }

      const detected = await detectLocalAgent();
      const port = Number(body?.agentPort) || detected?.port || 0;
      const apiKey = String(body?.agentApiKey || '') || detected?.apiKey || '';
      const name = String(body?.name || '') || detected?.name || os.hostname();
      if (!port || !apiKey) {
        return NextResponse.json(
          { error: '未检测到本机 Agent 的端口 / API Key — 请先启动 Agent，或在下方手动填写', agentDetected: false },
          { status: 400 },
        );
      }

      const ip = lanIp();
      try {
        const res = await fetch(`${target}/api/mesh/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, name, ip, port, apiKey }),
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          return NextResponse.json({ ok: true, deviceName: name, ip, port, target });
        }
        return NextResponse.json(
          { error: data?.error || `对方仪表盘返回 ${res.status}` },
          { status: 400 },
        );
      } catch (e: any) {
        return NextResponse.json(
          { error: `无法连接对方仪表盘：${e?.message || e} — 请检查地址与网络` },
          { status: 502 },
        );
      }
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 404 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const action = url.pathname.split('/').pop();
  if (action === 'pair') {
    for (const [k, v] of pendingPairs) {
      if (v.expiresAt < Date.now()) pendingPairs.delete(k);
    }
    const latest = [...pendingPairs.values()].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    return NextResponse.json({ pending: latest ? { code: latest.code, expiresAt: latest.expiresAt } : null });
  }
  if (action === 'local-agent') {
    const detected = await detectLocalAgent();
    return NextResponse.json({
      agent: detected,
      ip: lanIp(),
      hostname: os.hostname(),
    });
  }
  return NextResponse.json({ error: 'Unknown action' }, { status: 404 });
}
