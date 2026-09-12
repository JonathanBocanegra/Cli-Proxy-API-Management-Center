import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconRefreshCw } from '@/components/ui/icons';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useRevealGroup, useRevealOnScroll } from '@/hooks/motion';
import { TelemetryChart } from './components/TelemetryChart';
import { formatBytes, formatLoad, formatPercent, formatUptime } from './format';
import { useHostTelemetry } from './hooks/useHostTelemetry';
import type { HostHealthIssue, HostHealthStatus, HostProcess } from './types';
import styles from './HostPage.module.scss';

const STATUS_COLORS: Record<HostHealthStatus, string> = {
  healthy: 'var(--viz-success)',
  attention: 'var(--amber-color)',
  critical: 'var(--viz-failure)',
};

const DASH = '—';

function ResourceMeter({ value, label }: { value: number; label: string }) {
  const tone = value >= 90 ? 'critical' : value >= 75 ? 'attention' : 'healthy';
  return (
    <div
      className={styles.meter}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      style={{ '--meter-value': `${Math.max(0, Math.min(100, value))}%` } as React.CSSProperties}
      data-tone={tone}
    >
      <span />
    </div>
  );
}

function ProcessTable({ rows, metric }: { rows: HostProcess[]; metric: 'cpu' | 'memory' }) {
  const { t } = useTranslation();
  return (
    <div className={styles.processTable} role="table">
      <div className={styles.processHeader} role="row">
        <span role="columnheader">{t('host.process')}</span>
        <span role="columnheader">PID</span>
        <span role="columnheader">{metric === 'cpu' ? 'CPU' : t('host.memory')}</span>
      </div>
      {rows.map((process) => (
        <div className={styles.processRow} role="row" key={`${metric}-${process.pid}`}>
          <span role="cell" title={process.name}>
            {process.name}
          </span>
          <span role="cell">{process.pid}</span>
          <span role="cell">
            {metric === 'cpu'
              ? formatPercent(process.cpuPercent)
              : formatBytes(process.memoryBytes)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function HostPage() {
  const { t, i18n } = useTranslation();
  const { snapshot, history, loading, refreshing, error, refresh } = useHostTelemetry();
  useHeaderRefresh(refresh, true);
  const heroRef = useRevealGroup<HTMLElement>();
  const statsRef = useRevealGroup<HTMLElement>(0.1);
  const ioRef = useRevealOnScroll<HTMLElement>();
  const detailsRef = useRevealGroup<HTMLElement>();

  const health = snapshot?.health.status ?? 'attention';
  const healthColor = STATUS_COLORS[health];
  const rootStorage = snapshot?.storage.find((mount) => mount.path === '/') ?? snapshot?.storage[0];
  const hostMeta = snapshot
    ? [
        snapshot.host.isWsl ? `WSL${snapshot.host.wslVersion ?? ''}` : t('host.linux'),
        snapshot.host.distro,
        t('host.cores', { count: snapshot.host.logicalCores }),
      ].join(' · ')
    : t('host.waiting');
  const issues = snapshot?.health.issues ?? [];
  const issueText = issues.length
    ? issues.map((issue: HostHealthIssue) => t(`host.issue_${issue}`)).join(' · ')
    : t('host.no_issues');
  const sampledAt = snapshot
    ? new Intl.DateTimeFormat(i18n.language, {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      }).format(new Date(snapshot.sampledAt))
    : DASH;

  const diskSeries = useMemo(
    () => [
      {
        label: t('host.read'),
        color: 'var(--host-accent)',
        values: history.map((point) => point.diskRead),
      },
      {
        label: t('host.write'),
        color: 'var(--host-violet)',
        values: history.map((point) => point.diskWrite),
      },
    ],
    [history, t]
  );
  const networkSeries = useMemo(
    () => [
      {
        label: t('host.receive'),
        color: 'var(--viz-success)',
        values: history.map((point) => point.networkReceive),
      },
      {
        label: t('host.transmit'),
        color: 'var(--amber-color)',
        values: history.map((point) => point.networkTransmit),
      },
    ],
    [history, t]
  );

  if (!snapshot && !loading) {
    return (
      <div className={styles.page}>
        <section className={styles.unavailable}>
          <span className={styles.eyebrow}>{t('host.eyebrow')}</span>
          <h1>{t('host.unavailable_title')}</h1>
          <p>{t('host.unavailable_description')}</p>
          {error ? <code>{error}</code> : null}
          <Button onClick={() => void refresh()} loading={refreshing}>
            {t('common.refresh')}
          </Button>
        </section>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.ambient} aria-hidden="true">
        <span className={styles.orbOne} />
        <span className={styles.orbTwo} />
        <span className={styles.grid} />
      </div>

      <section className={styles.hero} ref={heroRef}>
        <div className={styles.heroCopy} data-reveal>
          <span className={styles.eyebrow}>{t('host.eyebrow')}</span>
          <h1 className={styles.heroTitle}>
            {snapshot
              ? t(`host.verdict_${health}`, { hostname: snapshot.host.hostname })
              : t('host.connecting')}
            <span style={{ color: healthColor }}>.</span>
          </h1>
          <p className={styles.heroMeta}>{hostMeta}</p>
          <div className={styles.healthLine}>
            <span className={styles.healthDot} style={{ color: healthColor }} />
            <span>{issueText}</span>
            <span aria-hidden="true">·</span>
            <span>{t('host.updated', { time: sampledAt })}</span>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void refresh()} loading={refreshing}>
            <IconRefreshCw size={15} />
            {t('host.refresh_now')}
          </Button>
        </div>

        <div className={styles.heroDial} data-reveal="scale">
          <div
            className={styles.dial}
            style={
              {
                '--dial-value': `${snapshot?.cpu.usagePercent ?? 0}%`,
                '--dial-color': healthColor,
              } as React.CSSProperties
            }
          >
            <div className={styles.dialInner}>
              <strong>{snapshot ? formatPercent(snapshot.cpu.usagePercent) : DASH}</strong>
              <span>{t('host.cpu_now')}</span>
            </div>
          </div>
          <div className={styles.dialFooter}>
            <span>{t('host.uptime')}</span>
            <strong>{snapshot ? formatUptime(snapshot.host.uptimeSeconds) : DASH}</strong>
          </div>
        </div>
      </section>

      {error && snapshot ? <div className={styles.staleBanner}>{t('host.stale_data')}</div> : null}

      <section className={styles.statsGrid} ref={statsRef} aria-label={t('host.resource_health')}>
        <article className={styles.statCard} data-reveal>
          <span>{t('host.cpu')}</span>
          <strong>{snapshot ? formatPercent(snapshot.cpu.usagePercent) : DASH}</strong>
          <ResourceMeter value={snapshot?.cpu.usagePercent ?? 0} label={t('host.cpu')} />
          <small>
            {t('host.iowait', { value: formatPercent(snapshot?.cpu.ioWaitPercent ?? 0) })}
          </small>
        </article>
        <article className={styles.statCard} data-reveal>
          <span>{t('host.memory')}</span>
          <strong>{snapshot ? formatPercent(snapshot.memory.usagePercent) : DASH}</strong>
          <ResourceMeter value={snapshot?.memory.usagePercent ?? 0} label={t('host.memory')} />
          <small>
            {snapshot
              ? t('host.memory_detail', {
                  used: formatBytes(snapshot.memory.usedBytes),
                  total: formatBytes(snapshot.memory.totalBytes),
                })
              : DASH}
          </small>
        </article>
        <article className={styles.statCard} data-reveal>
          <span>{t('host.wsl_disk')}</span>
          <strong>{rootStorage ? formatPercent(rootStorage.usagePercent) : DASH}</strong>
          <ResourceMeter value={rootStorage?.usagePercent ?? 0} label={t('host.wsl_disk')} />
          <small>
            {rootStorage
              ? t('host.disk_free', { value: formatBytes(rootStorage.availableBytes) })
              : DASH}
          </small>
        </article>
        <article className={styles.statCard} data-reveal>
          <span>{t('host.load')}</span>
          <strong>{snapshot ? formatLoad(snapshot.cpu.load1) : DASH}</strong>
          <div className={styles.loadTriplet}>
            <span>{snapshot ? formatLoad(snapshot.cpu.load1) : DASH}</span>
            <span>{snapshot ? formatLoad(snapshot.cpu.load5) : DASH}</span>
            <span>{snapshot ? formatLoad(snapshot.cpu.load15) : DASH}</span>
          </div>
          <small>{t('host.load_windows')}</small>
        </article>
      </section>

      <section className={styles.section} ref={ioRef}>
        <header className={styles.sectionHead}>
          <span className={styles.eyebrow}>{t('host.io_eyebrow')}</span>
          <h2>{t('host.io_title')}</h2>
          <p>{t('host.io_description')}</p>
        </header>
        <div className={styles.ioGrid}>
          <article className={styles.panel}>
            <div className={styles.panelHead}>
              <div>
                <span>{t('host.disk_io')}</span>
                <h3>{snapshot?.diskIo.devices.join(' · ') || DASH}</h3>
              </div>
              <div className={styles.livePill}>
                <i />
                {t('host.live')}
              </div>
            </div>
            <div className={styles.dualFigures}>
              <div>
                <span>{t('host.read')}</span>
                <strong>
                  {formatBytes(snapshot?.diskIo.readBytesPerSecond ?? 0, { rate: true })}
                </strong>
              </div>
              <div>
                <span>{t('host.write')}</span>
                <strong>
                  {formatBytes(snapshot?.diskIo.writeBytesPerSecond ?? 0, { rate: true })}
                </strong>
              </div>
            </div>
            <TelemetryChart series={diskSeries} ariaLabel={t('host.disk_chart')} />
            <div className={styles.microStats}>
              <span>
                {t('host.read_iops', { value: snapshot?.diskIo.readOperationsPerSecond ?? 0 })}
              </span>
              <span>
                {t('host.write_iops', { value: snapshot?.diskIo.writeOperationsPerSecond ?? 0 })}
              </span>
              <span>
                {t('host.busy', { value: formatPercent(snapshot?.diskIo.busyPercent ?? 0) })}
              </span>
            </div>
          </article>

          <article className={styles.panel}>
            <div className={styles.panelHead}>
              <div>
                <span>{t('host.network')}</span>
                <h3>{t('host.all_interfaces')}</h3>
              </div>
              <div className={styles.livePill}>
                <i />
                {t('host.live')}
              </div>
            </div>
            <div className={styles.dualFigures}>
              <div>
                <span>{t('host.receive')}</span>
                <strong>
                  {formatBytes(snapshot?.network.receiveBytesPerSecond ?? 0, { rate: true })}
                </strong>
              </div>
              <div>
                <span>{t('host.transmit')}</span>
                <strong>
                  {formatBytes(snapshot?.network.transmitBytesPerSecond ?? 0, { rate: true })}
                </strong>
              </div>
            </div>
            <TelemetryChart series={networkSeries} ariaLabel={t('host.network_chart')} />
            <div className={styles.interfaceList}>
              {(snapshot?.network.interfaces ?? []).map((entry) => (
                <span key={entry.name}>
                  <b>{entry.name}</b>↓ {formatBytes(entry.receiveBytesPerSecond, { rate: true })}↑{' '}
                  {formatBytes(entry.transmitBytesPerSecond, { rate: true })}
                </span>
              ))}
            </div>
          </article>
        </div>
      </section>

      <section className={styles.detailGrid} ref={detailsRef}>
        <article className={styles.panel} data-reveal>
          <div className={styles.panelHead}>
            <div>
              <span>{t('host.storage')}</span>
              <h3>{t('host.mounts')}</h3>
            </div>
          </div>
          <div className={styles.mountList}>
            {(snapshot?.storage ?? []).map((mount) => (
              <div className={styles.mountRow} key={mount.path}>
                <div>
                  <strong>{mount.label}</strong>
                  <code>{mount.path}</code>
                </div>
                <div className={styles.mountValue}>
                  <span>
                    {formatBytes(mount.usedBytes)} / {formatBytes(mount.totalBytes)}
                  </span>
                  <ResourceMeter value={mount.usagePercent} label={mount.label} />
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className={styles.panel} data-reveal>
          <div className={styles.panelHead}>
            <div>
              <span>{t('host.services')}</span>
              <h3>{t('host.core_services')}</h3>
            </div>
            <small>
              {snapshot?.services.filter((service) => service.status === 'active').length ?? 0}/
              {snapshot?.services.length ?? 0}
            </small>
          </div>
          <div className={styles.serviceList}>
            {(snapshot?.services ?? []).map((service) => (
              <div className={styles.serviceRow} key={service.id}>
                <span className={styles.serviceDot} data-status={service.status} />
                <strong>{service.label}</strong>
                <span>{t(`host.service_${service.status}`)}</span>
              </div>
            ))}
          </div>
          <div className={styles.processSummary}>
            <div>
              <strong>{snapshot?.processes.total ?? DASH}</strong>
              <span>{t('host.processes')}</span>
            </div>
            <div>
              <strong>{snapshot?.processes.running ?? DASH}</strong>
              <span>{t('host.running')}</span>
            </div>
            <div>
              <strong>{snapshot?.processes.zombies ?? DASH}</strong>
              <span>{t('host.zombies')}</span>
            </div>
          </div>
        </article>

        <article className={`${styles.panel} ${styles.processPanel}`} data-reveal>
          <div className={styles.panelHead}>
            <div>
              <span>{t('host.processes')}</span>
              <h3>{t('host.top_cpu')}</h3>
            </div>
          </div>
          <ProcessTable rows={snapshot?.processes.topCpu ?? []} metric="cpu" />
        </article>

        <article className={`${styles.panel} ${styles.processPanel}`} data-reveal>
          <div className={styles.panelHead}>
            <div>
              <span>{t('host.processes')}</span>
              <h3>{t('host.top_memory')}</h3>
            </div>
          </div>
          <ProcessTable rows={snapshot?.processes.topMemory ?? []} metric="memory" />
        </article>
      </section>

      <footer className={styles.facts}>
        <span>
          <b>{t('host.kernel')}</b>
          {snapshot?.host.kernel || DASH}
        </span>
        <span>
          <b>{t('host.processor')}</b>
          {snapshot?.host.cpuModel || DASH}
        </span>
        <span>
          <b>{t('host.swap')}</b>
          {snapshot ? formatPercent(snapshot.memory.swapUsagePercent) : DASH}
        </span>
        <span>
          <b>{t('host.temperature')}</b>
          {snapshot?.host.temperatureCelsius
            ? `${snapshot.host.temperatureCelsius.toFixed(1)} °C`
            : t('host.not_exposed')}
        </span>
      </footer>
    </div>
  );
}
