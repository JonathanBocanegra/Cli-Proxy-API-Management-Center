import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HostTemperatureSensor, HostThermalMetrics } from '../src/features/host/types';
import { createTemperatureSensor, thermalMetricsFromSensors } from './thermalMetrics';

const execFileAsync = promisify(execFile);
const DEFAULT_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const PROCESSOR_DEVICE_CLASS = 4;
const DISPLAY_ADAPTER_DEVICE_CLASS = 32;
const MAINBOARD_DEVICE_CLASS = 1024;

const WINDOWS_THERMAL_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$script:RpcId = 0

function Read-Exactly([System.IO.Stream]$Stream, [int]$Length) {
  $buffer = [byte[]]::new($Length)
  $offset = 0
  while ($offset -lt $Length) {
    $count = $Stream.Read($buffer, $offset, $Length - $offset)
    if ($count -le 0) { throw "Corsair sensor pipe closed unexpectedly" }
    $offset += $count
  }
  return $buffer
}

function Invoke-CorsairRpc([System.IO.Stream]$Pipe, [string]$Method, [hashtable]$Params) {
  $script:RpcId += 1
  $request = @{
    jsonrpc = "2.0"
    id = $script:RpcId
    method = $Method
    params = $Params
  } | ConvertTo-Json -Compress
  $payload = [System.Text.Encoding]::UTF8.GetBytes($request)
  $length = [BitConverter]::GetBytes([uint32]$payload.Length)
  [Array]::Reverse($length)
  $Pipe.Write($length, 0, $length.Length)
  $Pipe.Write($payload, 0, $payload.Length)
  $Pipe.Flush()

  $responseLengthBytes = Read-Exactly $Pipe 4
  [Array]::Reverse($responseLengthBytes)
  $responseLength = [BitConverter]::ToUInt32($responseLengthBytes, 0)
  $responseBytes = Read-Exactly $Pipe $responseLength
  $response = [System.Text.Encoding]::UTF8.GetString($responseBytes) | ConvertFrom-Json
  if ($null -ne $response.error) { throw "Corsair sensor request failed" }
  return $response.result
}

$pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
  ".",
  "Corsair_iCUE_json_CpuId_Service",
  [System.IO.Pipes.PipeDirection]::InOut,
  [System.IO.Pipes.PipeOptions]::None
)
$pipe.Connect(1500)
try {
  $sensors = @()
  $deviceCount = [int](Invoke-CorsairRpc $pipe "get_number_of_devices" @{})
  for ($deviceIndex = 0; $deviceIndex -lt $deviceCount; $deviceIndex += 1) {
    $deviceName = [string](Invoke-CorsairRpc $pipe "get_device_name" @{ device_index = $deviceIndex })
    $deviceClass = [int](Invoke-CorsairRpc $pipe "get_device_class" @{ device_index = $deviceIndex })
    $sensorCount = [int](Invoke-CorsairRpc $pipe "get_number_of_sensors" @{
      device_index = $deviceIndex
      sensor_class = 8192
    })
    for ($sensorIndex = 0; $sensorIndex -lt $sensorCount; $sensorIndex += 1) {
      $sensor = Invoke-CorsairRpc $pipe "get_sensor_info" @{
        device_index = $deviceIndex
        sensor_class = 8192
        sensor_index = $sensorIndex
      }
      $sensors += [pscustomobject]@{
        deviceName = $deviceName
        deviceClass = $deviceClass
        sensorName = [string]$sensor.sensor_name
        valueCelsius = [double]$sensor.value
        minimumCelsius = [double]$sensor.min_value
        maximumCelsius = [double]$sensor.max_value
      }
    }
  }
  ConvertTo-Json -InputObject @($sensors) -Compress
} finally {
  $pipe.Dispose()
}
`;

export interface RawCorsairTemperature {
  deviceName: string;
  deviceClass: number;
  sensorName: string;
  valueCelsius: number;
  minimumCelsius: number;
  maximumCelsius: number;
}

const validTemperature = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= -20 && value <= 150;

export function parseCorsairThermalOutput(output: string): RawCorsairTemperature[] {
  const parsed: unknown = JSON.parse(output.trim());
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is RawCorsairTemperature => {
    if (!entry || typeof entry !== 'object') return false;
    const sensor = entry as Partial<RawCorsairTemperature>;
    return (
      typeof sensor.deviceName === 'string' &&
      typeof sensor.deviceClass === 'number' &&
      typeof sensor.sensorName === 'string' &&
      validTemperature(sensor.valueCelsius) &&
      validTemperature(sensor.minimumCelsius) &&
      validTemperature(sensor.maximumCelsius)
    );
  });
}

function toSensor(
  id: string,
  component: 'cpu' | 'gpu' | 'mainboard',
  reading: RawCorsairTemperature,
  warningCelsius: number,
  criticalCelsius: number
) {
  return createTemperatureSensor({
    id,
    component,
    deviceName: reading.deviceName,
    valueCelsius: reading.valueCelsius,
    minimumCelsius: reading.minimumCelsius,
    maximumCelsius: reading.maximumCelsius,
    warningCelsius,
    criticalCelsius,
  });
}

const hottest = (readings: RawCorsairTemperature[]): RawCorsairTemperature | undefined =>
  readings.reduce<RawCorsairTemperature | undefined>(
    (current, reading) =>
      !current || reading.valueCelsius > current.valueCelsius ? reading : current,
    undefined
  );

const aggregateHottestCore = (
  readings: RawCorsairTemperature[]
): RawCorsairTemperature | undefined => {
  const current = hottest(readings);
  if (!current) return undefined;
  return {
    ...current,
    sensorName: 'Cores (Max)',
    minimumCelsius: Math.min(...readings.map((reading) => reading.minimumCelsius)),
    maximumCelsius: Math.max(...readings.map((reading) => reading.maximumCelsius)),
  };
};

export function buildThermalMetrics(
  readings: RawCorsairTemperature[],
  sampledAt = new Date().toISOString()
): HostThermalMetrics {
  const sensors: HostTemperatureSensor[] = [];
  const cpuPackage = readings.find(
    (reading) => reading.deviceClass === PROCESSOR_DEVICE_CLASS && reading.sensorName === 'Package'
  );
  const hottestCore = aggregateHottestCore(
    readings.filter(
      (reading) =>
        reading.deviceClass === PROCESSOR_DEVICE_CLASS && /^Core #\d+$/.test(reading.sensorName)
    )
  );
  const gpuCore = readings.find(
    (reading) =>
      reading.deviceClass === DISPLAY_ADAPTER_DEVICE_CLASS && reading.sensorName === 'GPU'
  );
  const gpuHotspot = readings.find(
    (reading) =>
      reading.deviceClass === DISPLAY_ADAPTER_DEVICE_CLASS && reading.sensorName === 'Hot Spot'
  );
  const mainboard = readings.find(
    (reading) =>
      reading.deviceClass === MAINBOARD_DEVICE_CLASS && reading.sensorName === 'Mainboard'
  );

  if (cpuPackage) sensors.push(toSensor('cpu-package', 'cpu', cpuPackage, 80, 95));
  if (hottestCore) sensors.push(toSensor('cpu-core-max', 'cpu', hottestCore, 85, 95));
  if (gpuCore) sensors.push(toSensor('gpu-core', 'gpu', gpuCore, 80, 90));
  if (gpuHotspot) sensors.push(toSensor('gpu-hotspot', 'gpu', gpuHotspot, 90, 105));
  if (mainboard) sensors.push(toSensor('mainboard', 'mainboard', mainboard, 70, 85));

  return thermalMetricsFromSensors(sensors, 'Corsair iCUE / CPUID', sampledAt);
}

export async function readWindowsThermals(): Promise<HostThermalMetrics> {
  const powershell = process.env.HOST_AGENT_POWERSHELL || DEFAULT_POWERSHELL;
  const encodedCommand = Buffer.from(WINDOWS_THERMAL_SCRIPT, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
    { timeout: 5_000, maxBuffer: 256 * 1024, windowsHide: true }
  );
  return buildThermalMetrics(parseCorsairThermalOutput(stdout));
}
