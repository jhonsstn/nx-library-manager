import type { InstallJobDto } from '@shared/types/domain';
import { Button } from '@renderer/components/Button';
import { ProgressBar } from '@renderer/components/Feedback';
import { useInstallJobs } from '@renderer/query/hooks';

interface InstallBatchProgressProps {
  jobs: InstallJobDto[];
  onClose: () => void;
}

export function InstallBatchProgress({ jobs, onClose }: InstallBatchProgressProps) {
  const liveJobs = useInstallJobs(1500);
  const current = jobs.map((job) => liveJobs.data?.find((row) => row.id === job.id) ?? job);
  const completed = current.filter((job) => job.status === 'completed').length;
  const failed = current.find((job) => job.status === 'failed' || job.status === 'cancelled');
  const allCompleted = completed === jobs.length;
  const mtp = jobs.some((job) => job.destinationType !== 'folder');
  const active = current.find((job) => job.status === 'running')
    ?? current.find((job) => job.status === 'pending');

  const heading = failed ? 'Transfer stopped'
    : !allCompleted ? mtp ? `Transferring ${jobs.length} file${jobs.length === 1 ? '' : 's'} to Switch`
      : `${active?.status === 'running' ? 'Moving' : 'Preparing'} file ${completed + 1} of ${jobs.length}`
      : mtp ? 'Transfer successful' : 'All files moved';

  return <div className="install-batch" aria-live="polite">
    <strong>{heading}</strong>
    <ProgressBar value={completed} max={jobs.length} />
    <p className="dim">{completed} of {jobs.length} file{jobs.length === 1 ? '' : 's'} {mtp ? 'transferred' : 'moved'}</p>
    {active && !failed && !mtp ? <p className="install-batch__file" title={active.displayName}>
      {active.status === 'running' ? 'Current: ' : 'Next: '}{active.displayName}
    </p> : null}
    {failed ? <p className="install-warning">{failed.error?.message ?? 'Transfer did not finish.'}
      {' '}{mtp ? 'Some files may have transferred. Review the destination before retrying.'
        : 'Remaining files were not started.'}</p> : null}
    {!allCompleted && !failed && mtp ? <p className="dim">Keep the Switch connected until the transfer finishes.</p> : null}
    {allCompleted && mtp ? <p className="install-batch__confirmed">
      All selected files finished transferring to the Switch.
    </p> : null}
    <div className="row row--wrap install-batch__footer">
      <Button onClick={onClose}>{allCompleted || failed ? 'Close' : 'Continue in background'}</Button>
    </div>
  </div>;
}
