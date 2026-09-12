export function formatBytes(value: number, options?: { rate?: boolean; digits?: number }): string {
  if (!Number.isFinite(value) || value <= 0) return options?.rate ? '0 B/s' : '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / 1024 ** index;
  const digits = options?.digits ?? (scaled >= 100 || index === 0 ? 0 : scaled >= 10 ? 1 : 2);
  return `${scaled.toFixed(digits)} ${units[index]}${options?.rate ? '/s' : ''}`;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export const formatPercent = (value: number): string => `${Math.round(value)}%`;

export const formatLoad = (value: number): string => value.toFixed(value >= 10 ? 1 : 2);
