import { db } from '@/lib/db';

interface DeviceInfo {
  id: string;
  name: string;
  ip: string;
  port: number;
  apiKey: string;
  status: 'online' | 'offline' | 'error';
  lastSeen: Date;
  projectCount?: number;
}

// In-memory cache
const deviceCache = new Map<string, DeviceInfo>();

// Load devices from DB into cache
export async function loadDevicesFromDB(): Promise<void> {
  const devices = await db.device.findMany({
    include: { _count: { select: { projects: true } } }
  });
  deviceCache.clear();
  for (const d of devices) {
    deviceCache.set(d.id, {
      id: d.id,
      name: d.name,
      ip: d.ip,
      port: d.port,
      apiKey: d.apiKey,
      status: d.status as DeviceInfo['status'],
      lastSeen: d.lastSeen,
      projectCount: d._count.projects,
    });
  }
}

// Get all cached devices
export function getCachedDevices(): DeviceInfo[] {
  return Array.from(deviceCache.values());
}

// Get single cached device
export function getCachedDevice(id: string): DeviceInfo | undefined {
  return deviceCache.get(id);
}

// Update device status in cache and DB
export async function updateDeviceStatus(id: string, status: 'online' | 'offline' | 'error'): Promise<void> {
  const device = deviceCache.get(id);
  if (device) {
    device.status = status;
    device.lastSeen = new Date();
  }
  await db.device.update({
    where: { id },
    data: { status, lastSeen: new Date() },
  }).catch(() => {}); // silently fail if device removed
}

// Check health of a single device
export async function checkDeviceHealth(device: DeviceInfo): Promise<boolean> {
  try {
    const res = await fetch(`http://${device.ip}:${device.port}/api/agent/health`, {
      headers: { 'Authorization': `Bearer ${device.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Check health of all devices
export async function checkAllDevicesHealth(): Promise<void> {
  const devices = getCachedDevices();
  await Promise.allSettled(
    devices.map(async (device) => {
      const isOnline = await checkDeviceHealth(device);
      await updateDeviceStatus(device.id, isOnline ? 'online' : 'offline');
    })
  );
}

// Start periodic health checker (returns stop function)
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;
export function startHealthChecker(intervalMs = 30000): () => void {
  // Initial check
  loadDevicesFromDB().then(() => checkAllDevicesHealth());

  healthCheckInterval = setInterval(async () => {
    await loadDevicesFromDB();
    await checkAllDevicesHealth();
  }, intervalMs);

  return () => {
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }
  };
}

// Invalidate cache (call after device CRUD)
export function invalidateCache(): void {
  loadDevicesFromDB();
}
