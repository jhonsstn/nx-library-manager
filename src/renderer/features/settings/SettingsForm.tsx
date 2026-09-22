import { useEffect, useState } from 'react';
import { SwitchCatalogError } from '@shared/errors/app-error';
import { displayFolder, isShellPath } from '@shared/format/install';
import type { AppUpdateStatusDto } from '@shared/types/domain';
import type { PublicSettingsDto, SettingsUpdateInput } from '@shared/types/settings';
import { getCatalogApi } from '@renderer/api';
import { Button } from '@renderer/components/Button';
import { CheckboxField, FolderField, SelectField, TextField } from '@renderer/components/Fields';
import { ErrorText, Skeleton } from '@renderer/components/Feedback';
import { ConfirmDialog } from '@renderer/components/Modal';
import { useToast } from '@renderer/components/Toast';
import { InstallQueueTray } from '@renderer/features/install/InstallQueueTray';
import { DbiServerPanel } from '@renderer/features/settings/DbiServerPanel';
import {
  useAppVersion,
  useExportBackup,
  useFileMutations,
  useMtpStatus,
  useResetLibrary,
  useServerMutations,
  useSettings,
  useUpdateSettings,
} from '@renderer/query/hooks';

/** Everything the form can edit; secrets are held separately so they never echo back. */
interface SettingsDraft {
  baseGamesFolder: string;
  updatesFolder: string;
  scanRecursively: boolean;
  autoRescanOnStartup: boolean;
  fuzzyMatchThreshold: string;
  cacheImages: boolean;
  autoCheckUpdatesOnStartup: boolean;
  igdbClientId: string;
  defaultInstallDestination: PublicSettingsDto['defaultInstallDestination'];
  defaultInstallFolder: string;
  httpServerEnabled: boolean;
  httpServerPort: string;
  httpServerUsername: string;
}

function draftFrom(settings: PublicSettingsDto): SettingsDraft {
  return {
    baseGamesFolder: settings.baseGamesFolder,
    updatesFolder: settings.updatesFolder,
    scanRecursively: settings.scanRecursively,
    autoRescanOnStartup: settings.autoRescanOnStartup,
    fuzzyMatchThreshold: String(settings.fuzzyMatchThreshold),
    cacheImages: settings.cacheImages,
    autoCheckUpdatesOnStartup: settings.autoCheckUpdatesOnStartup,
    igdbClientId: settings.igdbClientId,
    defaultInstallDestination: settings.defaultInstallDestination,
    defaultInstallFolder: settings.defaultInstallFolder,
    httpServerEnabled: settings.httpServerEnabled,
    httpServerPort: String(settings.httpServerPort),
    httpServerUsername: settings.httpServerUsername,
  };
}

/** Numbers entered as text stay text so a half-typed value is never written back. */
function rangeError(value: string, min: number, max: number, message: string): string | undefined {
  const parsed = Number(value);
  if (value.trim() === '' || !Number.isFinite(parsed) || parsed < min || parsed > max) return message;
  return undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof SwitchCatalogError) return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Settings page body (ports `SettingsDialog` + `_sync_http_server`). Local draft
 * state is diffed against the stored settings on save, so the main process only
 * receives what the user actually changed.
 */
export function SettingsForm() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const { chooseDirectory } = useFileMutations();
  const { refreshMtp } = useServerMutations();
  const mtp = useMtpStatus();
  const version = useAppVersion();
  const exportBackup = useExportBackup();
  const resetLibrary = useResetLibrary();
  const toast = useToast();

  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [igdbSecret, setIgdbSecret] = useState('');
  const [httpPassword, setHttpPassword] = useState('');
  const [resetOpen, setResetOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatusDto | null>(null);
  const [updateCheckError, setUpdateCheckError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);

  const stored = settings.data ?? null;

  useEffect(() => {
    if (stored && draft === null) setDraft(draftFrom(stored));
  }, [stored, draft]);

  if (settings.isLoading || !draft || !stored) {
    return (
      <div className="stack">
        <ErrorText error={settings.error} />
        {settings.error ? null : (
          <>
            <Skeleton width="40%" />
            <Skeleton width="65%" />
            <Skeleton width="55%" />
          </>
        )}
      </div>
    );
  }

  const patch = (changes: Partial<SettingsDraft>) =>
    setDraft((current) => (current ? { ...current, ...changes } : current));

  const portError = rangeError(draft.httpServerPort, 1, 65535, 'Port must be a number between 1 and 65535.');
  const thresholdError = rangeError(
    draft.fuzzyMatchThreshold,
    0,
    1,
    'Fuzzy match threshold must be a number between 0 and 1.',
  );

  const browse = async (title: string, apply: (path: string) => void) => {
    try {
      const path = await chooseDirectory.mutateAsync({ title });
      if (path) apply(path);
    } catch (error) {
      toast.error('Could not open the folder picker', messageOf(error));
    }
  };

  const save = () => {
    if (portError || thresholdError) return;
    const payload: SettingsUpdateInput = {};
    const baseFolder = draft.baseGamesFolder.trim();
    const updatesFolder = draft.updatesFolder.trim();
    const installFolder = draft.defaultInstallFolder.trim();
    const igdbClientId = draft.igdbClientId.trim();
    const username = draft.httpServerUsername.trim();
    const threshold = Number(draft.fuzzyMatchThreshold);
    const port = Number(draft.httpServerPort);

    if (baseFolder !== stored.baseGamesFolder) payload.baseGamesFolder = baseFolder;
    if (updatesFolder !== stored.updatesFolder) payload.updatesFolder = updatesFolder;
    if (draft.scanRecursively !== stored.scanRecursively) payload.scanRecursively = draft.scanRecursively;
    if (draft.autoRescanOnStartup !== stored.autoRescanOnStartup)
      payload.autoRescanOnStartup = draft.autoRescanOnStartup;
    if (draft.cacheImages !== stored.cacheImages) payload.cacheImages = draft.cacheImages;
    if (threshold !== stored.fuzzyMatchThreshold) payload.fuzzyMatchThreshold = threshold;
    if (igdbClientId !== stored.igdbClientId) payload.igdbClientId = igdbClientId;
    if (igdbSecret) payload.igdbClientSecret = igdbSecret;
    if (draft.defaultInstallDestination !== stored.defaultInstallDestination)
      payload.defaultInstallDestination = draft.defaultInstallDestination;
    if (installFolder !== stored.defaultInstallFolder) {
      payload.defaultInstallFolder = installFolder;
      const label = isShellPath(installFolder) ? stored.installFolderLabel : '';
      if (label !== stored.installFolderLabel) payload.installFolderLabel = label;
    }
    if (draft.httpServerEnabled !== stored.httpServerEnabled) payload.httpServerEnabled = draft.httpServerEnabled;
    if (port !== stored.httpServerPort) payload.httpServerPort = port;
    if (username !== stored.httpServerUsername) payload.httpServerUsername = username;
    if (httpPassword) payload.httpServerPassword = httpPassword;

    if (Object.keys(payload).length === 0) {
      toast.info('Nothing to save', 'No settings changed.');
      return;
    }

    update.mutate(payload, {
      onSuccess: () => {
        setIgdbSecret('');
        setHttpPassword('');
        toast.success('Settings saved');
      },
    });
  };

  const checkForUpdates = async () => {
    setChecking(true);
    setUpdateCheckError(null);
    try {
      setUpdateStatus(await getCatalogApi().app.checkForUpdates());
    } catch (error) {
      setUpdateCheckError(error);
      toast.error('Update check failed', messageOf(error));
    } finally {
      setChecking(false);
    }
  };

  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <section className="panel">
        <h2 className="panel__title">Library folders</h2>
        <p className="panel__hint">Folders are rescanned on demand; nothing is moved by scanning.</p>
        <FolderField
          label="Base games folder"
          value={draft.baseGamesFolder}
          onChange={(value) => patch({ baseGamesFolder: value })}
          onBrowse={() => void browse('Choose base games folder', (path) => patch({ baseGamesFolder: path }))}
        />
        <FolderField
          label="Updates folder"
          value={draft.updatesFolder}
          onChange={(value) => patch({ updatesFolder: value })}
          onBrowse={() => void browse('Choose updates folder', (path) => patch({ updatesFolder: path }))}
        />
      </section>

      <section className="panel">
        <h2 className="panel__title">Scanning</h2>
        <CheckboxField
          label="Scan recursively"
          checked={draft.scanRecursively}
          onChange={(value) => patch({ scanRecursively: value })}
          hint="Walk subfolders of the configured folders."
        />
        <CheckboxField
          label="Auto-rescan on startup"
          checked={draft.autoRescanOnStartup}
          onChange={(value) => patch({ autoRescanOnStartup: value })}
          hint="Refresh the catalog every time the application launches."
        />
        <CheckboxField
          label="Cache images"
          checked={draft.cacheImages}
          onChange={(value) => patch({ cacheImages: value })}
          hint="Keep cover art and screenshots locally so they render offline."
        />
        <TextField
          label="Fuzzy match threshold"
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={draft.fuzzyMatchThreshold}
          error={thresholdError}
          hint="0–1; higher values require closer filename matches before an update is attached."
          onChange={(event) => patch({ fuzzyMatchThreshold: event.target.value })}
        />
      </section>

      <section className="panel">
        <h2 className="panel__title">Metadata / IGDB</h2>
        <TextField
          label="IGDB client ID"
          value={draft.igdbClientId}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => patch({ igdbClientId: event.target.value })}
        />
        <TextField
          label="IGDB client secret"
          type="password"
          value={igdbSecret}
          autoComplete="new-password"
          placeholder={stored.igdbClientSecretConfigured ? 'Configured — leave blank to keep' : 'Not set'}
          onChange={(event) => setIgdbSecret(event.target.value)}
          hint="Secrets never round-trip to the window: the stored value is never shown or resent."
        />
      </section>

      <section className="panel">
        <h2 className="panel__title">Installation</h2>
        <div className="form-grid">
          <SelectField
            label="Install destination"
            value={draft.defaultInstallDestination}
            options={[
              { value: 'folder', label: 'Local folder' },
              { value: 'mtp-nand', label: 'NAND install' },
              { value: 'mtp-sd', label: 'SD Card install' },
            ]}
            onChange={(event) =>
              patch({
                defaultInstallDestination: event.target.value as PublicSettingsDto['defaultInstallDestination'],
              })
            }
          />
        </div>
        <FolderField
          label="Local install folder"
          value={draft.defaultInstallFolder}
          displayValue={displayFolder(draft.defaultInstallFolder, stored.installFolderLabel)}
          onChange={(value) => patch({ defaultInstallFolder: value })}
          onBrowse={() => void browse('Choose install folder', (path) => patch({ defaultInstallFolder: path }))}
          disabled={draft.defaultInstallDestination !== 'folder'}
          hint="Used only when the destination is a local folder."
        />
        <div className="row row--wrap">
          <span className={mtp.data?.available ? 'dim' : 'install-warning'}>
            {mtp.data?.available ? mtp.data.statusText : 'No Switch detected'}
          </span>
          <Button
            onClick={() =>
              refreshMtp.mutate(undefined, {
                onError: (error) => toast.error('Could not refresh the MTP status', messageOf(error)),
              })
            }
            disabled={refreshMtp.isPending}
          >
            Refresh MTP
          </Button>
        </div>
        <ErrorText error={mtp.error} />
        <InstallQueueTray />
      </section>

      <DbiServerPanel
        enabled={draft.httpServerEnabled}
        onEnabledChange={(value) => patch({ httpServerEnabled: value })}
        port={draft.httpServerPort}
        onPortChange={(value) => patch({ httpServerPort: value })}
        portError={portError}
        username={draft.httpServerUsername}
        onUsernameChange={(value) => patch({ httpServerUsername: value })}
        password={httpPassword}
        onPasswordChange={setHttpPassword}
        passwordConfigured={stored.httpServerPasswordConfigured}
      />

      <section className="panel">
        <h2 className="panel__title">Application</h2>
        <div className="row row--wrap">
          <span>Switch Game Catalog v{version.data ?? '—'}</span>
          <Button onClick={() => void checkForUpdates()} disabled={checking}>
            Check for Updates
          </Button>
          <CheckboxField
            label="Check for updates on startup"
            checked={draft.autoCheckUpdatesOnStartup}
            onChange={(value) => patch({ autoCheckUpdatesOnStartup: value })}
          />
        </div>
        {updateStatus ? (
          <div className="stack">
            <span className="dim">
              Installed: v{updateStatus.currentVersion} · Latest: {updateStatus.latestVersion}
            </span>
            {updateStatus.updateAvailable ? (
              <div className="row row--wrap">
                <span>{updateStatus.releaseName || updateStatus.latestVersion} is available.</span>
                <Button
                  onClick={() =>
                    void getCatalogApi()
                      .app.openExternal(updateStatus.releaseUrl)
                      .catch((error) => toast.error('Could not open the release page', messageOf(error)))
                  }
                >
                  Open release page
                </Button>
              </div>
            ) : (
              <span className="dim">Up to date.</span>
            )}
          </div>
        ) : null}
        <ErrorText error={updateCheckError} />
        <div className="row row--wrap">
          <Button
            onClick={() =>
              exportBackup.mutate(undefined, {
                onSuccess: (path) => {
                  if (path) toast.success('Backup exported', path);
                },
                onError: (error) => toast.error('Backup failed', messageOf(error)),
              })
            }
            disabled={exportBackup.isPending}
          >
            Export catalog backup
          </Button>
          <Button variant="danger" onClick={() => setResetOpen(true)} disabled={resetLibrary.isPending}>
            Reset library
          </Button>
        </div>
        <ErrorText error={exportBackup.error} />
        <ErrorText error={resetLibrary.error} />
      </section>

      <div className="settings-form__actions">
        <Button variant="primary" type="submit" disabled={update.isPending || Boolean(portError || thresholdError)}>
          Save
        </Button>
        <span className="dim">Changes apply after saving.</span>
      </div>
      <ErrorText error={update.error} />

      {resetOpen ? (
        <ConfirmDialog
          title="Reset library"
          message={
            'Remove every game, update and install record from the catalog?\n\n' +
            'Files on disk are not touched — the play files stay exactly where they are.'
          }
          confirmLabel="Reset library"
          danger
          onCancel={() => setResetOpen(false)}
          onConfirm={() => {
            setResetOpen(false);
            resetLibrary.mutate(undefined, {
              onSuccess: () => toast.success('Library reset', 'Run a scan to rebuild the catalog.'),
              onError: (error) => toast.error('Could not reset the library', messageOf(error)),
            });
          }}
        />
      ) : null}
    </form>
  );
}
