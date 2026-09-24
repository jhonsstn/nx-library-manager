import { useState } from 'react';
import { formatBytes } from '@shared/format/bytes';
import { displayFolder } from '@shared/format/install';
import type { InstallJobDto, InstallJobStatus } from '@shared/types/domain';
import { Button } from '@renderer/components/Button';
import { ProgressBar } from '@renderer/components/Feedback';
import { ConfirmDialog } from '@renderer/components/Modal';
import { useToast } from '@renderer/components/Toast';
import { useInstallJobs, useInstallMutations } from '@renderer/query/hooks';

const STATUS_LABELS: Record<InstallJobStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * Compact install queue (spec 13, Flow F step 9). Self-contained so the
 * unmatched page and the settings installation panel can both host it.
 */
export function InstallQueueTray() {
  const jobs = useInstallJobs();
  const { cancel, retryFailed, clearHistory } = useInstallMutations();
  const toast = useToast();
  const [confirmClear, setConfirmClear] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(25);
  const rows = jobs.data ?? [];
  const active = rows.filter((job) => job.status === 'pending' || job.status === 'running');
  const finished = rows.filter((job) => job.status !== 'pending' && job.status !== 'running');

  if (rows.length === 0) return null;

  const renderJob = (job: InstallJobDto) => <InstallJobRow
    key={job.id}
    job={job}
    busy={cancel.isPending || retryFailed.isPending || clearHistory.isPending}
    onCancel={() =>
      cancel.mutate(job.id, {
        onSuccess: () => toast.info('Install cancelled', job.displayName),
        onError: (error) => toast.error('Could not cancel the install', messageOf(error)),
      })
    }
    onRetry={() =>
      retryFailed.mutate(undefined, {
        onSuccess: (jobs) => jobs.length
          ? toast.success('Retrying failed files', `${jobs.length} file(s) queued.`)
          : toast.info('No files retried', 'Files may already be on the Switch or need a fresh install review.'),
        onError: (error) => toast.error('Could not retry the failed files', messageOf(error)),
      })
    }
  />;

  return (
    <section className="install-tray" aria-label="Install queue">
      <div className="install-tray__header">
        <h3 className="install-tray__title">Install queue</h3>
        {finished.length ? <Button onClick={() => setConfirmClear(true)} disabled={clearHistory.isPending}>
          Clear history
        </Button> : null}
      </div>
      {active.length ? <ul className="list">{active.map(renderJob)}</ul>
        : <p className="dim">No active installs.</p>}
      {finished.length ? <details className="install-tray__history"
        onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
        <summary>Finished history ({finished.length})</summary>
        {historyOpen ? <>
          <ul className="list">{finished.slice(0, historyLimit).map(renderJob)}</ul>
          {finished.length > historyLimit ? <Button onClick={() => setHistoryLimit((limit) => limit + 25)}>
            Show more
          </Button> : null}
        </> : null}
      </details> : null}
      {confirmClear ? <ConfirmDialog title="Clear install history"
        message={`Delete ${finished.length} finished install ${finished.length === 1 ? 'entry' : 'entries'}? Active installs stay queued. This also removes their “Last app transfer” records from game details.`}
        confirmLabel="Clear history" danger onCancel={() => setConfirmClear(false)}
        onConfirm={() => clearHistory.mutate(undefined, {
          onSuccess: (count) => {
            setConfirmClear(false);
            toast.success('Install history cleared', `${count} finished ${count === 1 ? 'entry' : 'entries'} removed.`);
          },
          onError: (error) => toast.error('Could not clear install history', messageOf(error)),
        })} /> : null}
    </section>
  );
}

interface InstallJobRowProps {
  job: InstallJobDto;
  busy: boolean;
  onCancel: () => void;
  onRetry: () => void;
}

function InstallJobRow({ job, busy, onCancel, onRetry }: InstallJobRowProps) {
  // MTP transfers report no byte-level progress, so a numeric bar would be a lie.
  const trackable = job.sizeBytes > 0 && job.destinationType === 'folder';
  const percent = trackable ? Math.min(100, Math.round((job.transferredBytes / job.sizeBytes) * 100)) : null;
  const destination = job.destinationLabel || displayFolder(job.destinationFolder, job.destinationLabel ?? '');
  const statusLabel = job.destinationType !== 'folder' && job.status === 'completed'
    ? 'Copy step finished' : job.destinationType !== 'folder' && job.status === 'running'
      ? 'Copying to Switch' : STATUS_LABELS[job.status];

  return (
    <li className="list__item list__item--static install-tray__row">
      <div className="install-tray__body">
        <div className="install-tray__head">
          <span className="list__title">{job.displayName}</span>
          <span className="list__meta">{job.destinationType === 'folder' ? 'Local folder' : destination}</span>
        </div>
        {percent === null ? (
          <span className={job.status === 'failed' ? 'badge badge--review' : 'badge'}>{statusLabel}</span>
        ) : (
          <>
            <ProgressBar value={job.transferredBytes} max={job.sizeBytes} />
            <span className="list__meta">
              {percent}% — {formatBytes(job.transferredBytes)} of {formatBytes(job.sizeBytes)}
            </span>
          </>
        )}
        {job.destinationType !== 'folder' && job.status === 'completed' ? <small className="dim">
          Check “On this Switch” to confirm DBI finished installing it.
        </small> : null}
        {job.error ? <p className="error-text">{job.error.message}</p> : null}
      </div>
      {job.status === 'pending' ? (
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      ) : null}
      {job.status === 'failed' ? (
        <Button onClick={onRetry} disabled={busy}>
          Retry failed
        </Button>
      ) : null}
    </li>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
