import { useEffect, useState } from 'react';
import type { InstallDestinationType } from '@shared/types/domain';
import { displayFolder } from '@shared/format/install';
import { Button } from '@renderer/components/Button';
import { Skeleton } from '@renderer/components/Feedback';
import { useMtpStatus, useSettings } from '@renderer/query/hooks';
import { buildDestination, INSTALL_DESTINATION_OPTIONS, InstallDialog } from './InstallDialog';

export interface InstallControlsProps {
  gameId: number;
  /** Selected update/DLC rows; empty means "base game only". */
  updateIds: number[];
}

/**
 * Inline install entry point on the game details pane (spec 13, Flow F). The
 * destination defaults to the saved setting but can be overridden per install;
 * nothing is transferred until the dialog is confirmed.
 */
export function InstallControls({ gameId, updateIds }: InstallControlsProps) {
  const settings = useSettings();
  const mtp = useMtpStatus();
  const [kind, setKind] = useState<InstallDestinationType | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (kind !== null) return;
    const preferred = settings.data?.defaultInstallDestination;
    if (preferred) setKind(preferred);
  }, [kind, settings.data]);

  const folder = settings.data?.defaultInstallFolder ?? '';
  const destination = kind ? buildDestination(kind, folder) : null;
  const needsSwitch = kind !== null && kind !== 'folder';
  const unavailable = needsSwitch && !mtp.data?.available;

  if (settings.isLoading) {
    return (
      <div className="install-controls">
        <Skeleton width="220px" />
      </div>
    );
  }

  const hint = needsSwitch
    ? mtp.data?.available
      ? mtp.data.statusText
      : 'No Switch detected'
    : folder
      ? displayFolder(folder, settings.data?.installFolderLabel ?? '')
      : 'No local install folder configured — set one in Settings.';

  return (
    <div className="install-controls">
      <label className="field">
        <span className="field__label">Destination</span>
        <select
          className="select"
          aria-label="Install destination"
          value={kind ?? ''}
          onChange={(event) => setKind(event.target.value as InstallDestinationType)}
        >
          <option value="" disabled>
            Choose destination…
          </option>
          {INSTALL_DESTINATION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <div className="row install-controls__actions">
        <Button variant="primary" onClick={() => setOpen(true)} disabled={destination === null || unavailable}>
          Install
        </Button>
        <span className={unavailable ? 'install-warning' : 'dim'}>{hint}</span>
      </div>
      {open && destination ? (
        <InstallDialog gameId={gameId} updateIds={updateIds} destination={destination} onClose={() => setOpen(false)} />
      ) : null}
    </div>
  );
}
