import { useEffect, useMemo, useState } from 'react';
import type { CreateInstallInput, InstallDestination, InstallableUpdateDto } from '@shared/contracts/api';
import { formatBytes } from '@shared/format/bytes';
import { installSizeText } from '@shared/format/install';
import { detectedVersionSuffix, rawVersionFromVersionText } from '@shared/format/versions';
import type { GameDetailsDto, InstallDestinationType, MtpStatusDto } from '@shared/types/domain';
import { Button } from '@renderer/components/Button';
import { ErrorText, Skeleton } from '@renderer/components/Feedback';
import { Modal } from '@renderer/components/Modal';
import { useToast } from '@renderer/components/Toast';
import { useGame, useInstallMutations, useMtpStatus, useSettings, useUpdates } from '@renderer/query/hooks';

/** Destination choices shared by the install dialog and the inline install controls. */
export const INSTALL_DESTINATION_OPTIONS: Array<{ value: InstallDestinationType; label: string }> = [
  { value: 'folder', label: 'Local folder' },
  { value: 'mtp-nand', label: 'NAND install' },
  { value: 'mtp-sd', label: 'SD Card install' },
];

function destinationKindOf(destination: InstallDestination): InstallDestinationType {
  if (destination.type === 'folder') return 'folder';
  return destination.storage === 'nand' ? 'mtp-nand' : 'mtp-sd';
}

/** `null` when the choice is not usable yet (local install without a folder). */
export function buildDestination(kind: InstallDestinationType, folder: string): InstallDestination | null {
  if (kind === 'folder') return folder ? { type: 'folder', path: folder } : null;
  return { type: 'mtp', storage: kind === 'mtp-nand' ? 'nand' : 'sd' };
}

export interface InstallDialogProps {
  /** Absent for unmatched files, which have no owning game yet. */
  gameId?: number | null;
  updateIds?: number[];
  /** Fixed destination; when absent the dialog offers the settings default as a choice. */
  destination?: InstallDestination;
  onClose: () => void;
}

interface PlannedFile {
  key: string;
  name: string;
  path: string;
  size: number;
  group: 'Base game' | 'Updates' | 'DLC';
  version: string;
}

/** Base game first, then updates oldest-to-newest, then DLC (spec 13, Flow F). */
function planFiles(
  baseFile: GameDetailsDto['baseFile'],
  updates: InstallableUpdateDto[],
  updateIds: number[],
): PlannedFile[] {
  const plan: PlannedFile[] = [];
  const seenPaths = new Set<string>();
  if (baseFile) {
    seenPaths.add(baseFile.filePath);
    plan.push({
      key: `base-${baseFile.id}`,
      name: baseFile.fileName,
      path: baseFile.filePath,
      size: baseFile.fileSize,
      group: 'Base game',
      version: '',
    });
  }
  const wanted = new Set(updateIds);
  const selected = updateIds.length === 0 ? [] : updates.filter((row) => wanted.has(row.id));
  const updateFiles = selected
    .filter((row) => row.group === 'Updates')
    .sort(
      (left, right) =>
        rawVersionFromVersionText(left.detectedVersion) - rawVersionFromVersionText(right.detectedVersion) ||
        left.fileName.localeCompare(right.fileName),
    );
  const dlcFiles = selected
    .filter((row) => row.group === 'DLC')
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
  for (const row of [...updateFiles, ...dlcFiles]) {
    if (seenPaths.has(row.filePath)) continue;
    seenPaths.add(row.filePath);
    plan.push({
      key: `update-${row.id}`,
      name: row.fileName,
      path: row.filePath,
      size: row.fileSize,
      group: row.group,
      version: row.detectedVersion,
    });
  }
  return plan;
}

/** The renderer has no free-space reading of its own, so unknown space is stated, not guessed. */
function freeSpaceWarning(destination: InstallDestination | null, mtp: MtpStatusDto | undefined): string | null {
  if (!destination) return 'Choose an install destination before confirming.';
  if (destination.type === 'folder') {
    return 'Free space could not be verified for this folder — the transfer fails if the destination is full.';
  }
  const storage = mtp?.storages.find((candidate) => candidate.id === destination.storage);
  if (!mtp?.available || !storage || storage.freeBytes === null) {
    return 'Free space could not be verified — connect the Switch and refresh the MTP status before installing.';
  }
  return null;
}

export function InstallDialog({ gameId, updateIds = [], destination, onClose }: InstallDialogProps) {
  const toast = useToast();
  const settings = useSettings();
  const mtp = useMtpStatus();
  const game = useGame(gameId ?? null);
  const updates = useUpdates({});
  const { create } = useInstallMutations();
  const [kind, setKind] = useState<InstallDestinationType | null>(destination ? destinationKindOf(destination) : null);

  useEffect(() => {
    if (destination || kind !== null) return;
    const preferred = settings.data?.defaultInstallDestination;
    if (preferred) setKind(preferred);
  }, [destination, kind, settings.data]);

  const effectiveDestination = useMemo(
    () => destination ?? (kind ? buildDestination(kind, settings.data?.defaultInstallFolder ?? '') : null),
    [destination, kind, settings.data],
  );

  const plan = useMemo(
    () => planFiles(game.data?.baseFile ?? null, updates.data ?? [], updateIds),
    [game.data, updates.data, updateIds],
  );
  const baseFile = game.data?.baseFile ?? null;
  const updatePlan = plan.filter((file) => file.group !== 'Base game');
  const loading = updates.isLoading || (gameId != null && game.isLoading);
  const warning = freeSpaceWarning(effectiveDestination, mtp.data);
  const canConfirm = !loading && plan.length > 0 && effectiveDestination !== null && !create.isPending;

  const confirm = () => {
    if (!effectiveDestination) return;
    const payload: CreateInstallInput = { updateIds, destination: effectiveDestination };
    if (gameId != null) {
      payload.gameId = gameId;
      payload.includeBaseFile = baseFile !== null;
    }
    create.mutate(payload, {
      onSuccess: () => {
        toast.success('Install queued', `${plan.length} file(s) queued for transfer.`);
        onClose();
      },
    });
  };

  return (
    <Modal
      title="Install files"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={confirm} disabled={!canConfirm}>
            Confirm install
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="stack">
          <Skeleton width="60%" />
          <Skeleton width="80%" />
          <Skeleton width="70%" />
        </div>
      ) : (
        <>
          <p className="panel__hint">
            Files are transferred in this order — the base game first, then updates oldest to newest, then DLC.
          </p>
          {plan.length === 0 ? (
            <p className="dim">Nothing to install yet: select a base file or one or more update/DLC files.</p>
          ) : (
            <ul className="list install-plan" aria-label="Files to transfer">
              {plan.map((file) => (
                <li key={file.key} className="install-plan__item">
                  <span className="badge badge--ok">{file.group}</span>
                  <span className="install-plan__name">
                    {file.name}
                    <span className="dim">{detectedVersionSuffix(file.version)}</span>
                    <span className="mono dim install-plan__path">{file.path}</span>
                  </span>
                  <span className="list__meta">{formatBytes(file.size)}</span>
                </li>
              ))}
            </ul>
          )}

          <p className="install-plan__total">
            {installSizeText({
              baseSize: Number(baseFile?.fileSize ?? 0),
              selectedUpdateCount: updatePlan.length,
              selectedUpdateSize: updatePlan.reduce((sum, file) => sum + Number(file.size || 0), 0),
            })}
          </p>

          {destination ? (
            <p className="dim">Destination: {describeDestination(effectiveDestination, settings.data?.installFolderLabel)}</p>
          ) : (
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
          )}

          {warning ? <p className="install-warning">{warning}</p> : null}
          <ErrorText error={create.error} />
        </>
      )}
    </Modal>
  );
}

/** Renders a destination in user terms; MTP storage keeps its friendly label. */
function describeDestination(destination: InstallDestination | null, folderLabel = ''): string {
  if (!destination) return 'not chosen';
  if (destination.type === 'folder') return destination.path;
  if (folderLabel) return folderLabel;
  return destination.storage === 'nand' ? 'NAND install' : 'SD Card install';
}
