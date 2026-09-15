import { execFile } from 'node:child_process';
import { access, readFile, readdir, statfs } from 'node:fs/promises';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import type {
  HostCpuMetrics,
  HostDiskIoMetrics,
  HostHealthIssue,
  HostHealthStatus,
  HostMemoryMetrics,
  HostNetworkInterface,
  HostNetworkMetrics,
  HostProcess,
  HostProcessMetrics,
  HostService,
  HostServiceStatus,
  HostSnapshot,
  HostStorageMount,
} from '../src/features/host/types';
import { readLinuxThermals } from './linuxThermals';
import { mergeThermalExtrema, unavailableThermalMetrics } from './thermalMetrics';
import { readWindowsThermals } from './windowsThermals';

const execFileAsync = promisify(execFile);
const KIBIBYTE = 1024;
const SECTOR_BYTES = 512;
const PAGE_BYTES = 4096;
const SERVICE_CACHE_MS = 15_000;
const STATIC_CACHE_MS = 60_000;
const THERMAL_CACHE_MS = 10_000;
const EXCLUDED_BLOCK_PREFIXES = ['loop', 'ram', 'zram', 'fd', 'sr'];

export interface CpuCounters {
  total: number;
  idle: number;
  ioWait: number;
}

export interface DiskCounters {
  readSectors: number;
  writtenSectors: number;
  readOperations: number;
  writeOperations: number;
  ioMilliseconds: number;
  devices: string[];
}

export interface NetworkCounters {
  interfaces: Record<string, { receiveBytes: number; transmitBytes: number }>;
}

interface ProcessCounters {
  pid: number;
  name: string;
  state: string;
  cpuTicks: number;
  memoryBytes: number;
}

interface StaticHostInfo {
  distro: string;
  kernel: string;
  isWsl: boolean;
  wslVersion: string | null;
  cpuModel: string;
  logicalCores: number;
}

const clampPercent = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;

const round = (value: number, digits = 1): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const deltaRate = (current: number, previous: number, seconds: number): number =>
  seconds > 0 ? Math.max(0, current - previous) / seconds : 0;

const safeRead = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
};

export function parseCpuCounters(procStat: string): CpuCounters {
  const line = procStat.split('\n').find((entry) => entry.startsWith('cpu '));
  if (!line) return { total: 0, idle: 0, ioWait: 0 };

  const values = line.trim().split(/\s+/).slice(1).map(Number);
  const total = values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  const idle = (values[3] ?? 0) + (values[4] ?? 0);
  return { total, idle, ioWait: values[4] ?? 0 };
}

export function cpuMetricsFromCounters(
  current: CpuCounters,
  previous: CpuCounters | null,
  loads: [number, number, number]
): HostCpuMetrics {
  if (!previous) {
    return {
      usagePercent: 0,
      ioWaitPercent: 0,
      load1: loads[0],
      load5: loads[1],
      load15: loads[2],
    };
  }

  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  const ioWaitDelta = current.ioWait - previous.ioWait;
  return {
    usagePercent: round(clampPercent((1 - idleDelta / Math.max(1, totalDelta)) * 100)),
    ioWaitPercent: round(clampPercent((ioWaitDelta / Math.max(1, totalDelta)) * 100)),
    load1: loads[0],
    load5: loads[1],
    load15: loads[2],
  };
}

export function parseMemoryMetrics(meminfo: string): HostMemoryMetrics {
  const values = new Map<string, number>();
  meminfo.split('\n').forEach((line) => {
    const match = line.match(/^([^:]+):\s+(\d+)/);
    if (match) values.set(match[1], Number(match[2]) * KIBIBYTE);
  });

  const totalBytes = values.get('MemTotal') ?? 0;
  const availableBytes = values.get('MemAvailable') ?? values.get('MemFree') ?? 0;
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const swapTotalBytes = values.get('SwapTotal') ?? 0;
  const swapFreeBytes = values.get('SwapFree') ?? 0;
  const swapUsedBytes = Math.max(0, swapTotalBytes - swapFreeBytes);

  return {
    totalBytes,
    usedBytes,
    availableBytes,
    usagePercent: round(clampPercent((usedBytes / Math.max(1, totalBytes)) * 100)),
    swapTotalBytes,
    swapUsedBytes,
    swapUsagePercent:
      swapTotalBytes > 0 ? round(clampPercent((swapUsedBytes / swapTotalBytes) * 100)) : 0,
  };
}

export function parseDiskCounters(procDiskstats: string, devices: Set<string>): DiskCounters {
  const counters: DiskCounters = {
    readSectors: 0,
    writtenSectors: 0,
    readOperations: 0,
    writeOperations: 0,
    ioMilliseconds: 0,
    devices: [],
  };

  procDiskstats.split('\n').forEach((line) => {
    const fields = line.trim().split(/\s+/);
    const name = fields[2];
    if (!name || !devices.has(name)) return;
    counters.devices.push(name);
    counters.readOperations += Number(fields[3]) || 0;
    counters.readSectors += Number(fields[5]) || 0;
    counters.writeOperations += Number(fields[7]) || 0;
    counters.writtenSectors += Number(fields[9]) || 0;
    counters.ioMilliseconds += Number(fields[12]) || 0;
  });

  counters.devices.sort();
  return counters;
}

export function diskMetricsFromCounters(
  current: DiskCounters,
  previous: DiskCounters | null,
  intervalSeconds: number
): HostDiskIoMetrics {
  if (!previous) {
    return {
      readBytesPerSecond: 0,
      writeBytesPerSecond: 0,
      readOperationsPerSecond: 0,
      writeOperationsPerSecond: 0,
      busyPercent: 0,
      devices: current.devices,
    };
  }

  return {
    readBytesPerSecond: Math.round(
      deltaRate(current.readSectors, previous.readSectors, intervalSeconds) * SECTOR_BYTES
    ),
    writeBytesPerSecond: Math.round(
      deltaRate(current.writtenSectors, previous.writtenSectors, intervalSeconds) * SECTOR_BYTES
    ),
    readOperationsPerSecond: round(
      deltaRate(current.readOperations, previous.readOperations, intervalSeconds)
    ),
    writeOperationsPerSecond: round(
      deltaRate(current.writeOperations, previous.writeOperations, intervalSeconds)
    ),
    busyPercent: round(
      clampPercent(deltaRate(current.ioMilliseconds, previous.ioMilliseconds, intervalSeconds) / 10)
    ),
    devices: current.devices,
  };
}

export function parseNetworkCounters(procNetDev: string): NetworkCounters {
  const interfaces: NetworkCounters['interfaces'] = {};
  procNetDev
    .split('\n')
    .slice(2)
    .forEach((line) => {
      const separator = line.indexOf(':');
      if (separator === -1) return;
      const name = line.slice(0, separator).trim();
      if (!name || name === 'lo') return;
      const values = line
        .slice(separator + 1)
        .trim()
        .split(/\s+/)
        .map(Number);
      interfaces[name] = {
        receiveBytes: values[0] ?? 0,
        transmitBytes: values[8] ?? 0,
      };
    });
  return { interfaces };
}

export function networkMetricsFromCounters(
  current: NetworkCounters,
  previous: NetworkCounters | null,
  intervalSeconds: number
): HostNetworkMetrics {
  const interfaces: HostNetworkInterface[] = Object.entries(current.interfaces)
    .map(([name, counters]) => {
      const old = previous?.interfaces[name];
      return {
        name,
        receiveBytesPerSecond: old
          ? Math.round(deltaRate(counters.receiveBytes, old.receiveBytes, intervalSeconds))
          : 0,
        transmitBytesPerSecond: old
          ? Math.round(deltaRate(counters.transmitBytes, old.transmitBytes, intervalSeconds))
          : 0,
      };
    })
    .sort(
      (a, b) =>
        b.receiveBytesPerSecond +
          b.transmitBytesPerSecond -
          (a.receiveBytesPerSecond + a.transmitBytesPerSecond) || a.name.localeCompare(b.name)
    );

  return {
    receiveBytesPerSecond: interfaces.reduce((sum, entry) => sum + entry.receiveBytesPerSecond, 0),
    transmitBytesPerSecond: interfaces.reduce(
      (sum, entry) => sum + entry.transmitBytesPerSecond,
      0
    ),
    interfaces,
  };
}

export function classifyHostHealth(input: {
  cpu: HostCpuMetrics;
  memory: HostMemoryMetrics;
  storage: HostStorageMount[];
  processes: Pick<HostProcessMetrics, 'zombies'>;
  logicalCores: number;
  thermal?: Pick<HostSnapshot['thermal'], 'status'>;
}): { status: HostHealthStatus; issues: HostHealthIssue[] } {
  const critical = new Set<HostHealthIssue>();
  const attention = new Set<HostHealthIssue>();
  const loadPerCore = input.cpu.load1 / Math.max(1, input.logicalCores);

  if (input.cpu.usagePercent >= 95) critical.add('cpu');
  else if (input.cpu.usagePercent >= 80) attention.add('cpu');

  if (loadPerCore >= 1.5) critical.add('load');
  else if (loadPerCore >= 1) attention.add('load');

  if (input.memory.usagePercent >= 95) critical.add('memory');
  else if (input.memory.usagePercent >= 85) attention.add('memory');

  if (input.memory.swapUsagePercent >= 80) attention.add('swap');

  const highestStorageUsage = Math.max(0, ...input.storage.map((mount) => mount.usagePercent));
  if (highestStorageUsage >= 95) critical.add('storage');
  else if (highestStorageUsage >= 85) attention.add('storage');

  if (input.thermal?.status === 'critical') critical.add('temperature');
  else if (input.thermal?.status === 'attention') attention.add('temperature');

  if (input.processes.zombies > 0) attention.add('zombies');

  const issues = [...critical, ...attention].filter(
    (issue, index, allIssues) => allIssues.indexOf(issue) === index
  );
  return {
    status: critical.size > 0 ? 'critical' : attention.size > 0 ? 'attention' : 'healthy',
    issues,
  };
}

async function discoverBlockDevices(): Promise<Set<string>> {
  const devices = new Set<string>();
  for (const name of await readdir('/sys/class/block')) {
    if (EXCLUDED_BLOCK_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    try {
      await access(`/sys/class/block/${name}/partition`);
    } catch {
      devices.add(name);
    }
  }
  return devices;
}

function parseLoadAverage(value: string): [number, number, number] {
  const fields = value.trim().split(/\s+/).slice(0, 3).map(Number);
  return [fields[0] || 0, fields[1] || 0, fields[2] || 0];
}

function parseProcessStat(value: string): ProcessCounters | null {
  const open = value.indexOf('(');
  const close = value.lastIndexOf(')');
  if (open <= 0 || close <= open) return null;

  const pid = Number(value.slice(0, open).trim());
  const name = value.slice(open + 1, close);
  const fields = value
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  if (!Number.isFinite(pid) || fields.length < 22) return null;
  return {
    pid,
    name,
    state: fields[0] ?? '',
    cpuTicks: (Number(fields[11]) || 0) + (Number(fields[12]) || 0),
    memoryBytes: Math.max(0, Number(fields[21]) || 0) * PAGE_BYTES,
  };
}

async function readProcesses(
  previous: Map<number, number>,
  cpuDelta: number,
  logicalCores: number
): Promise<{ metrics: HostProcessMetrics; counters: Map<number, number> }> {
  const entries = (await readdir('/proc')).filter((name) => /^\d+$/.test(name));
  const results = await Promise.all(
    entries.map(async (pid) => parseProcessStat(await safeRead(`/proc/${pid}/stat`)))
  );
  const processes = results.filter((entry): entry is ProcessCounters => entry !== null);
  const counters = new Map(processes.map((entry) => [entry.pid, entry.cpuTicks]));
  const enriched: HostProcess[] = processes.map((entry) => ({
    pid: entry.pid,
    name: entry.name,
    cpuPercent: round(
      clampPercent(
        ((entry.cpuTicks - (previous.get(entry.pid) ?? entry.cpuTicks)) / Math.max(1, cpuDelta)) *
          logicalCores *
          100
      )
    ),
    memoryBytes: entry.memoryBytes,
  }));

  return {
    counters,
    metrics: {
      total: processes.length,
      running: processes.filter((entry) => entry.state === 'R').length,
      zombies: processes.filter((entry) => entry.state === 'Z').length,
      topCpu: [...enriched]
        .sort((a, b) => b.cpuPercent - a.cpuPercent || b.memoryBytes - a.memoryBytes)
        .slice(0, 6),
      topMemory: [...enriched]
        .sort((a, b) => b.memoryBytes - a.memoryBytes || b.cpuPercent - a.cpuPercent)
        .slice(0, 6),
    },
  };
}

async function readStorageMount(
  mountPath: string,
  label: string
): Promise<HostStorageMount | null> {
  try {
    const info = await statfs(mountPath);
    const totalBytes = info.blocks * info.bsize;
    const availableBytes = info.bavail * info.bsize;
    const usedBytes = Math.max(0, (info.blocks - info.bfree) * info.bsize);
    return {
      path: mountPath,
      label,
      totalBytes,
      usedBytes,
      availableBytes,
      usagePercent: round(clampPercent((usedBytes / Math.max(1, totalBytes)) * 100)),
    };
  } catch {
    return null;
  }
}

async function readTemperature(): Promise<number | null> {
  try {
    const zones = (await readdir('/sys/class/thermal')).filter((name) =>
      name.startsWith('thermal_zone')
    );
    const temperatures = (
      await Promise.all(
        zones.map(async (zone) => Number(await safeRead(`/sys/class/thermal/${zone}/temp`)))
      )
    )
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => value / 1000);
    return temperatures.length > 0 ? round(Math.max(...temperatures)) : null;
  } catch {
    return null;
  }
}

async function readStaticHostInfo(): Promise<StaticHostInfo> {
  const [osRelease, kernel, version, cpuinfo] = await Promise.all([
    safeRead('/etc/os-release'),
    safeRead('/proc/sys/kernel/osrelease'),
    safeRead('/proc/version'),
    safeRead('/proc/cpuinfo'),
  ]);
  const prettyName = osRelease.match(/^PRETTY_NAME=(?:"([^"]+)"|(.+))$/m);
  const cpuModel = cpuinfo.match(/^model name\s*:\s*(.+)$/m);
  const logicalCores = Math.max(1, (cpuinfo.match(/^processor\s*:/gm) ?? []).length);
  const wslMatch = `${kernel} ${version}`.match(/microsoft-standard-WSL(\d)/i);
  const isWsl = /microsoft|wsl/i.test(`${kernel} ${version}`);

  return {
    distro: prettyName?.[1] ?? prettyName?.[2] ?? 'Linux',
    kernel: kernel.trim(),
    isWsl,
    wslVersion: wslMatch?.[1] ?? (isWsl ? '2' : null),
    cpuModel: cpuModel?.[1]?.trim() ?? 'Unknown CPU',
    logicalCores,
  };
}

async function serviceStatus(scope: 'system' | 'user', unit: string): Promise<HostServiceStatus> {
  const args = scope === 'user' ? ['--user', 'is-active', unit] : ['is-active', unit];
  try {
    const { stdout } = await execFileAsync('systemctl', args, { timeout: 1500 });
    const status = stdout.trim();
    if (status === 'active' || status === 'inactive' || status === 'failed') return status;
    return 'unknown';
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout?.trim();
    if (stdout === 'inactive' || stdout === 'failed') return stdout;
    return 'unknown';
  }
}

async function readServices(): Promise<HostService[]> {
  const definitions = [
    {
      id: 'cliproxyapi',
      label: 'CLI Proxy API',
      scope: 'user' as const,
      unit: 'cliproxyapi.service',
    },
    {
      id: 'host-telemetry',
      label: 'Host Telemetry',
      scope: 'user' as const,
      unit: 'cliproxy-host-agent.service',
    },
    { id: 't3-code', label: 'T3 Code', scope: 'user' as const, unit: 't3code-server.service' },
    { id: 'tailscale', label: 'Tailscale', scope: 'system' as const, unit: 'tailscaled.service' },
  ];
  return Promise.all(
    definitions.map(async ({ id, label, scope, unit }) => ({
      id,
      label,
      status: await serviceStatus(scope, unit),
    }))
  );
}

export class HostSampler {
  private previousCpu: CpuCounters | null = null;
  private previousDisk: DiskCounters | null = null;
  private previousNetwork: NetworkCounters | null = null;
  private previousProcesses = new Map<number, number>();
  private previousSampleAt = 0;
  private blockDevices: Set<string> | null = null;
  private staticInfo: StaticHostInfo | null = null;
  private staticInfoAt = 0;
  private services: HostService[] = [];
  private servicesAt = 0;
  private thermal = unavailableThermalMetrics();
  private thermalAt = 0;

  async sample(): Promise<HostSnapshot> {
    const sampleAt = Date.now();
    const intervalMs = this.previousSampleAt > 0 ? sampleAt - this.previousSampleAt : 0;
    const intervalSeconds = Math.max(0.001, intervalMs / 1000);
    const [procStat, meminfo, loadavg, uptime, diskstats, netdev] = await Promise.all([
      safeRead('/proc/stat'),
      safeRead('/proc/meminfo'),
      safeRead('/proc/loadavg'),
      safeRead('/proc/uptime'),
      safeRead('/proc/diskstats'),
      safeRead('/proc/net/dev'),
    ]);

    if (!this.blockDevices) this.blockDevices = await discoverBlockDevices();
    if (!this.staticInfo || sampleAt - this.staticInfoAt >= STATIC_CACHE_MS) {
      this.staticInfo = await readStaticHostInfo();
      this.staticInfoAt = sampleAt;
    }
    if (this.services.length === 0 || sampleAt - this.servicesAt >= SERVICE_CACHE_MS) {
      this.services = await readServices();
      this.servicesAt = sampleAt;
    }
    if (sampleAt - this.thermalAt >= THERMAL_CACHE_MS) {
      try {
        let nextThermal = await readLinuxThermals();
        if (!nextThermal.available && this.staticInfo.isWsl) {
          nextThermal = await readWindowsThermals();
        }
        this.thermal = nextThermal.available
          ? mergeThermalExtrema(this.thermal, nextThermal)
          : this.thermal.available
            ? { ...this.thermal, stale: true }
            : nextThermal;
      } catch {
        if (this.thermal.available) this.thermal = { ...this.thermal, stale: true };
      }
      this.thermalAt = sampleAt;
    }

    const currentCpu = parseCpuCounters(procStat);
    const currentDisk = parseDiskCounters(diskstats, this.blockDevices);
    const currentNetwork = parseNetworkCounters(netdev);
    const cpu = cpuMetricsFromCounters(currentCpu, this.previousCpu, parseLoadAverage(loadavg));
    const memory = parseMemoryMetrics(meminfo);
    const diskIo = diskMetricsFromCounters(currentDisk, this.previousDisk, intervalSeconds);
    const network = networkMetricsFromCounters(
      currentNetwork,
      this.previousNetwork,
      intervalSeconds
    );
    const processResult = await readProcesses(
      this.previousProcesses,
      currentCpu.total - (this.previousCpu?.total ?? currentCpu.total),
      this.staticInfo.logicalCores
    );
    const storage = (
      await Promise.all([
        readStorageMount('/', this.staticInfo.isWsl ? 'WSL filesystem' : 'System filesystem'),
        this.staticInfo.isWsl ? readStorageMount('/mnt/c', 'Windows C:') : null,
      ])
    ).filter((mount): mount is HostStorageMount => mount !== null);
    const health = classifyHostHealth({
      cpu,
      memory,
      storage,
      processes: processResult.metrics,
      logicalCores: this.staticInfo.logicalCores,
      thermal: this.thermal,
    });

    this.previousCpu = currentCpu;
    this.previousDisk = currentDisk;
    this.previousNetwork = currentNetwork;
    this.previousProcesses = processResult.counters;
    this.previousSampleAt = sampleAt;

    return {
      version: 1,
      sampledAt: new Date(sampleAt).toISOString(),
      intervalMs,
      health,
      host: {
        hostname: hostname(),
        ...this.staticInfo,
        uptimeSeconds: Number(uptime.split(/\s+/)[0]) || 0,
        temperatureCelsius: this.thermal.hottestCelsius ?? (await readTemperature()),
      },
      cpu,
      memory,
      diskIo,
      network,
      thermal: this.thermal,
      storage,
      processes: processResult.metrics,
      services: this.services,
    };
  }
}
