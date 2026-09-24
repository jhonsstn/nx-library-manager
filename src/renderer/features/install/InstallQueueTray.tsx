import { formatBytes } from '@shared/format/bytes';
import { displayFolder } from '@shared/format/install';
import type { InstallJobDto, InstallJobStatus } from '@shared/types/domain';
import { Button } from '@renderer/components/Button';
import { ProgressBar } from '@renderer/components/Feedback';
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
  const { cancel, retryFailed } = useInstallMutations();
  const toast = useToast();
  const rows = jobs.data ?? [];

  if (rows.length === 0) return null;

  return (
    <section className="install-tray" aria-label="Install queue">
      <h3 className="install-tray__title">Install queue</h3>
      <ul className="list">
        {rows.map((job) => (
          <InstallJobRow
            key={job.id}
            job={job}
            busy={cancel.isPending || retryFailed.isPending}
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
          />
        ))}
      </ul>
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
  const trackable = job.sizeBytes > 0 && (job.destinationType === 'folder' || job.transferredBytes > 0);
  const percent = trackable ? Math.min(100, Math.round((job.transferredBytes / job.sizeBytes) * 100)) : null;
  const destination = job.destinationLabel || displayFolder(job.destinationFolder, job.destinationLabel ?? '');

  return (
    <li className="list__item list__item--static install-tray__row">
      <div className="install-tray__body">
        <div className="install-tray__head">
          <span className="list__title">{job.displayName}</span>
          <span className="list__meta">{job.destinationType === 'folder' ? 'Local folder' : destination}</span>
        </div>
        {percent === null ? (
          <span className={job.status === 'failed' ? 'badge badge--review' : 'badge'}>{STATUS_LABELS[job.status]}</span>
        ) : (
          <>
            <ProgressBar value={job.transferredBytes} max={job.sizeBytes} />
            <span className="list__meta">
              {percent}% — {formatBytes(job.transferredBytes)} of {formatBytes(job.sizeBytes)}
            </span>
          </>
        )}
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
