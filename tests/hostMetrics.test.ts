import { describe, expect, test } from 'bun:test';
import {
  classifyHostHealth,
  cpuMetricsFromCounters,
  diskMetricsFromCounters,
  networkMetricsFromCounters,
  parseCpuCounters,
  parseDiskCounters,
  parseMemoryMetrics,
  parseNetworkCounters,
} from '../host-agent/metrics';
import { buildThermalMetrics, parseCorsairThermalOutput } from '../host-agent/windowsThermals';

describe('host metrics parsing', () => {
  test('derives CPU use and iowait from consecutive aggregate counters', () => {
    const previous = parseCpuCounters('cpu  20 0 30 45 5 0 0 0 0 0');
    const current = parseCpuCounters('cpu  40 0 45 115 10 0 0 0 0 0');

    expect(cpuMetricsFromCounters(current, previous, [1.5, 1, 0.5])).toEqual({
      usagePercent: 31.8,
      ioWaitPercent: 4.5,
      load1: 1.5,
      load5: 1,
      load15: 0.5,
    });
  });

  test('uses available memory and reports swap separately', () => {
    const metrics = parseMemoryMetrics(
      [
        'MemTotal:       1000000 kB',
        'MemAvailable:    250000 kB',
        'SwapTotal:       500000 kB',
        'SwapFree:        400000 kB',
      ].join('\n')
    );

    expect(metrics.usagePercent).toBe(75);
    expect(metrics.swapUsagePercent).toBe(20);
    expect(metrics.usedBytes).toBe(750_000 * 1024);
  });

  test('turns disk and network counter deltas into per-second rates', () => {
    const diskPrevious = parseDiskCounters(
      '8 0 sda 10 0 100 0 20 0 200 0 0 100 0 0 0 0 0',
      new Set(['sda'])
    );
    const diskCurrent = parseDiskCounters(
      '8 0 sda 14 0 140 0 26 0 260 0 0 140 0 0 0 0 0',
      new Set(['sda'])
    );
    const disk = diskMetricsFromCounters(diskCurrent, diskPrevious, 2);

    expect(disk.readBytesPerSecond).toBe(10_240);
    expect(disk.writeBytesPerSecond).toBe(15_360);
    expect(disk.readOperationsPerSecond).toBe(2);
    expect(disk.writeOperationsPerSecond).toBe(3);
    expect(disk.busyPercent).toBe(2);

    const netPrevious = parseNetworkCounters(
      'Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n eth0: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0\n lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0'
    );
    const netCurrent = parseNetworkCounters(
      'Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n eth0: 5000 2 0 0 0 0 0 0 8000 2 0 0 0 0 0 0'
    );
    const network = networkMetricsFromCounters(netCurrent, netPrevious, 2);

    expect(network.receiveBytesPerSecond).toBe(2000);
    expect(network.transmitBytesPerSecond).toBe(3000);
    expect(network.interfaces.map((entry) => entry.name)).toEqual(['eth0']);
  });
});

describe('host health classification', () => {
  const base = {
    cpu: { usagePercent: 24, ioWaitPercent: 1, load1: 2, load5: 1, load15: 1 },
    memory: {
      totalBytes: 100,
      usedBytes: 50,
      availableBytes: 50,
      usagePercent: 50,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
      swapUsagePercent: 0,
    },
    storage: [
      {
        path: '/',
        label: 'WSL filesystem',
        totalBytes: 100,
        usedBytes: 40,
        availableBytes: 60,
        usagePercent: 40,
      },
    ],
    processes: { zombies: 0 },
    logicalCores: 8,
  };

  test('stays healthy below every resource threshold', () => {
    expect(classifyHostHealth(base)).toEqual({ status: 'healthy', issues: [] });
  });

  test('surfaces critical pressure without dropping lesser issues', () => {
    const result = classifyHostHealth({
      ...base,
      cpu: { ...base.cpu, usagePercent: 97 },
      memory: { ...base.memory, swapTotalBytes: 100, swapUsedBytes: 90, swapUsagePercent: 90 },
      processes: { zombies: 2 },
    });

    expect(result.status).toBe('critical');
    expect(result.issues).toEqual(['cpu', 'swap', 'zombies']);
  });

  test('promotes current thermal pressure into overall host health', () => {
    const result = classifyHostHealth({
      ...base,
      thermal: { status: 'critical' },
    });

    expect(result).toEqual({ status: 'critical', issues: ['temperature'] });
  });
});

describe('Windows thermal telemetry', () => {
  test('selects meaningful hardware sensors and retains aggregate CPU peaks', () => {
    const readings = parseCorsairThermalOutput(
      JSON.stringify([
        {
          deviceName: 'Intel Core i7 8700K',
          deviceClass: 4,
          sensorName: 'Package',
          valueCelsius: 82,
          minimumCelsius: 32,
          maximumCelsius: 100,
        },
        {
          deviceName: 'Intel Core i7 8700K',
          deviceClass: 4,
          sensorName: 'Core #0',
          valueCelsius: 84,
          minimumCelsius: 31,
          maximumCelsius: 96,
        },
        {
          deviceName: 'Intel Core i7 8700K',
          deviceClass: 4,
          sensorName: 'Core #1',
          valueCelsius: 87,
          minimumCelsius: 30,
          maximumCelsius: 99,
        },
        {
          deviceName: 'NVIDIA GeForce GTX 1080',
          deviceClass: 32,
          sensorName: 'GPU',
          valueCelsius: 38,
          minimumCelsius: 30,
          maximumCelsius: 70,
        },
        {
          deviceName: 'ASUS mainboard',
          deviceClass: 1024,
          sensorName: 'Mainboard',
          valueCelsius: 34,
          minimumCelsius: 29,
          maximumCelsius: 42,
        },
        {
          deviceName: 'Bad sensor',
          deviceClass: 4,
          sensorName: 'Package',
          valueCelsius: 999,
          minimumCelsius: 20,
          maximumCelsius: 999,
        },
      ])
    );
    const metrics = buildThermalMetrics(readings, '2026-09-12T00:00:00.000Z');

    expect(metrics.sensors.map((sensor) => sensor.id)).toEqual([
      'cpu-package',
      'cpu-core-max',
      'gpu-core',
      'mainboard',
    ]);
    expect(metrics.hottestCelsius).toBe(87);
    expect(metrics.sensors[1]).toMatchObject({
      valueCelsius: 87,
      minimumCelsius: 30,
      maximumCelsius: 99,
    });
    expect(metrics.status).toBe('attention');
    expect(metrics.peakStatus).toBe('critical');
  });
});
