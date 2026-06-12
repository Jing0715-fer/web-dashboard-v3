import { db } from '@/lib/db';
import { proxyToAgent, type RemoteAgentConfig } from './remote-agent';

// Check if a project is a remote project
export function isRemoteProject(project: { deviceId: string | null }): boolean {
  return !!project.deviceId;
}

// Get the device config for a remote project
export async function getDeviceConfig(deviceId: string): Promise<RemoteAgentConfig | null> {
  const device = await db.device.findUnique({ where: { id: deviceId } });
  if (!device) return null;
  return { ip: device.ip, port: device.port, apiKey: device.apiKey };
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
  return proxyToAgent(config, actionPath, method, body);
}
