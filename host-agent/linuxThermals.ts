import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { HostTemperatureSensor, HostThermalMetrics } from '../src/features/host/types';
import {
  createTemperatureSensor,
  thermalMetricsFromSensors,
  unavailableThermalMetrics,
} from './thermalMetrics';

const execFileAsync = promisify(execFile);
const HWMON_ROOT = '/sys/class/hwmon';

export interface RawLinuxTemperature {
  chipName: string;
  deviceName: string;
  label: string;
  valueCelsius: number;
  warningCelsius?: number;
  criticalCelsius?: number;
}

const safeRead = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
};

const validTemperature = (value: number): boolean =>
  Number.isFinite(value) && value >= -20 && value <= 150;

const parseMillidegrees = (value: string): number | undefined => {
  const parsed = Number(value.trim()) / 1000;
  return validTemperature(parsed) ? parsed : undefined;
};

const hottest = (readings: RawLinuxTemperature[]): RawLinuxTemperature | undefined =>
  readings.reduce<RawLinuxTemperature | undefined>(
    (current, reading) =>
      !current || reading.valueCelsius > current.valueCelsius ? reading : current,
    undefined
  );

const aggregate = (
  readings: RawLinuxTemperature[],
  label: string
): RawLinuxTemperature | undefined => {
  const current = hottest(readings);
  if (!current) return undefined;
  return {
    ...current,
    label,
    warningCelsius: Math.min(
      ...readings.map((reading) => reading.warningCelsius ?? Number.POSITIVE_INFINITY)
    ),
    criticalCelsius: Math.min(
      ...readings.map((reading) => reading.criticalCelsius ?? Number.POSITIVE_INFINITY)
    ),
  };
};

const threshold = (value: number | undefined, fallback: number): number =>
  value !== undefined && validTemperature(value) && value >= 40 ? value : fallback;

const toSensor = (
  id: string,
  component: HostTemperatureSensor['component'],
  reading: RawLinuxTemperature,
  warningCelsius: number,
  criticalCelsius: number
): HostTemperatureSensor =>
  createTemperatureSensor({
    id,
    component,
    deviceName: reading.deviceName,
    valueCelsius: reading.valueCelsius,
    warningCelsius: threshold(reading.warningCelsius, warningCelsius),
    criticalCelsius: threshold(reading.criticalCelsius, criticalCelsius),
  });

export function parseNvidiaSmiOutput(output: string): RawLinuxTemperature[] {
  return output
    .trim()
    .split('\n')
    .map((line) => {
      const separator = line.lastIndexOf(',');
      if (separator === -1) return null;
      const deviceName = line.slice(0, separator).trim();
      const valueCelsius = Number(line.slice(separator + 1).trim());
      if (!deviceName || !validTemperature(valueCelsius)) return null;
      return {
        chipName: 'nvidia',
        deviceName,
        label: 'GPU',
        valueCelsius,
      } satisfies RawLinuxTemperature;
    })
    .filter((reading): reading is RawLinuxTemperature => reading !== null);
}

export function buildLinuxThermalMetrics(
  readings: RawLinuxTemperature[],
  sampledAt = new Date().toISOString()
): HostThermalMetrics {
  const sensors: HostTemperatureSensor[] = [];
  const cpuReadings = readings.filter((reading) =>
    /^(coretemp|k10temp|zenpower)$/i.test(reading.chipName)
  );
  const cpuPackage = hottest(
    cpuReadings.filter((reading) => /^(package id \d+|tdie|tctl)$/i.test(reading.label))
  );
  const hottestCore = aggregate(
    cpuReadings.filter((reading) => /^core #?\d+$/i.test(reading.label)),
    'Cores (Max)'
  );
  const gpuCore = hottest(
    readings.filter(
      (reading) =>
        reading.chipName === 'nvidia' ||
        (/^amdgpu$/i.test(reading.chipName) && /^(edge|gpu)$/i.test(reading.label))
    )
  );
  const gpuHotspot = hottest(
    readings.filter(
      (reading) =>
        /^amdgpu$/i.test(reading.chipName) && /^(junction|hot spot)$/i.test(reading.label)
    )
  );
  const nvme = hottest(
    readings.filter(
      (reading) => /^nvme$/i.test(reading.chipName) && /^composite$/i.test(reading.label)
    )
  );
  const mainboard = hottest(
    readings.filter(
      (reading) =>
        /^(asus|nct\w*|it87\w*|acpitz)$/i.test(reading.chipName) &&
        /(motherboard|mainboard|system|pch)/i.test(reading.label)
    )
  );

  if (cpuPackage) sensors.push(toSensor('cpu-package', 'cpu', cpuPackage, 80, 95));
  if (hottestCore) sensors.push(toSensor('cpu-core-max', 'cpu', hottestCore, 85, 95));
  if (gpuCore) sensors.push(toSensor('gpu-core', 'gpu', gpuCore, 80, 90));
  if (gpuHotspot) sensors.push(toSensor('gpu-hotspot', 'gpu', gpuHotspot, 90, 105));
  if (nvme) sensors.push(toSensor('nvme', 'storage', nvme, 70, 85));
  if (mainboard) sensors.push(toSensor('mainboard', 'mainboard', mainboard, 70, 85));

  const source = readings.some((reading) => reading.chipName === 'nvidia')
    ? 'Linux hwmon / NVIDIA NVML'
    : 'Linux hwmon';
  return thermalMetricsFromSensors(sensors, source, sampledAt);
}

async function readHwmonTemperatures(): Promise<RawLinuxTemperature[]> {
  let directories: string[];
  try {
    directories = await readdir(HWMON_ROOT);
  } catch {
    return [];
  }

  const chips = await Promise.all(
    directories.map(async (directory) => {
      const root = `${HWMON_ROOT}/${directory}`;
      const [chipNameRaw, modelRaw, entries] = await Promise.all([
        safeRead(`${root}/name`),
        safeRead(`${root}/device/model`),
        readdir(root).catch(() => []),
      ]);
      const chipName = chipNameRaw.trim();
      const deviceName = modelRaw.trim() || chipName;
      const indices = entries
        .map((entry) => entry.match(/^temp(\d+)_input$/)?.[1])
        .filter((index): index is string => index !== undefined);
      return Promise.all(
        indices.map(async (index): Promise<RawLinuxTemperature | null> => {
          const [valueRaw, labelRaw, warningRaw, criticalRaw] = await Promise.all([
            safeRead(`${root}/temp${index}_input`),
            safeRead(`${root}/temp${index}_label`),
            safeRead(`${root}/temp${index}_max`),
            safeRead(`${root}/temp${index}_crit`),
          ]);
          const valueCelsius = parseMillidegrees(valueRaw);
          if (valueCelsius === undefined) return null;
          return {
            chipName,
            deviceName,
            label: labelRaw.trim() || `Temperature ${index}`,
            valueCelsius,
            warningCelsius: parseMillidegrees(warningRaw),
            criticalCelsius: parseMillidegrees(criticalRaw),
          };
        })
      );
    })
  );
  return chips.flat(2).filter((reading): reading is RawLinuxTemperature => reading !== null);
}

async function readNvidiaTemperatures(): Promise<RawLinuxTemperature[]> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,temperature.gpu', '--format=csv,noheader,nounits'],
      { timeout: 3_000, maxBuffer: 64 * 1024 }
    );
    return parseNvidiaSmiOutput(stdout);
  } catch {
    return [];
  }
}

export async function readLinuxThermals(): Promise<HostThermalMetrics> {
  const readings = (await Promise.all([readHwmonTemperatures(), readNvidiaTemperatures()])).flat();
  return readings.length > 0 ? buildLinuxThermalMetrics(readings) : unavailableThermalMetrics();
}
