import { proxyToAgent } from '@/lib/remote-agent';
import { invalidateRemoteProjectCache } from '@/lib/remote-sync';

/**
 * Shared "apply a remote auto-debug analysis result on the device" logic.
 *
 * Extracted from POST /api/mesh/apply-remote so the same code path serves
 * both the manual dialog button and the server-side auto-apply watcher
 * (src/lib/harness/auto-apply.ts) — remote analysis results are persisted on
 * the device even if the user closes the dialog before clicking "add".
 */

export interface RemoteApplyInput {
  device: { id?: string; ip: string; port: number; apiKey: string };
  path: string;
  name?: string;
  analysis: any;
  autoStart?: boolean;
}

export interface RemoteApplyOutcome {
  ok: boolean;
  /** device-side project id (null when creation failed) */
  projectId: string | null;
  started: boolean;
  environments: number;
  error?: string;
}

export async function applyRemoteAnalysis(input: RemoteApplyInput): Promise<RemoteApplyOutcome> {
  const { device, path: projectPath, name, analysis, autoStart } = input;
  const fail = (error: string): RemoteApplyOutcome => ({ ok: false, projectId: null, started: false, environments: 0, error });
  try {
    if (!device?.ip || !device?.port || !device?.apiKey) return fail('device config missing');
    if (!projectPath || !analysis?.environments?.length) return fail('path and analysis are required');
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
        return fail(createRes.data?.error || 'Failed to create project on device');
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
        return fail(startRes.data?.error || 'Failed to start remote environment');
      }
    }

    // A project/environments were created or updated on the agent — drop
    // the sync cache so the dashboard reflects them on the next list GET.
    invalidateRemoteProjectCache();

    return {
      ok: true,
      projectId,
      started: !!(autoStart && createdEnvId),
      environments: analysis.environments.length,
    };
  } catch (e: any) {
    return fail(String(e?.message || e));
  }
}
