import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { checkPortStatus } from '@/lib/process-manager';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * POST /api/projects/[id]/apply-analysis
 * Applies a completed harness-agent analysis result to the project:
 * validates/sanitizes the LLM-generated config (same rules as the classic
 * analyze route) and upserts environments. The start itself is driven
 * client-side (it goes through the normal start API for progress UI and
 * pending-state handling), so there is no server-side autoStart flag here.
 *
 * Body: { analysis: {projectName, description, icon, environments[], summary} }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const analysis = body?.analysis;

    const project = await db.project.findUnique({
      where: { id },
      include: { environments: true },
    });
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    if (!analysis || !Array.isArray(analysis.environments)) {
      return NextResponse.json({ error: 'Invalid analysis payload' }, { status: 400 });
    }

    // ---- validation (mirrors the classic analyze route) ----
    const validatedEnvs: Array<{ name: string; cmd: string; port: number; envVars: Record<string, string> }> = [];
    const droppedEnvs: Array<{ name: string; reason: string }> = [];
    // LLM frequently prefixes commands with env-var assignments
    // (e.g. "NODE_ENV=production npm start"). Strip leading assignments before
    // the allowlist check so verified production configs are not silently dropped.
    const stripEnvPrefix = (cmd: string) => cmd.replace(/^([A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, '');
    const safeCmdPrefixes = ['npm', 'npx', 'yarn', 'pnpm', 'bun', 'python', 'python3', 'go', 'cargo', 'make', 'node', 'deno', 'flask', 'gunicorn', 'uvicorn', 'django', 'dotnet', 'php', 'ruby', 'rails', 'bundle', 'docker', 'sh', 'bash', './'];
    for (const env of analysis.environments) {
      const sanitizedName = String(env.name || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50);
      if (!sanitizedName) { droppedEnvs.push({ name: String(env.name || '(unnamed)'), reason: '无有效名称' }); continue; }
      const envPort = Number(env.port);
      if (!Number.isInteger(envPort) || envPort < 1 || envPort > 65535 || envPort === 3000) { droppedEnvs.push({ name: sanitizedName, reason: `端口 ${env.port} 无效或被保留` }); continue; }
      const cmdStr = String(env.cmd || '').trim();
      if (cmdStr.length > 500) { droppedEnvs.push({ name: sanitizedName, reason: '命令过长' }); continue; }
      const baseCmd = stripEnvPrefix(cmdStr);
      if (!safeCmdPrefixes.some(p => baseCmd.startsWith(p))) { droppedEnvs.push({ name: sanitizedName, reason: `命令未通过白名单校验: ${cmdStr.slice(0, 60)}` }); continue; }

      let envVarsObj: Record<string, string> = {};
      if (env.envVars && typeof env.envVars === 'object' && !Array.isArray(env.envVars)) {
        for (const [k, v] of Object.entries(env.envVars)) {
          if (typeof k === 'string' && typeof v === 'string') envVarsObj[k] = v;
        }
      }
      validatedEnvs.push({ name: sanitizedName, cmd: cmdStr, port: envPort, envVars: envVarsObj });
    }
    if (validatedEnvs.length === 0) {
      return NextResponse.json({ error: 'No valid environment configurations in the analysis result', dropped: droppedEnvs }, { status: 400 });
    }

    // Resolve port conflicts between environments.
    const usedPorts = new Set<number>();
    for (const env of validatedEnvs) {
      if (usedPorts.has(env.port)) {
        let p = env.port + 1;
        while (usedPorts.has(p) || p === 3000 || await checkPortStatus(p)) p++;
        env.port = p;
      }
      usedPorts.add(env.port);
    }

    // ---- project metadata: enrich, never overwrite ----
    // The user just typed a name (and possibly a description) in the Add Project
    // form — silently replacing it with the package.json-derived name from the
    // analysis is surprising. Only fill in fields the user left blank/default,
    // and surface the LLM's suggested name in the response for the UI to show.
    const suggestedName = String(analysis.projectName || '').slice(0, 100);
    const sanitizedDesc = String(project.description || analysis.description || '').slice(0, 500);
    const allowedIcons = ['folder', 'globe', 'code', 'database', 'smartphone', 'shopping-cart', 'layout', 'palette', 'cpu', 'book-open', 'music', 'gamepad-2', 'bar-chart', 'shield', 'camera', 'map', 'cloud', 'terminal', 'rocket', 'puzzle', 'package', 'zap', 'laptop', 'atom', 'flame', 'server'];
    const userIconIsDefault = !project.icon || project.icon === 'folder';
    const sanitizedIcon = userIconIsDefault && allowedIcons.includes(analysis.icon) ? analysis.icon : project.icon;

    await db.project.update({
      where: { id },
      data: { description: sanitizedDesc, icon: sanitizedIcon },
    });

    for (const env of validatedEnvs) {
      const existing = project.environments.find(e => e.name === env.name);
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

    // ---- production fallback synthesis ----
    // Guarantee a production environment exists for Node projects: when the
    // analysis result (or the project's existing envs) has no "production"
    // entry but package.json provides build+start scripts, synthesize one.
    try {
      const allEnvs = await db.environment.findMany({ where: { projectId: id } });
      const hasProduction = allEnvs.some(e => e.name === 'production');
      if (!hasProduction) {
        const pjPath = join(project.path, 'package.json');
        if (existsSync(pjPath)) {
          const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
          if (pj.scripts?.build && pj.scripts?.start) {
            const pm = existsSync(join(project.path, 'bun.lock')) || existsSync(join(project.path, 'bun.lockb')) ? 'bun' : 'npm';
            const usedPorts = new Set(allEnvs.map(e => e.port));
            const maxPort = allEnvs.length > 0 ? Math.max(...allEnvs.map(e => e.port)) : 4000;
            let prodPort = Math.max(maxPort + 1, 4000);
            while (usedPorts.has(prodPort) || prodPort === 3000 || await checkPortStatus(prodPort)) prodPort++;
            await db.environment.create({
              data: {
                projectId: id,
                name: 'production',
                cmd: `${pm} run build && ${pm} run start`,
                port: prodPort,
                envVars: JSON.stringify({ NODE_ENV: 'production', HOST: '0.0.0.0', PORT: String(prodPort) }),
              },
            });
          }
        }
      }
    } catch {
      // production synthesis is best-effort
    }

    const updatedProject = await db.project.findUnique({
      where: { id },
      include: { environments: true },
    });

    return NextResponse.json({
      project: updatedProject,
      applied: validatedEnvs.length,
      dropped: droppedEnvs,
      suggestedName,
      summary: analysis.summary || '',
    });
  } catch (e: any) {
    console.error('Apply-analysis error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
