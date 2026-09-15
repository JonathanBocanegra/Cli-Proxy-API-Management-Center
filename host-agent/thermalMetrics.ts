import type {
  HostHealthStatus,
  HostTemperatureSensor,
  HostThermalMetrics,
} from '../src/features/host/types';

interface TemperatureSensorInput {
  id: string;
  component: HostTemperatureSensor['component'];
  deviceName: string;
  valueCelsius: number;
  minimumCelsius?: number;
  maximumCelsius?: number;
  warningCelsius: number;
  criticalCelsius: number;
}

const round = (value: number): number => Math.round(value * 10) / 10;

export function temperatureStatus(
  valueCelsius: number,
  warningCelsius: number,
  criticalCelsius: number
): HostHealthStatus {
  if (valueCelsius >= criticalCelsius) return 'critical';
  if (valueCelsius >= warningCelsius) return 'attention';
  return 'healthy';
}

export function createTemperatureSensor(input: TemperatureSensorInput): HostTemperatureSensor {
  const valueCelsius = round(input.valueCelsius);
  const minimumCelsius = round(input.minimumCelsius ?? input.valueCelsius);
  const maximumCelsius = round(input.maximumCelsius ?? input.valueCelsius);
  return {
    ...input,
    valueCelsius,
    minimumCelsius,
    maximumCelsius,
    status: temperatureStatus(valueCelsius, input.warningCelsius, input.criticalCelsius),
    peakStatus: temperatureStatus(maximumCelsius, input.warningCelsius, input.criticalCelsius),
  };
}

export function thermalMetricsFromSensors(
  sensors: HostTemperatureSensor[],
  source: string,
  sampledAt = new Date().toISOString()
): HostThermalMetrics {
  const status = sensors.some((sensor) => sensor.status === 'critical')
    ? 'critical'
    : sensors.some((sensor) => sensor.status === 'attention')
      ? 'attention'
      : sensors.length > 0
        ? 'healthy'
        : 'unavailable';
  const peakStatus = sensors.some((sensor) => sensor.peakStatus === 'critical')
    ? 'critical'
    : sensors.some((sensor) => sensor.peakStatus === 'attention')
      ? 'attention'
      : sensors.length > 0
        ? 'healthy'
        : 'unavailable';

  return {
    available: sensors.length > 0,
    stale: false,
    sampledAt: sensors.length > 0 ? sampledAt : null,
    source: sensors.length > 0 ? source : null,
    status,
    peakStatus,
    hottestCelsius:
      sensors.length > 0 ? Math.max(...sensors.map((sensor) => sensor.valueCelsius)) : null,
    peakCelsius:
      sensors.length > 0 ? Math.max(...sensors.map((sensor) => sensor.maximumCelsius)) : null,
    sensors,
  };
}

export function mergeThermalExtrema(
  previous: HostThermalMetrics,
  next: HostThermalMetrics
): HostThermalMetrics {
  if (!next.available) return next;
  const previousById = new Map(previous.sensors.map((sensor) => [sensor.id, sensor]));
  const sensors = next.sensors.map((sensor) => {
    const prior = previousById.get(sensor.id);
    if (!prior) return sensor;
    return createTemperatureSensor({
      ...sensor,
      minimumCelsius: Math.min(prior.minimumCelsius, sensor.minimumCelsius),
      maximumCelsius: Math.max(prior.maximumCelsius, sensor.maximumCelsius),
    });
  });
  return thermalMetricsFromSensors(
    sensors,
    next.source ?? 'Host sensors',
    next.sampledAt ?? undefined
  );
}

export const unavailableThermalMetrics = (): HostThermalMetrics => ({
  available: false,
  stale: false,
  sampledAt: null,
  source: null,
  status: 'unavailable',
  peakStatus: 'unavailable',
  hottestCelsius: null,
  peakCelsius: null,
  sensors: [],
});
