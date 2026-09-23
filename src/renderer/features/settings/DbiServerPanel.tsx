import { Button } from '@renderer/components/Button';
import { CheckboxField, TextField } from '@renderer/components/Fields';
import { ErrorText } from '@renderer/components/Feedback';
import { useToast } from '@renderer/components/Toast';
import { useHttpServerStatus, useServerMutations } from '@renderer/query/hooks';

export interface DbiServerPanelProps {
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
  port: string;
  onPortChange: (value: string) => void;
  portError?: string;
  username: string;
  onUsernameChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  passwordConfigured: boolean;
}

/**
 * DBI Wi-Fi install server controls (spec 13, Flow G). The port and auth values
 * only take effect once the form is saved; start/stop acts on the live server.
 */
export function DbiServerPanel({
  enabled,
  onEnabledChange,
  port,
  onPortChange,
  portError,
  username,
  onUsernameChange,
  password,
  onPasswordChange,
  passwordConfigured,
}: DbiServerPanelProps) {
  const status = useHttpServerStatus();
  const { start, stop } = useServerMutations();
  const toast = useToast();
  const running = status.data?.running ?? false;
  const directoryUrl = status.data?.directoryUrl ?? '';

  const copyUrl = async () => {
    if (!directoryUrl) return;
    try {
      await navigator.clipboard.writeText(directoryUrl);
      toast.success('Copied DBI URL', directoryUrl);
    } catch (error) {
      toast.error('Could not copy the DBI URL', error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className="panel">
      <h2 className="panel__title">DBI HTTP server</h2>
      <p className="panel__hint">
        Serves the catalog to DBI over your local network so the Switch can download files directly.
      </p>

      <CheckboxField
        label="Enable HTTP server"
        checked={enabled}
        onChange={onEnabledChange}
        hint="The server starts with the application when enabled."
      />
      <div className="form-grid">
        <TextField
          label="HTTP port"
          type="number"
          min={1}
          max={65535}
          value={port}
          error={portError}
          hint="DBI connects to this port (1–65535)."
          onChange={(event) => onPortChange(event.target.value)}
        />
        <TextField
          label="HTTP username"
          value={username}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onUsernameChange(event.target.value)}
          hint="Leave blank to serve without authentication."
        />
      </div>
      <TextField
        label="HTTP password"
        type="password"
        value={password}
        autoComplete="new-password"
        placeholder={passwordConfigured ? 'Configured — leave blank to keep' : 'Not set'}
        onChange={(event) => onPasswordChange(event.target.value)}
        hint="Stored passwords are never sent back to this window; type a new one only to replace it."
      />

      <div className="row row--wrap">
        {running ? (
          <Button
            variant="danger"
            onClick={() =>
              stop.mutate(undefined, {
                onSuccess: () => toast.info('DBI server stopped'),
                onError: (error) => toast.error('Could not stop the DBI server', messageOf(error)),
              })
            }
            disabled={stop.isPending}
          >
            Stop server
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={() =>
              start.mutate(undefined, {
                onSuccess: (next) => toast.success('DBI server started', next.directoryUrl),
                onError: (error) => toast.error('Could not start the DBI server', messageOf(error)),
              })
            }
            disabled={!enabled || start.isPending}
          >
            Start server
          </Button>
        )}
        <span className="dim">
          {enabled ? 'Starts automatically with the application.' : 'Enable the server and save to start it.'}
        </span>
      </div>

      {running ? (
        <div className="row dbi-server__url">
          <span className="mono">{directoryUrl}</span>
          <Button onClick={() => void copyUrl()}>Copy URL</Button>
          {status.data?.authEnabled ? <span className="badge">Basic Auth</span> : <span className="badge">No auth</span>}
        </div>
      ) : (
        <p className="dim">Server stopped — DBI cannot reach the catalog.</p>
      )}

      <ErrorText error={status.error} />
      <ErrorText error={start.error} />
      <ErrorText error={stop.error} />

      <p className="install-warning">
        Basic Auth over plain HTTP does not encrypt credentials or traffic. Prefer a private VPN such as Tailscale or
        WireGuard for remote access.
      </p>
    </section>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
