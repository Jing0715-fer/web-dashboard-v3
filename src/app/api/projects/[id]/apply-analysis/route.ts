import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { checkPortStatus } from '@/lib/process-manager';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * POST /api/projects/[id]/apply-analysis
 * Applies a completed harness-agent analysis result to the project:
 * validates/sanitizes the LLM-generated config (same rules as the classic
 * analyze route) and upserts environments. Optionally auto-starts the dev env.
 *
 * Body: { analysis: {projectName, description, icon, environments[], summary},
 *         autoStart?: boolean }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const analysis = body?.analysis;
    const autoStart = body?.autoStart === true;

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
    for (const env of analysis.environments) {
      const sanitizedName = String(env.name || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50);
      if (!sanitizedName) continue;
      const envPort = Number(env.port);
      if (!Number.isInteger(envPort) || envPort < 1 || envPort > 65535 || envPort === 3000) continue;
      const cmdStr = String(env.cmd || '').trim();
      const safeCmdPrefixes = ['npm', 'npx', 'yarn', 'pnpm', 'bun', 'python', 'python3', 'go', 'cargo', 'make', 'node', 'deno', 'flask', 'gunicorn', 'uvicorn', 'django', 'dotnet', 'php', 'ruby', 'rails', 'bundle', 'docker', 'sh', 'bash', './', 'PORT='];
      if (!safeCmdPrefixes.some(p => cmdStr.startsWith(p)) || cmdStr.length > 500) continue;

      let envVarsObj: Record<string, string> = {};
      if (env.envVars && typeof env.envVars === 'object' && !Array.isArray(env.envVars)) {
        for (const [k, v] of Object.entries(env.envVars)) {
          if (typeof k === 'string' && typeof v === 'string') envVarsObj[k] = v;
        }
      }
      validatedEnvs.push({ name: sanitizedName, cmd: cmdStr, port: envPort, envVars: envVarsObj });
    }
    if (validatedEnvs.length === 0) {
      return NextResponse.json({ error: 'No valid environment configurations in the analysis result' }, { status: 400 });
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

    const sanitizedName = String(analysis.projectName || project.name).slice(0, 100);
    const sanitizedDesc = String(analysis.description || project.description).slice(0, 500);
    const allowedIcons = ['folder', 'globe', 'code', 'database', 'smartphone', 'shopping-cart', 'layout', 'palette', 'cpu', 'book-open', 'music', 'gamepad-2', 'bar-chart', 'shield', 'camera', 'map', 'cloud', 'terminal', 'rocket', 'puzzle', 'package', 'zap', 'laptop', 'atom', 'flame', 'server'];
    const sanitizedIcon = allowedIcons.includes(analysis.icon) ? analysis.icon : project.icon;

    await db.project.update({
      where: { id },
      data: { name: sanitizedName, description: sanitizedDesc, icon: sanitizedIcon },
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
      summary: analysis.summary || '',
    });
  } catch (e: any) {
    console.error('Apply-analysis error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
