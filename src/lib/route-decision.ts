import { db } from '@/lib/db';
import { proxyToAgent, type RemoteAgentConfig } from './remote-agent';

// Check if a project is a remote project
export function isRemoteProject(project: { deviceId: string | null }): boolean {
  return !!project.deviceId;
}

// Get the device config for a remote project (name included — the 401
// message below names the device so the user knows WHICH machine to fix).
export async function getDeviceConfig(deviceId: string): Promise<(RemoteAgentConfig & { name?: string }) | null> {
  const device = await db.device.findUnique({ where: { id: deviceId } });
  if (!device) return null;
  return { ip: device.ip, port: device.port, apiKey: device.apiKey, name: device.name };
}

// Proxy an action to the remote agent for a project
export async function proxyProjectAction(
  deviceId: string,
  actionPath: string,
  method: string = 'POST',
  body?: any
): Promise<{ ok: boolean; status: number; data: any }> {
  const config = await getDeviceConfig(deviceId);
  if (!config) {
    return { ok: false, status: 404, data: { error: 'Device not found' } };
  }
  const result = await proxyToAgent(config, actionPath, method, body);
  // 401 = the device agent's OWN key no longer matches the key this
  // dashboard holds (the device restarted its agent with a rotated key —
  // pre-persistence TS agents minted a fresh random key on every start, and
  // the heartbeat re-register refuses unknown keys). A bare "Unauthorized"
  // gives the user nothing to act on — translate it into the actual fix
  // (re-pair the device) and keep the original payload as `detail`.
  if (result.status === 401) {
    const deviceName = config.name || 'device';
    return {
      ...result,
      data: {
        error: `设备「${deviceName}」的 agent API 密钥不匹配（设备端 agent 重启后密钥已轮换）。请在设备页为该设备重新配对（生成配对码 → 设备端重新注册）后重试。/ Device agent rejected the dashboard key — re-pair the device and retry.`,
        detail: typeof result.data?.error === 'string' ? result.data.error : 'Unauthorized',
      },
    };
  }
  return result;
}
