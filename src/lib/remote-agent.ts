export interface RemoteAgentConfig {
  ip: string;
  port: number;
  apiKey: string;
}

// Proxy a request to the remote agent
export async function proxyToAgent(
  config: RemoteAgentConfig,
  path: string,
  method: string = 'GET',
  body?: any
): Promise<{ ok: boolean; status: number; data: any }> {
  const url = `http://${config.ip}:${config.port}/api/agent${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000), // 15s timeout for operations
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (error: any) {
    return { ok: false, status: 502, data: { error: `Agent unreachable: ${error.message}` } };
  }
}

// Fetch remote projects from an agent
export async function fetchRemoteProjects(config: RemoteAgentConfig): Promise<any[]> {
  const result = await proxyToAgent(config, '/projects', 'GET');
  if (!result.ok) return [];
  return result.data.projects || [];
}

// Check agent health
export async function checkAgentHealth(config: RemoteAgentConfig): Promise<{ ok: boolean; data?: any }> {
  try {
    const res = await fetch(`http://${config.ip}:${config.port}/api/agent/health`, {
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      return { ok: true, data };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}
