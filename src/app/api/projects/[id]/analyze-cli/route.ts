import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { readProjectDir, checkPortStatus } from '@/lib/process-manager';
import { requireApprovedUser } from '@/lib/auth';
import { isAllowedCommand } from '@/lib/cmd-allowlist';
import { isUnsafeAnalysisPath, analysisGuardRejection } from '@/lib/self-guard';
import { logActivity } from '@/lib/activity';
import { runCliSession, extractJson } from '@/lib/llm-repair/cli-session';

/**
 * POST /api/projects/[id]/analyze-cli (v1.34 rewrite)
 *
 * Environment-analysis delegation to a local agent CLI — the 'cli' option
 * of analysisMode (LLM settings → 功能引擎 → 解析环境). The predecessor of
 * this route hard-coded `which claude` and was never wired to the UI; this
 * rewrite goes through the shared catalog (claude / codex / gemini / … /
 * custom:template — the SAME selection the repair engine uses) with the
 * generic cli-session runner.
 *
 * Contract (mirrors pull-cli so the frontend can treat both uniformly):
 *   200 { ok: true,  engine: 'cli', cli: {id,label}, project, analysis }
 *   200 { ok: false, error, fallbackReason }  — no usable CLI / spawn
 *        failure / unparseable output. The FRONTEND then falls back to the
 *        legacy single-call analyze route and toasts why. Status 200 on
 *        purpose: a delegation miss is an expected degradation, not an
 *        error the caller can't handle.
 *
 * Query: ?replace=true — wipe existing environments first (regenerate).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Analysis delegation budget. The agent CLI reads the tree, maybe runs a
 * detector command and writes the JSON block — 6 minutes is generous
 * without inviting an unattended hang (the repair engine allows 10). */
const ANALYSIS_CLI_TIMEOUT_MS = 6 * 60_000;

const TASK_FILE = '.dashboard-analysis-task.md';

const ALLOWED_ICONS = ['folder', 'globe', 'code', 'database', 'smartphone', 'shopping-cart', 'layout', 'palette', 'cpu', 'book-open', 'music', 'gamepad-2', 'bar-chart', 'shield', 'camera', 'map', 'cloud', 'terminal', 'rocket', 'puzzle', 'package', 'zap', 'laptop', 'atom', 'flame', 'server'];

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
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    // git must run on the machine that holds the code — same rule as the
    // agent pull; a remote project's tree is unreachable from here.
    if (project.deviceId) {
      return NextResponse.json({ ok: false, error: 'remote-project', fallbackReason: 'CLI 解析只能在本机项目上运行' }, { status: 200 });
    }

    // SELF-GUARD — never analyze the dashboard itself (see self-guard.ts).
    if (isUnsafeAnalysisPath(project.path)) {
      return NextResponse.json({ error: analysisGuardRejection(project.path) }, { status: 400 });
    }

    // ---- context package ----
    const dirInfo = await readProjectDir(project.path);
    if (!dirInfo.success) {
      return NextResponse.json({ ok: false, error: 'read-dir-failed', fallbackReason: `无法读取项目目录: ${dirInfo.error}` }, { status: 200 });
    }
    const configSummary = (dirInfo.configFile || [])
      .map((f) => `=== ${f.name} ===\n${f.content}`)
      .join('\n\n')
      .slice(0, 12_000);

    // Ports the CLI must avoid: live listeners + every env port already in
    // the DB + the dashboard's own ports (3000, mesh 3100-3105).
    const [dbEnvs, livePorts] = await Promise.all([
      db.environment.findMany({ select: { port: true } }),
      (async () => {
        const commonlyUsed = [3000, 3001, 3002, 4000, 5000, 5173, 5174, 8000, 8080, 8081, 8888, 9000];
        const inUse: number[] = [];
        for (const p of commonlyUsed) {
          if (await checkPortStatus(p)) inUse.push(p);
        }
        return inUse;
      })(),
    ]);
    const forbiddenPorts = Array.from(new Set<number>([
      ...dbEnvs.map((e) => e.port),
      ...livePorts,
      3000, 3100, 3101, 3102, 3103, 3104, 3105,
    ])).sort((a, b) => a - b);

    const taskContent = `# Analysis task: ${project.name}

## Mission
Analyze this project directory and produce startup configurations. You have full read/command access in this directory — work autonomously. Do NOT ask questions.

## Output contract (NON-NEGOTIABLE)
Your FINAL output must contain ONE fenced \`\`\`json block with EXACTLY this shape:
\`\`\`json
{
  "projectName": "string - a descriptive name",
  "description": "string - brief description",
  "icon": "one of: ${ALLOWED_ICONS.join(' | ')}",
  "environments": [
    { "name": "test", "cmd": "command to start in dev mode", "port": <number>, "envVars": { "KEY": "VALUE" } },
    { "name": "production", "cmd": "command to start in production mode", "port": <number>, "envVars": { "KEY": "VALUE" } }
  ]
}
\`\`\`
Rules:
1. test and production MUST use different ports.
2. NEVER assign any of these ports (in use or reserved): ${forbiddenPorts.join(', ') || 'none'}.
3. Use 'bun run …' when the project has bun.lock / bun.lockb; otherwise 'npm run …'.
4. envVars should carry at least NODE_ENV, HOST="0.0.0.0" and PORT (as strings).
5. Only facts from the tree — never invent scripts that don't exist.

## Environment facts
- Project root (your working directory): ${project.path}
- Platform: ${process.platform}${process.platform === 'win32' ? ' — the shell is cmd.exe; Unix commands do not exist. Use dir/type/tasklist or your own file tools.' : ''}
- Existing environments in the dashboard (regenerate in place, same names where sensible): ${project.environments.map((e) => `${e.name}(:${e.port})`).join(', ') || '(none)'}

## Key files
${configSummary || '(no config files found — inspect the tree before deciding)'}

Exit after printing the JSON block. The dashboard parses your final output; anything outside the block is discarded.
`;

    const session = await runCliSession({
      projectPath: project.path,
      taskFile: TASK_FILE,
      taskContent,
      timeoutMs: ANALYSIS_CLI_TIMEOUT_MS,
      tag: `analysis-${project.id.slice(0, 8)}`,
    });

    if (!session.cli) {
      logActivity({ type: 'system', level: 'warn', message: `CLI 解析回退：${project.name}`, projectId: project.id, projectName: project.name, detail: 'analysisMode=cli 但未检出可用的 Agent CLI' });
      return NextResponse.json({ ok: false, error: 'no-cli', fallbackReason: '未检出可用的本机 Agent CLI' }, { status: 200 });
    }
    if (!session.ok && !session.stdout.trim()) {
      return NextResponse.json({ ok: false, error: 'cli-run-failed', fallbackReason: session.error || `Agent CLI（${session.cli.label}）无法启动` }, { status: 200 });
    }

    const analysis = extractJson<{
      projectName?: string; description?: string; icon?: string;
      environments?: Array<{ name?: string; cmd?: string; port?: number; envVars?: Record<string, string> }>;
    }>(session.stdout);

    if (!analysis || !Array.isArray(analysis.environments) || analysis.environments.length === 0) {
      logActivity({ type: 'system', level: 'warn', message: `CLI 解析回退：${project.name}`, projectId: project.id, projectName: project.name, detail: `Agent CLI（${session.cli.label}）输出无法解析为 environments JSON` });
      return NextResponse.json({ ok: false, error: 'unparseable-output', fallbackReason: `Agent CLI（${session.cli.label}）输出未包含有效的 environments JSON` }, { status: 200 });
    }

    // ---- validation (same rules as the classic analyze routes) ----
    const validatedEnvs: Array<{ name: string; cmd: string; port: number; envVars: Record<string, string> }> = [];
    for (const env of analysis.environments) {
      const sanitizedName = String(env.name || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50);
      if (!sanitizedName) continue;
      const envPort = Number(env.port);
      if (!Number.isInteger(envPort) || envPort < 1 || envPort > 65535) continue;
      if (forbiddenPorts.includes(envPort)) continue;
      const cmdStr = String(env.cmd || '').trim();
      if (!isAllowedCommand(cmdStr) || cmdStr.length > 500) continue;
      const envVarsObj: Record<string, string> = {};
      if (env.envVars && typeof env.envVars === 'object' && !Array.isArray(env.envVars)) {
        for (const [key, value] of Object.entries(env.envVars)) {
          if (typeof key === 'string' && typeof value === 'string') envVarsObj[key] = value;
        }
      }
      validatedEnvs.push({ name: sanitizedName, cmd: cmdStr, port: envPort, envVars: envVarsObj });
    }
    if (validatedEnvs.length === 0) {
      logActivity({ type: 'system', level: 'warn', message: `CLI 解析回退：${project.name}`, projectId: project.id, projectName: project.name, detail: 'CLI 输出的 environments 全部未通过校验（端口/命令白名单）' });
      return NextResponse.json({ ok: false, error: 'no-valid-envs', fallbackReason: 'CLI 生成的环境配置未通过校验（端口/命令白名单）' }, { status: 200 });
    }

    // Intra-result port conflicts → bump.
    const usedPorts = new Set<number>(forbiddenPorts);
    for (const env of validatedEnvs) {
      if (usedPorts.has(env.port)) {
        let newPort = env.port + 1;
        while (usedPorts.has(newPort) || newPort === 3000 || (newPort >= 3100 && newPort <= 3105)) newPort++;
        env.port = newPort;
      }
      usedPorts.add(env.port);
    }

    if (replace && project.environments.length > 0) {
      await db.environment.deleteMany({ where: { projectId: id } });
      project.environments = [];
    }

    const sanitizedName = String(analysis.projectName || project.name).slice(0, 100);
    const sanitizedDesc = String(analysis.description || project.description).slice(0, 500);
    const sanitizedIcon = ALLOWED_ICONS.includes(String(analysis.icon)) ? String(analysis.icon) : project.icon;
    await db.project.update({ where: { id }, data: { name: sanitizedName, description: sanitizedDesc, icon: sanitizedIcon } });

    for (const env of validatedEnvs) {
      const existing = project.environments.find((e) => e.name === env.name);
      if (existing && !replace) {
        await db.environment.update({ where: { id: existing.id }, data: { cmd: env.cmd, port: env.port, envVars: JSON.stringify(env.envVars) } });
      } else {
        await db.environment.create({ data: { projectId: id, name: env.name, cmd: env.cmd, port: env.port, envVars: JSON.stringify(env.envVars) } });
      }
    }

    const updatedProject = await db.project.findUnique({ where: { id }, include: { environments: true } });

    logActivity({
      type: 'system',
      level: 'success',
      message: `CLI 解析完成：${project.name}（${session.cli.label}）`,
      projectId: project.id,
      projectName: project.name,
      detail: `${validatedEnvs.length} 个环境：${validatedEnvs.map((e) => `${e.name}(:${e.port})`).join(', ')}`.slice(0, 300),
    });

    return NextResponse.json({
      ok: true,
      engine: 'cli',
      cli: session.cli,
      project: updatedProject,
      analysis: {
        projectName: sanitizedName,
        description: sanitizedDesc,
        icon: sanitizedIcon,
        environments: validatedEnvs,
        provider: session.cli.label,
        summary: session.summary || '',
      },
    });
  } catch (e: any) {
    console.error('Analyze CLI error:', e);
    // Crash-proof: JSON, never Next's HTML 500 page.
    return NextResponse.json({ ok: false, error: 'route-crashed', fallbackReason: String(e?.message || e).slice(0, 300) }, { status: 200 });
  }
}
