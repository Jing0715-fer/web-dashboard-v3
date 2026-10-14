export interface RemoteAgentConfig {
  ip: string;
  port: number;
  apiKey: string;
}

// Proxy a request to the remote agent
// `timeoutMs` defaults to 15s for control operations (start/stop/rebuild).
// Read-only list fetches should pass a much shorter timeout so one
// unreachable device cannot stall the dashboard's critical render path.
export async function proxyToAgent(
  config: RemoteAgentConfig,
  path: string,
  method: string = 'GET',
  body?: any,
  timeoutMs: number = 15000
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
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Read the raw body FIRST so a non-JSON agent response (an old agent's
    // HTML 404 page, a crashed agent route's HTML 500) is not silently turned
    // into `{}`: downstream routes return `result.data` verbatim, and an
    // empty object reaches the UI as "an error with no details" — which the
    // frontend then misdiagnoses as "the dashboard server is stale". A parse
    // failure (or a JSON body without an `error` field) on a failing status
    // now becomes a structured, actionable error naming the actual fix: the
    // agent process on that machine needs git pull + a RESTART — a running
    // agent cannot hot-reload pulled code.
    const text = await res.text().catch(() => '');
    let data: any = null;
    let nonJson = true;
    try {
      data = JSON.parse(text);
      nonJson = false;
    } catch {
      data = null;
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) data = {};
    if (!res.ok) {
      const existing = typeof (data as Record<string, unknown>)?.error === 'string'
        ? ((data as Record<string, unknown>).error as string).trim()
        : '';
      if (!existing) {
        data = {
          ...data,
          error:
            `Device agent at ${config.ip}:${config.port} failed (HTTP ${res.status}${nonJson ? ' — the response was not JSON' : ''}). ` +
            'The agent on that machine is most likely running older code than this dashboard — git pull cannot hot-reload a running agent process. ' +
            'On that machine: git pull the repo, then RESTART the agent, then retry here. ' +
            '/ 那台机器上的 agent 代码大概率比本面板旧（git pull 无法热加载运行中的 agent）—— 请在那台机器上执行 git pull 并重启 agent，然后在此重试。',
          detail: `${text || '(empty body)'}`.slice(0, 200).replace(/\s+/g, ' '),
        };
      }
    }
    return { ok: res.ok, status: res.status, data };
  } catch (error: any) {
    return { ok: false, status: 502, data: { error: `Agent unreachable: ${error.message}` } };
  }
}

// Fetch remote projects from an agent.
// `timeoutMs` defaults to 6s — listing projects is a cheap read on the agent;
// a healthy agent responds in well under a second, so anything still pending
// after a few seconds is an unreachable/hung host we should not wait for.
export async function fetchRemoteProjects(config: RemoteAgentConfig, timeoutMs: number = 6000): Promise<any[]> {
  const result = await proxyToAgent(config, '/projects', 'GET', undefined, timeoutMs);
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
