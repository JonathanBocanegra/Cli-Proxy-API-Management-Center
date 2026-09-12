export type HostHealthStatus = 'healthy' | 'attention' | 'critical';

export type HostHealthIssue =
  'cpu' | 'load' | 'memory' | 'swap' | 'storage' | 'temperature' | 'zombies';

export type HostThermalStatus = HostHealthStatus | 'unavailable';

export interface HostTemperatureSensor {
  id: string;
  component: 'cpu' | 'gpu' | 'mainboard';
  deviceName: string;
  valueCelsius: number;
  minimumCelsius: number;
  maximumCelsius: number;
  warningCelsius: number;
  criticalCelsius: number;
  status: HostHealthStatus;
  peakStatus: HostHealthStatus;
}

export interface HostThermalMetrics {
  available: boolean;
  stale: boolean;
  sampledAt: string | null;
  source: string | null;
  status: HostThermalStatus;
  peakStatus: HostThermalStatus;
  hottestCelsius: number | null;
  peakCelsius: number | null;
  sensors: HostTemperatureSensor[];
}

export interface HostIdentity {
  hostname: string;
  distro: string;
  kernel: string;
  isWsl: boolean;
  wslVersion: string | null;
  uptimeSeconds: number;
  cpuModel: string;
  logicalCores: number;
  temperatureCelsius: number | null;
}

export interface HostCpuMetrics {
  usagePercent: number;
  ioWaitPercent: number;
  load1: number;
  load5: number;
  load15: number;
}

export interface HostMemoryMetrics {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  swapUsagePercent: number;
}

export interface HostDiskIoMetrics {
  readBytesPerSecond: number;
  writeBytesPerSecond: number;
  readOperationsPerSecond: number;
  writeOperationsPerSecond: number;
  busyPercent: number;
  devices: string[];
}

export interface HostNetworkInterface {
  name: string;
  receiveBytesPerSecond: number;
  transmitBytesPerSecond: number;
}

export interface HostNetworkMetrics {
  receiveBytesPerSecond: number;
  transmitBytesPerSecond: number;
  interfaces: HostNetworkInterface[];
}

export interface HostStorageMount {
  path: string;
  label: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
}

export interface HostProcess {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryBytes: number;
}

export interface HostProcessMetrics {
  total: number;
  running: number;
  zombies: number;
  topCpu: HostProcess[];
  topMemory: HostProcess[];
}

export type HostServiceStatus = 'active' | 'inactive' | 'failed' | 'unknown';

export interface HostService {
  id: string;
  label: string;
  status: HostServiceStatus;
}

export interface HostSnapshot {
  version: 1;
  sampledAt: string;
  intervalMs: number;
  health: {
    status: HostHealthStatus;
    issues: HostHealthIssue[];
  };
  host: HostIdentity;
  cpu: HostCpuMetrics;
  memory: HostMemoryMetrics;
  diskIo: HostDiskIoMetrics;
  network: HostNetworkMetrics;
  thermal: HostThermalMetrics;
  storage: HostStorageMount[];
  processes: HostProcessMetrics;
  services: HostService[];
}
