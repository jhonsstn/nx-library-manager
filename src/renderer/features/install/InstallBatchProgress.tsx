import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ContainedTitleDto, InstallJobDto, MtpInventoryDto } from '@shared/types/domain';
import { Button } from '@renderer/components/Button';
import { ProgressBar } from '@renderer/components/Feedback';
import { getCatalogApi } from '@renderer/api';
import { useInstallJobs } from '@renderer/query/hooks';
import { queryKeys } from '@renderer/query/keys';
import { verifyMtpBatch } from './install-batch-status';

interface InstallBatchProgressProps {
  jobs: InstallJobDto[];
  contents: ContainedTitleDto[];
  deviceId: string | null;
  before: MtpInventoryDto | null;
  onClose: () => void;
}

export function InstallBatchProgress({ jobs, contents, deviceId, before, onClose }: InstallBatchProgressProps) {
  const liveJobs = useInstallJobs(1500);
  const queryClient = useQueryClient();
  const [inventory, setInventory] = useState<MtpInventoryDto | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const checkingRef = useRef(false);
  const current = jobs.map((job) => liveJobs.data?.find((row) => row.id === job.id) ?? job);
  const completed = current.filter((job) => job.status === 'completed').length;
  const failed = current.find((job) => job.status === 'failed' || job.status === 'cancelled');
  const allCompleted = completed === jobs.length;
  const mtp = jobs.some((job) => job.destinationType !== 'folder');
  const paths = jobs.map((job) => job.sourcePath);
  const verification = inventory && mtp && allCompleted
    ? verifyMtpBatch(paths, contents, inventory, before, deviceId) : null;
  const active = current.find((job) => job.status === 'running')
    ?? current.find((job) => job.status === 'pending');

  useEffect(() => {
    if (!allCompleted || !mtp) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = async (attempt: number) => {
      if (checkingRef.current) return;
      checkingRef.current = true;
      setChecking(true);
      try {
        const result = await getCatalogApi().mtp.refreshInventory();
        if (cancelled) return;
        setInventory(result);
        setCheckError(null);
        queryClient.setQueryData(queryKeys.mtpInventory(), result);
        if (verifyMtpBatch(paths, contents, result, before, deviceId) !== 'waiting') return;
      } catch (error) {
        if (cancelled) return;
        setCheckError(error instanceof Error ? error.message : String(error));
      } finally {
        checkingRef.current = false;
        if (!cancelled) setChecking(false);
      }
      if (!cancelled && attempt < 6) timer = setTimeout(() => void check(attempt + 1), 10_000);
    };
    void check(1);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  // The batch identity is fixed after creation. A new batch mounts a new dialog.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allCompleted, mtp]);

  const refresh = async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const result = await getCatalogApi().mtp.refreshInventory();
      setInventory(result);
      setCheckError(null);
      queryClient.setQueryData(queryKeys.mtpInventory(), result);
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error));
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  };

  const heading = failed ? 'Transfer stopped'
    : !allCompleted ? `${active?.status === 'running' ? 'Copying' : 'Preparing'} file ${completed + 1} of ${jobs.length}`
      : !mtp ? 'All files moved'
        : verification === 'confirmed' ? 'Installed content confirmed on Switch'
          : checking ? 'Checking installed content on Switch'
            : 'Copy steps finished; installation not yet confirmed';

  return <div className="install-batch" aria-live="polite">
    <strong>{heading}</strong>
    <ProgressBar value={completed} max={jobs.length} />
    <p className="dim">{completed} of {jobs.length} file copy step{jobs.length === 1 ? '' : 's'} finished</p>
    {active && !failed ? <p className="install-batch__file" title={active.displayName}>
      {active.status === 'running' ? 'Current: ' : 'Next: '}{active.displayName}
    </p> : null}
    {failed ? <p className="install-warning">{failed.displayName}: {failed.error?.message ?? 'Transfer did not finish.'}
      {' '}Remaining files were not started.</p> : null}
    {!allCompleted && !failed && mtp ? <p className="dim">Keep the Switch connected. Small files may finish without a Windows copy window.</p> : null}
    {allCompleted && mtp && verification === 'confirmed' ? <p className="install-batch__confirmed">
      All selected verified titles are visible in a fresh DBI scan. You can disconnect the Switch.
    </p> : null}
    {allCompleted && mtp && verification !== 'confirmed' ? <>
      <p className="install-warning">Keep the Switch connected until DBI confirms the installation.
        {verification === 'unverifiable' ? ' Some files were already installed or lack verified title data, so this copy cannot be confirmed automatically. Check DBI and the Windows copy window before disconnecting.'
          : ' DBI may still be processing the files. If DBI shows success but this view stays unchanged, restart its MTP responder and refresh here; its installed-games list may be cached for the session.'}</p>
      {checkError ? <p className="error-text">Switch check failed: {checkError}</p> : null}
      <Button onClick={() => void refresh()} disabled={checking}>Refresh Switch</Button>
    </> : null}
    <div className="row row--wrap install-batch__footer">
      <Button onClick={onClose}>{allCompleted || failed ? 'Close' : 'Continue in background'}</Button>
      {!allCompleted && !failed ? <span className="dim">Keep this open for final Switch confirmation. Copy status is also in Settings → Install queue.</span> : null}
    </div>
  </div>;
}
