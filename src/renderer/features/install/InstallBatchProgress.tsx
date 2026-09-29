import type { InstallJobDto } from '@shared/types/domain';
import { Button } from '@renderer/components/Button';
import { ProgressBar } from '@renderer/components/Feedback';
import { useInstallJobs } from '@renderer/query/hooks';
import { useState } from 'react';

interface InstallBatchProgressProps {
  jobs: InstallJobDto[];
  onClose: () => void;
}

export function InstallBatchProgress({ jobs, onClose }: InstallBatchProgressProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const liveJobs = useInstallJobs(1500);
  const current = jobs.map((job) => liveJobs.data?.find((row) => row.id === job.id) ?? job);
  const completed = current.filter((job) => job.status === 'completed').length;
  const failed = current.find((job) => job.status === 'failed' || job.status === 'cancelled');
  const allCompleted = completed === jobs.length;
  const mtp = jobs.some((job) => job.destinationType !== 'folder');
  const active = current.find((job) => job.status === 'running')
    ?? current.find((job) => job.status === 'pending');
  const failureReport = failed ? [
    `MTP transfer failed at ${new Date().toISOString()}`,
    `Error: ${failed.error?.code ?? 'UNKNOWN_ERROR'}: ${failed.error?.message ?? 'Transfer did not finish.'}`,
    `Destination: ${failed.destinationLabel ?? failed.destinationFolder}`,
    ...jobs.map((job) => `Source: ${job.sourcePath}`),
    `Details: ${JSON.stringify(failed.error?.details ?? {}, null, 2)}`,
  ].join('\n') : '';

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
    {failed ? <>
      <details>
        <summary>Failure log</summary>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflow: 'auto' }}>
          {failureReport}
        </pre>
      </details>
      <Button onClick={() => void navigator.clipboard.writeText(failureReport)
        .then(() => setCopied(true))
        .catch(() => setCopyError(true))}>
        {copied ? 'Copied error log' : 'Copy error log'}
      </Button>
      {copyError ? <span className="install-warning">Could not copy the error log.</span> : null}
    </> : null}
    {!allCompleted && !failed && mtp ? <p className="dim">Keep the Switch connected until the transfer finishes.</p> : null}
    {allCompleted && mtp ? <p className="install-batch__confirmed">
      All selected files finished transferring to the Switch.
    </p> : null}
    <div className="row row--wrap install-batch__footer">
      <Button onClick={onClose}>{allCompleted || failed ? 'Close' : 'Continue in background'}</Button>
    </div>
  </div>;
}
