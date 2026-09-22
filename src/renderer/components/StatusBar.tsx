import { useAppVersion, useHttpServerStatus, useInstallJobs, useMtpStatus } from '../query/hooks';
import { useToast } from './Toast';
import { useAppEvents } from '../query/AppEventsProvider';

/** Bottom status strip: Switch connection, DBI URL, install activity, version. */
export function StatusBar() {
  const toast = useToast();
  const version = useAppVersion();
  const mtp = useMtpStatus();
  const server = useHttpServerStatus();
  const jobs = useInstallJobs();
  const { shutdownStatus } = useAppEvents();

  const activeJobs = (jobs.data ?? []).filter((job) => job.status === 'pending' || job.status === 'running');
  const mtpText = mtp.data?.available ? mtp.data.statusText : 'No Switch detected';

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Copied DBI URL', url);
    } catch (error) {
      toast.error('Could not copy the DBI URL', error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <footer className="status-bar">
      <span title="Switch MTP storage free space">{mtpText}</span>
      <span aria-live="polite">
        {server.data?.running ? (
          <>
            DBI:{' '}
            <button type="button" className="btn btn--ghost btn--icon" onClick={() => void copyUrl(server.data.directoryUrl)}>
              {server.data.directoryUrl}
            </button>
            {server.data.authEnabled ? <span className="dim"> (auth)</span> : null}
          </>
        ) : (
          <span className="dim">DBI server stopped</span>
        )}
      </span>
      <span className="status-bar__spacer" />
      {shutdownStatus ? (
        <span aria-live="assertive">{shutdownStatus.message}</span>
      ) : activeJobs.length > 0 ? (
        <span aria-live="polite">
          Installing {activeJobs.length} file{activeJobs.length === 1 ? '' : 's'}…
        </span>
      ) : null}
      <span className="dim">v{version.data ?? '—'}</span>
    </footer>
  );
}
