import { NextRequest, NextResponse } from 'next/server';
import { proxyToAgent } from '@/lib/remote-agent';

/**
 * POST /api/mesh/apply-remote
 * Applies a completed remote auto-debug analysis on the remote device:
 * creates (or updates) the project and its environments via the agent API,
 * optionally starts the verified dev environment, then the dashboard's
 * project sync mirrors it locally.
 *
 * Body: { device: {id, ip, port, apiKey}, path, name, analysis, autoStart }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { device, path: projectPath, name, analysis, autoStart } = body || {};
    if (!device?.ip || !device?.port || !device?.apiKey) {
      return NextResponse.json({ error: 'device config missing' }, { status: 400 });
    }
    if (!projectPath || !analysis?.environments?.length) {
      return NextResponse.json({ error: 'path and analysis are required' }, { status: 400 });
    }
    const cfg = { ip: device.ip, port: Number(device.port), apiKey: device.apiKey };

    // 1. Find or create the project on the device.
    const listRes = await proxyToAgent(cfg, '/projects', 'GET');
    const existing = (listRes.data?.projects ?? listRes.data ?? []).find(
      (p: any) => p.path === projectPath
    );

    let projectId: string;
    if (existing) {
      projectId = existing.id;
      await proxyToAgent(cfg, `/projects/${projectId}`, 'PUT', {
        name: analysis.projectName || name,
        description: analysis.description || '',
        icon: analysis.icon || 'server',
      });
    } else {
      const createRes = await proxyToAgent(cfg, '/projects', 'POST', {
        name: analysis.projectName || name || projectPath.split('/').pop(),
        path: projectPath,
        description: analysis.description || '',
        icon: analysis.icon || 'server',
      });
      if (!createRes.ok) {
        return NextResponse.json({ error: createRes.data?.error || 'Failed to create project on device' }, { status: 502 });
      }
      projectId = createRes.data?.project?.id;
    }

    // 2. Delete existing environments and create the analyzed ones.
    const detailRes = await proxyToAgent(cfg, `/projects/${projectId}`, 'GET');
    const currentEnvs = detailRes.data?.project?.environments ?? [];
    for (const env of currentEnvs) {
      await proxyToAgent(cfg, `/projects/${projectId}/environments/${env.id}`, 'DELETE');
    }
    let createdEnvId: string | null = null;
    for (const env of analysis.environments) {
      const envRes = await proxyToAgent(cfg, `/projects/${projectId}/environments`, 'POST', {
        name: String(env.name || 'dev'),
        cmd: String(env.cmd || ''),
        port: Number(env.port),
        envVars: env.envVars && typeof env.envVars === 'object' ? env.envVars : {},
      });
      if (envRes.ok && !createdEnvId) {
        createdEnvId = envRes.data?.environment?.id ?? envRes.data?.env?.id ?? null;
      }
    }

    // 3. Optionally start the verified dev environment on the device.
    if (autoStart && createdEnvId) {
      const startRes = await proxyToAgent(cfg, `/projects/${projectId}/environments/${createdEnvId}/start`, 'POST');
      if (!startRes.ok) {
        return NextResponse.json({ error: startRes.data?.error || 'Failed to start remote environment' }, { status: 502 });
      }
    }

    return NextResponse.json({
      ok: true,
      projectId,
      started: !!(autoStart && createdEnvId),
      environments: analysis.environments.length,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
