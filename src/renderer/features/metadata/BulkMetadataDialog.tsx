import { useEffect, useState } from 'react';
import type { MetadataBulkProgressDto } from '@shared/types/domain';
import { getCatalogApi } from '@renderer/api';
import { Button } from '@renderer/components/Button';
import { CheckboxField } from '@renderer/components/Fields';
import { ErrorText, ProgressBar } from '@renderer/components/Feedback';
import { Modal } from '@renderer/components/Modal';
import { useToast } from '@renderer/components/Toast';
import { useAppEvents } from '@renderer/query/AppEventsProvider';
import { useMetadataMutations } from '@renderer/query/hooks';

export interface BulkMetadataDialogProps {
  onClose: () => void;
}

/**
 * Bulk metadata refresh (spec 13, Flow E at catalog scale). Progress streams
 * from the main process; games without a confident match are marked for review
 * rather than silently left stale.
 */
export function BulkMetadataDialog({ onClose }: BulkMetadataDialogProps) {
  const { bulkMetadata } = useAppEvents();
  const { bulkRefresh } = useMetadataMutations();
  const toast = useToast();
  const [force, setForce] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<MetadataBulkProgressDto | null>(null);
  const [finished, setFinished] = useState(false);
  const [cancelError, setCancelError] = useState<unknown>(null);

  // Live progress for display; the provider keeps this cheap for every dialog.
  useEffect(() => {
    if (bulkMetadata) setProgress(bulkMetadata);
  }, [bulkMetadata]);

  // The provider drops the payload as soon as a job reports `done`, so the
  // terminal event (with its final counts) is read straight from the API.
  useEffect(() => {
    if (jobId === null) return;
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void getCatalogApi()
      .metadata.onBulkProgress((event) => {
        if (event.jobId !== jobId || !event.done) return;
        setProgress(event);
        setFinished(true);
      })
      .then((off) => {
        if (cancelled) off();
        else dispose = off;
      });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [jobId]);

  const start = () =>
    bulkRefresh.mutate(
      { force },
      {
        onSuccess: (started) => {
          setJobId(started.jobId);
          setProgress(null);
          setFinished(false);
          toast.info('Metadata scan started');
        },
        onError: (error) => toast.error('Could not start the metadata scan', messageOf(error)),
      },
    );

  const cancel = async () => {
    if (!jobId) return;
    try {
      await getCatalogApi().metadata.cancel(jobId);
      setFinished(true);
      toast.info('Metadata scan cancelled');
    } catch (error) {
      setCancelError(error);
    }
  };

  const running = jobId !== null && !finished;

  return (
    <Modal
      title="Refresh all metadata"
      onClose={onClose}
      footer={
        running ? (
          <Button variant="danger" onClick={() => void cancel()}>
            Cancel
          </Button>
        ) : jobId === null ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={start} disabled={bulkRefresh.isPending}>
              Start scan
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
      }
    >
      <p className="panel__hint">
        Looks up identified games by Title ID in Nlib, then uses IGDB when no usable Nlib record exists. Games
        without a confident match are marked for review so you can rematch them by hand.
      </p>

      {jobId === null ? (
        <CheckboxField
          label="Force refresh games that already have cached metadata"
          checked={force}
          onChange={setForce}
          hint="Leave off to skip games that are already complete."
        />
      ) : null}

      {running ? (
        <div className="stack">
          <ProgressBar value={progress?.processed ?? 0} max={progress?.total ?? 0} />
          <span className="list__meta">
            {progress ? `${progress.processed} of ${progress.total} games` : 'Waiting for the first game…'}
          </span>
          {progress?.currentTitle ? <span className="dim">Scanning {progress.currentTitle}</span> : null}
        </div>
      ) : null}

      {running || finished ? (
        <ul className="list metadata-progress">
          <li className="list__item list__item--static">
            <span className="list__title">Updated</span>
            <span>{progress?.updated ?? 0}</span>
          </li>
          <li className="list__item list__item--static">
            <span className="list__title">No match</span>
            <span>{progress?.noMatch ?? 0}</span>
          </li>
          <li className="list__item list__item--static">
            <span className="list__title">Failed</span>
            <span>{progress?.failed ?? 0}</span>
          </li>
        </ul>
      ) : null}

      {finished ? (
        <p>
          {progress
            ? `Scan complete: ${progress.processed} processed, ${progress.updated} updated, ${progress.noMatch} with no match, ${progress.failed} failed.`
            : 'Scan finished before any progress was reported.'}
          {progress && (progress.noMatch > 0 || progress.failed > 0)
            ? ' Games without a confident match were marked for review.'
            : ''}
        </p>
      ) : null}

      <ErrorText error={bulkRefresh.error} />
      <ErrorText error={cancelError} />
    </Modal>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
