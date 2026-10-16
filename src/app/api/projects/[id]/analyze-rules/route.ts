import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readProjectDir, batchCheckPorts } from '@/lib/process-manager';
import { logActivity } from '@/lib/activity';
import { requireApprovedUser } from '@/lib/auth';
import { isAllowedCommand } from '@/lib/cmd-allowlist';
import { isUnsafeAnalysisPath, analysisGuardRejection } from '@/lib/self-guard';

/**
 * POST /api/projects/[id]/analyze-rules — STAGE 1 of the v1.36 analysis
 * cascade: a fully deterministic analyzer that consumes ZERO LLM tokens.
 *
 *   Stage ① (this route)  built-in rules: parse package.json / lockfile,
 *                         detect the framework, allocate conflict-free
 *                         ports, emit test + production environments.
 *   Stage ② (LLM fallback) only when the rules cannot confidently produce
 *                         environments — the caller then routes to the
 *                         configured intervention (built-in engine or a
 *                         delegated agent CLI).
 *
 * The route answers 200 { ok: true, project, analysis } when at least one
 * valid environment was generated (and persisted, honoring ?replace=true),
 * or 200 { ok: false, reason } when the rules bailed out — non-Node
 * projects, no package.json, no usable scripts. Callers MUST treat
 * ok:false as "escalate to LLM", never as a hard failure.
 */

interface RuleEnv {
  name: string;
  cmd: string;
  port: number;
  envVars: Record<string, string>;
}

// Ports the dashboard itself / the mesh agent lifecycle owns — the rule
// allocator must never hand these to a project (mirrors the usedPorts hint
// the harness branch sends).
const RESERVED_PORTS = [3000, 3100, 3101, 3102, 3103, 3104, 3105];

// Probed live (single batched `ss` call) on top of the reserved set.
const PROBE_PORTS = [3001, 3002, 3003, 3004, 3005, 4000, 5000, 5173, 5174, 8000, 8080, 8081, 8888, 9000];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authGuard = await requireApprovedUser(req);
  if (authGuard.error) return authGuard.error;
  try {
    const { id } = await params;
    const replace = req.nextUrl.searchParams.get('replace') === 'true';
    const project = await db.project.findUnique({
      where: { id },
      include: { environments: true },
    });
    if (!project) {
      return NextResponse.json({ ok: false, reason: 'Project not found' }, { status: 404 });
    }
    if (project.deviceId) {
      return NextResponse.json({
        ok: false,
        reason: 'Remote project — rules analysis only runs for local projects',
      });
    }
    // SELF-GUARD — never analyze the dashboard itself.
    if (isUnsafeAnalysisPath(project.path)) {
      return NextResponse.json({ ok: false, reason: analysisGuardRejection(project.path) });
    }

    // ---- deterministic project scan (no LLM anywhere below) ----
    const dirInfo = await readProjectDir(project.path);
    if (!dirInfo.success) {
      return NextResponse.json({ ok: false, reason: dirInfo.error || '无法读取项目目录' });
    }
    const pkg = dirInfo.packageJson;
    if (!pkg || typeof pkg !== 'object') {
      return NextResponse.json({ ok: false, reason: '未找到可解析的 package.json（内置规则仅支持 Node 项目）' });
    }
    const scripts: Record<string, string> =
      pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    const deps: Record<string, string> = {
      ...((pkg.dependencies as Record<string, string>) || {}),
      ...((pkg.devDependencies as Record<string, string>) || {}),
    };
    const files = (dirInfo.files || []).map((f) => f.replace(/\\/g, '/').split('/').pop() || '');
    const hasBun = files.includes('bun.lock') || files.includes('bun.lockb');
    const pm = hasBun ? 'bun' : 'npm';

    // ---- port allocation: DB envs (other projects) + live probe + reserved ----
    const taken = new Set<number>(RESERVED_PORTS);
    const otherEnvs = await db.environment.findMany({
      where: { projectId: { not: id } },
      select: { port: true },
    });
    for (const e of otherEnvs) taken.add(e.port);
    const live = await batchCheckPorts(PROBE_PORTS);
    for (const p of PROBE_PORTS) if (live.has(p)) taken.add(p);
    const nextFree = (start: number): number => {
      let p = Math.max(1024, Math.min(start, 65000));
      while (taken.has(p)) p++;
      taken.add(p); // claim immediately so sibling envs never collide
      return p;
    };

    // ---- framework detection + environment derivation ----
    const isNext = !!deps['next'] || /next(\s|$)/.test(`${scripts.dev || ''} ${scripts.start || ''} ${scripts.build || ''}`);
    const isVite = !!deps['vite'] || /vite/.test(`${scripts.dev || ''} ${scripts.preview || ''}`);
    const isNuxt = !!deps['nuxt'] || !!deps['nuxt-nightly'];

    const envs: RuleEnv[] = [];
    const mkEnv = (name: 'test' | 'production', cmd: string, port: number): void => {
      const cmdStr = String(cmd || '').trim();
      if (!cmdStr || cmdStr.length > 500) return;
      if (!isAllowedCommand(cmdStr)) return;
      envs.push({
        name,
        cmd: cmdStr,
        port,
        envVars: {
          NODE_ENV: name === 'test' ? 'development' : 'production',
          HOST: '0.0.0.0',
          PORT: String(port),
        },
      });
    };

    if (isNext || isNuxt) {
      // Next.js / Nuxt: dev server + build/start pair; both honor the PORT
      // env var, so no --port flag is needed.
      if (scripts.dev) {
        const prodPort = nextFree(3001);
        const testPort = nextFree(prodPort + 1);
        mkEnv('test', `${pm} run dev`, testPort);
        if (scripts.build && scripts.start) {
          mkEnv('production', `${pm} run build && ${pm} run start`, prodPort);
        }
      } else if (scripts.start) {
        const port = nextFree(3001);
        mkEnv('production', `${pm} run start`, port);
      }
    } else if (isVite) {
      // Vite ignores PORT env — the CLI --port flag is the reliable channel
      // (`npm run dev -- --port 5173` → `vite --port 5173`).
      if (scripts.dev) {
        const testPort = nextFree(5173);
        mkEnv('test', `${pm} run dev -- --port ${testPort}`, testPort);
      }
      if (scripts.build && scripts.preview) {
        const prodPort = nextFree(4173);
        mkEnv('production', `${pm} run build && ${pm} run preview -- --port ${prodPort}`, prodPort);
      }
    } else {
      // Generic Node project: a start script is the production entry; a dev
      // script (or NODE_ENV=development start) is the test entry.
      if (scripts.start) {
        const prodPort = nextFree(3001);
        mkEnv('production', `${pm} run start`, prodPort);
        if (scripts.dev) {
          mkEnv('test', `${pm} run dev`, nextFree(prodPort + 1));
        } else {
          mkEnv('test', `NODE_ENV=development ${pm} run start`, nextFree(prodPort + 1));
        }
      } else if (scripts.dev) {
        const port = nextFree(3001);
        mkEnv('test', `${pm} run dev`, port);
      }
    }

    // Dedupe by name (defensive — mkEnv only emits test/production once each)
    const seen = new Set<string>();
    const valid = envs.filter((e) => {
      if (seen.has(e.name) || !Number.isInteger(e.port) || e.port < 1 || e.port > 65535) return false;
      seen.add(e.name);
      return true;
    });

    if (valid.length === 0) {
      return NextResponse.json({
        ok: false,
        reason: 'package.json 中未找到可用的启动脚本（dev / start / build）',
      });
    }

    // ---- persist (only after full validation — a bail-out above must not
    //      have destroyed the user's existing environments) ----
    if (replace && project.environments.length > 0) {
      await db.environment.deleteMany({ where: { projectId: id } });
    }
    for (const env of valid) {
      const existing = replace
        ? undefined
        : project.environments.find((e) => e.name === env.name);
      if (existing) {
        await db.environment.update({
          where: { id: existing.id },
          data: { cmd: env.cmd, port: env.port, envVars: JSON.stringify(env.envVars) },
        });
      } else {
        await db.environment.create({
          data: {
            projectId: id,
            name: env.name,
            cmd: env.cmd,
            port: env.port,
            envVars: JSON.stringify(env.envVars),
          },
        });
      }
    }

    const updatedProject = await db.project.findUnique({
      where: { id },
      include: { environments: true },
    });

    logActivity({
      type: 'analyze',
      level: 'success',
      message: `规则解析完成（无 LLM）— ${valid.length} environments`,
      projectId: id,
      projectName: project.name,
      detail: `engine: rules, ${pm}, envs: ${valid.map((e) => `${e.name}(:${e.port})`).join(', ')}`,
    });

    return NextResponse.json({
      ok: true,
      project: updatedProject,
      analysis: { engine: 'rules', environments: valid },
    });
  } catch (e: any) {
    console.error('analyze-rules error:', e);
    return NextResponse.json(
      { ok: false, reason: e?.message || '规则解析异常' },
      { status: 500 }
    );
  }
}
