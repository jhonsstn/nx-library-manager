import { Fragment, useEffect, useState, type MouseEvent } from 'react';
import { formatBytes } from '@shared/format/bytes';
import { installSizeText } from '@shared/format/install';
import {
  detectedVersionSuffix,
  formatInstalledStatus,
  releasedVersionLabel,
  versionLabel,
} from '@shared/format/versions';
import type { GameDetailsDto, KnownDlcDto, UpdateCleanupPreviewDto, UpdateFileDto, UpdateGroupName } from '@shared/types/domain';
import { Cover } from '@renderer/components/Cover';
import { ErrorText, Skeleton } from '@renderer/components/Feedback';
import { ConfirmDialog } from '@renderer/components/Modal';
import { useContextMenu } from '@renderer/components/ContextMenu';
import { Button } from '@renderer/components/Button';
import { useToast } from '@renderer/components/Toast';
import { InstallControls } from '@renderer/features/install/InstallControls';
import { InstallDialog } from '@renderer/features/install/InstallDialog';
import {
  useFileMutations,
  useGame,
  useSetFavorite,
  useSetNeedsReview,
  useSetHidden,
  useUnmatchUpdates,
  useMtpInventory,
  useRefreshMtpInventory,
} from '@renderer/query/hooks';
import { ScreenshotViewer } from './ScreenshotViewer';
import { TrailerDialog } from './TrailerDialog';

export interface GameDetailsPaneProps {
  gameId: number;
  onVisibilityChange?: () => void;
}

/** Group order used by `ui.load_game` when it buckets updates by file name. */
const GROUP_ORDER: UpdateGroupName[] = ['Updates', 'DLC'];
const MAX_SCREENSHOTS = 8;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function groupUpdates(updates: UpdateFileDto[]): Array<{ name: UpdateGroupName; items: UpdateFileDto[] }> {
  return GROUP_ORDER.map((name) => ({ name, items: updates.filter((update) => update.group === name) })).filter(
    (group) => group.items.length > 0,
  );
}

function compactFileName(fileName: string): string {
  return fileName.replace(/\.(nsp|nsz|xci)$/i, '')
    .replace(/\[v\d+\](?:\s*\([^)]*\))?$/i, '')
    .replace(/\s*\[[0-9a-f]{16}\]$/i, '')
    .trim();
}

function dlcRow(item: KnownDlcDto, showSwitch: boolean) {
  return <li className="details__dlc-row" key={item.titleId}>
    <span className="details__dlc-name">{item.name}<small>
      {item.nameSource === 'title-id' ? 'Name unavailable' : `${item.titleId} · ${
        item.nameSource === 'filename' ? 'Filename' : item.nameSource === 'package'
          ? 'Package metadata' : 'TitleDB'}`}
    </small></span>
    {showSwitch ? <span className={`badge ${item.switchStatus === 'installed' ? 'badge--ok'
      : item.switchStatus === 'not-installed' ? 'badge--update' : ''}`}>
      {item.switchStatus === 'installed' ? 'On Switch' : item.switchStatus === 'not-installed'
        ? 'Not installed' : 'Switch unknown'}
    </span> : null}
    <span className={`badge ${item.filePresent ? 'badge--ok' : ''}`}>
      {item.filePresent ? 'Library file' : 'No library file'}
    </span>
  </li>;
}

/**
 * Right-hand details pane. Ports `ui.load_game`, `update_install_estimate`,
 * `installed_status_text`, `open_screenshot` and `open_trailer`: cover, metadata,
 * version status, description, the grouped DLC/update list with multi-select,
 * install controls and the screenshot strip.
 */
export function GameDetailsPane({ gameId, onVisibilityChange }: GameDetailsPaneProps) {
  const query = useGame(gameId);
  const toast = useToast();
  const setFavorite = useSetFavorite();
  const setNeedsReview = useSetNeedsReview();
  const setHidden = useSetHidden();
  const unmatchUpdates = useUnmatchUpdates();
  const deleteFile = useFileMutations().deleteFile;
  const cleanOldUpdates = useFileMutations().cleanOldUpdates;
  const inventory = useMtpInventory();
  const refreshInventory = useRefreshMtpInventory();
  const { open: openUpdateMenu, element: updateMenuElement } = useContextMenu();

  const [selectedUpdateIds, setSelectedUpdateIds] = useState<number[]>([]);
  const [installIds, setInstallIds] = useState<number[] | null>(null);
  const [suggestedInstall, setSuggestedInstall] = useState(false);
  const [deleteIds, setDeleteIds] = useState<number[] | null>(null);
  const [cleanupPreview, setCleanupPreview] = useState<UpdateCleanupPreviewDto | null>(null);
  const [trailerOpen, setTrailerOpen] = useState(false);
  const [screenshotIndex, setScreenshotIndex] = useState<number | null>(null);

  useEffect(() => {
    setSelectedUpdateIds([]);
    setInstallIds(null);
    setSuggestedInstall(false);
    setDeleteIds(null);
    setCleanupPreview(null);
    setTrailerOpen(false);
    setScreenshotIndex(null);
  }, [gameId]);

  if (query.isPending) {
    return (
      <div className="stack" aria-busy="true" aria-label="Loading game details">
        <Skeleton width={275} height={375} />
        <Skeleton width="40%" height={22} />
        <Skeleton width="70%" />
        <Skeleton width="55%" />
      </div>
    );
  }

  if (query.isError) {
    return <ErrorText error={query.error} />;
  }

  const details: GameDetailsDto = query.data;

  const selectedUpdates = details.updates.filter((update) => selectedUpdateIds.includes(update.id));
  const extraPaths = new Set<string>();
  const uniqueUpdates = selectedUpdates.filter((update) => {
    if (update.filePath === details.baseFile?.filePath || extraPaths.has(update.filePath)) return false;
    extraPaths.add(update.filePath);
    return true;
  });
  const selectedUpdateSize = uniqueUpdates.reduce((total, update) => total + (update.fileSize || 0), 0);
  const installSummary = installSizeText({
    baseSize: details.baseFile?.fileSize ?? 0,
    selectedUpdateCount: uniqueUpdates.length,
    selectedUpdateSize,
  });
  const groups = groupUpdates(details.updates);
  const screenshots = details.screenshots.slice(0, MAX_SCREENSHOTS);
  const localVersion = details.versionStatus.localVersion;
  const updateHistory = details.versionStatus.missingUpdate === undefined
    ? details.versionStatus.newer : details.versionStatus.newer.slice(1);
  const missingUpdate = details.versionStatus.missingUpdate;
  const statusTone = missingUpdate || details.versionStatus.kind === 'update-available' ? 'warning'
    : details.versionStatus.kind === 'current' ? 'success' : 'neutral';
  const statusHeading = missingUpdate ? 'Update file missing'
    : details.versionStatus.kind === 'update-available' ? 'Newer update available'
      : details.versionStatus.kind === 'current' ? 'Latest update file present'
        : details.versionStatus.kind === 'local-newer' ? 'Local file newer than catalog'
          : details.versionStatus.kind === 'loading' ? 'Checking update data'
            : 'Update status unknown';
  const knownDlc = [...(details.knownDlc ?? [])].sort((a, b) => Number(a.filePresent) - Number(b.filePresent));
  const missingDlcCount = knownDlc.filter((item) => !item.filePresent).length;
  const knownDlcWithFile = knownDlc.filter((item) => item.filePresent);
  const knownDlcWithoutFile = knownDlc.filter((item) => !item.filePresent);
  const showSwitch = Boolean(inventory.data?.deviceId);
  const showDlcInSwitch = inventory.data?.state === 'ready' || inventory.data?.state === 'partial';
  const dlcDetails = <>
    {knownDlc.length ? <div className="details__known-dlc">
      <div className="details__subheading">
        <h4>Known DLC</h4>
        <span>{knownDlc.length} listed{missingDlcCount ? ` · ${missingDlcCount} without a library file` : ''}</span>
      </div>
      {knownDlcWithFile.length ? <ul className="details__dlc-list">
        {knownDlcWithFile.map((item) => dlcRow(item, showSwitch))}</ul> : null}
      {knownDlcWithoutFile.length ? <>
        <h5>Known DLC without a library file</h5>
        <ul className="details__dlc-list">{knownDlcWithoutFile.map((item) => dlcRow(item, showSwitch))}</ul>
      </> : null}
      <p className="details__source-note">DLC IDs: TitleDB · updated {details.knownDlcRefreshedAt?.slice(0, 10) ?? 'unknown date'} · listed DLC does not imply ownership</p>
    </div> : null}
    {details.localDlc?.length ? <div className="details__known-dlc">
      <h4>Other local DLC</h4>
      <ul className="details__dlc-list">{details.localDlc.map((item) => dlcRow(item, showSwitch))}</ul>
    </div> : null}
  </>;

  const toggleFavorite = () => {
    setFavorite.mutate(
      { gameId: details.id, favorite: !details.favorite },
      {
        onSuccess: () => toast.success(details.favorite ? 'Removed favorite' : 'Favorite saved', details.displayTitle),
        onError: (error) => toast.error('Could not update the favorite', errorMessage(error)),
      },
    );
  };

  const toggleNeedsReview = () => {
    setNeedsReview.mutate(
      { gameId: details.id, value: !details.needsReview },
      {
        onSuccess: () =>
          toast.success(details.needsReview ? 'Review flag cleared' : 'Flagged for review', details.displayTitle),
        onError: (error) => toast.error('Could not update the review flag', errorMessage(error)),
      },
    );
  };

  const toggleHidden = () => {
    setHidden.mutate({ gameId: details.id, hidden: !details.hidden }, {
      onSuccess: () => {
        toast.success(details.hidden ? 'Game restored' : 'Game hidden', details.displayTitle);
        onVisibilityChange?.();
      },
      onError: (error) => toast.error('Could not change game visibility', errorMessage(error)),
    });
  };

  const openUpdatesMenu = (event: MouseEvent<HTMLElement>, updateId: number) => {
    const ids = selectedUpdateIds.includes(updateId) ? selectedUpdateIds : [updateId];
    setSelectedUpdateIds(ids);
    openUpdateMenu(event, [
      { label: 'Install selected update/DLC file(s)', onSelect: () => setInstallIds(ids) },
      { label: 'Delete selected update file(s)', danger: true, onSelect: () => setDeleteIds(ids) },
      {
        label: 'Unmatch selected update(s)',
        separatorBefore: true,
        onSelect: () => {
          unmatchUpdates.mutate(ids, {
            onSuccess: () => toast.success('Updates unmatched', `${ids.length} file(s) released for matching`),
            onError: (error) => toast.error('Could not unmatch the updates', errorMessage(error)),
          });
        },
      },
    ]);
  };

  const deleteSelectedUpdates = async (ids: number[]) => {
    setDeleteIds(null);
    try {
      const paths = new Set<string>();
      let deleted = 0;
      for (const updateId of ids) {
        const update = details.updates.find((item) => item.id === updateId);
        if (!update || paths.has(update.filePath)) continue;
        paths.add(update.filePath);
        await deleteFile.mutateAsync({ kind: 'update', updateId });
        deleted += 1;
      }
      toast.success('Update files deleted', `${deleted} physical file(s) removed from disk`);
    } catch (error) {
      toast.error('Could not delete every update file', errorMessage(error));
    }
  };

  const deleteFileNames = (ids: number[]) =>
    [...new Set(ids.map((id) => details.updates.find((update) => update.id === id)?.filePath ?? `#${id}`))]
      .map((path) => `${path}${path === details.baseFile?.filePath ? ' (also contains the base game)' : ''}`)
      .join('\n');

  const confirmCleanup = async () => {
    if (!cleanupPreview) return;
    const preview = cleanupPreview;
    setCleanupPreview(null);
    try {
      const result = await cleanOldUpdates.mutateAsync({ gameId: details.id, preview });
      toast.success('Older updates removed',
        `${result.deletedFiles} file(s) deleted · ${formatBytes(result.freedBytes)} freed`);
    } catch (error) {
      toast.error('Could not clean older updates', errorMessage(error));
    }
  };

  return (
    <article className="stack game-details">
      <div className="details">
        <Cover src={details.coverDisplayUrl} alt={details.displayTitle} favorite={details.favorite} />
        <div className="details__overview">
          <h2 className="details__title">{details.displayTitle}</h2>
          <p className="details__byline">
            {details.releaseDate || 'Release date unknown'} · {details.publisher || 'Publisher unknown'}
          </p>
          <p className="details__meta">
            {details.genres.join(' · ') || 'Genre unknown'}
            {details.developer ? ` · Developed by ${details.developer}` : ''}
          </p>
          <div className="details__identity">
            <span className="badge">{details.metadataProvider?.toUpperCase() ?? 'Local metadata'}</span>
            {details.hidden ? <span className="badge">Hidden</span> : null}
            <span className="details__title-id">Title ID: {details.titleId ?? 'Unknown (provisional)'}</span>
          </div>
          <div className={`details__update-card details__update-card--${statusTone}`} role="status">
            {details.versionStatus.kind === 'loading' ? (
              <div className="details__update-loading">
                <span className="spinner" aria-hidden="true" />
                <strong>{statusHeading}</strong>
              </div>
            ) : <strong>{statusHeading}</strong>}
            {missingUpdate ? (
              <>
                <span>Missing {releasedVersionLabel(missingUpdate.version, missingUpdate.releaseDate)} · TitleDB</span>
                <span>Latest on file: {versionLabel(localVersion)}</span>
              </>
            ) : details.versionStatus.kind === 'loading' ? (
              <span>Downloading TitleDB update and DLC data. The first check may take a few minutes.</span>
            ) : details.versionStatus.kind === 'unknown' || details.versionStatus.kind === 'missing-local-version' ? (
              <span>{details.versionStatus.uncertainty ?? 'Insufficient metadata to compare updates.'}</span>
            ) : (
              <span>
                On file: {versionLabel(localVersion)} · Latest released: {details.versionStatus.latest
                  ? releasedVersionLabel(details.versionStatus.latest.version, details.versionStatus.latest.releaseDate)
                  : 'unknown'}
              </span>
            )}
          </div>
          {showSwitch ? <section className="details__switch" aria-label="On this Switch">
            <div className="row row--wrap">
              <h3>On this Switch</h3>
              <Button onClick={() => refreshInventory.mutate()} disabled={inventory.data?.state === 'scanning'}>
                Refresh
              </Button>
            </div>
            {inventory.data?.state === 'scanning' ? <p>Checking Switch installed content…</p>
              : inventory.data?.state === 'unavailable' || inventory.data?.state === 'error'
                ? <p>Switch inventory unavailable: {inventory.data.message ?? 'Open DBI MTP Installed games.'}</p>
                : <>
                  {inventory.data?.state === 'partial' ? <p className="install-warning">
                    Some DBI entries could not be identified. Absence cannot be confirmed.
                  </p> : null}
                  <p>Base game: {details.switchStatus?.base === 'installed' ? 'Installed'
                    : details.switchStatus?.base === 'not-installed' ? 'Not installed' : 'Unknown'}</p>
                  <p>Update: {details.switchStatus?.update === 'installed'
                    ? details.switchStatus.updateVersion === null ? 'Installed, version unknown'
                      : `Installed ${versionLabel(details.switchStatus.updateVersion)}`
                    : details.switchStatus?.update === 'not-installed' ? 'Not installed' : 'Unknown'}</p>
                  <p>Library update: {localVersion > 0 ? versionLabel(localVersion) : 'No verified update file'}
                    {' · '}Latest released: {details.versionStatus.latest
                      ? releasedVersionLabel(details.versionStatus.latest.version, details.versionStatus.latest.releaseDate)
                      : 'Unknown'}</p>
                  {showDlcInSwitch ? dlcDetails : null}
                  {details.switchStatus?.localContentReady ? <Button variant="primary"
                    onClick={() => setSuggestedInstall(true)}>Install missing local content</Button> : null}
                  <small className="dim">DBI MTP · checked {inventory.data?.checkedAt ?? 'unknown time'}</small>
                </>}
          </section> : null}
          {details.baseFile ? (
            <p className="details__file-summary" title={details.baseFile.filePath}>
              Base file · {details.baseFile.fileType} · {formatBytes(details.baseFile.fileSize)} · {details.baseFile.fileName}
            </p>
          ) : <p className="details__file-summary">No base game file recorded.</p>}
          {details.installed ? <p className="details__installed">{formatInstalledStatus(details.installed)}</p> : null}
          <div className="row row--wrap details__actions">
            <Button onClick={toggleFavorite}>{details.favorite ? 'Remove favorite' : 'Favorite game'}</Button>
            <Button onClick={toggleNeedsReview}>
              {details.needsReview ? 'Clear needs review' : 'Mark as needs review'}
            </Button>
            <Button onClick={toggleHidden} disabled={setHidden.isPending}>
              {details.hidden ? 'Restore to library' : 'Hide from library'}
            </Button>
            {details.trailerUrl ? <Button onClick={() => setTrailerOpen(true)}>Trailer</Button> : null}
          </div>
          <details className="details__disclosure details__about" key={`about-${gameId}`}>
            <summary>About this game</summary>
            <p className="details__description">{details.description || 'No description cached yet.'}</p>
          </details>
        </div>
      </div>

      <section aria-label="DLC and updates">
        <h3 className="details__section-title">Updates and DLC</h3>
        {!showDlcInSwitch ? dlcDetails : null}
        <div className="details__subheading details__subheading--local">
          <h4>Local files</h4>
          <span>{details.updates.length} update/DLC file{details.updates.length === 1 ? '' : 's'}</span>
        </div>
        {details.updateCleanup?.deleteFiles.length ? <div className="details__cleanup">
          <Button
            disabled={cleanOldUpdates.isPending}
            onClick={() => setCleanupPreview(details.updateCleanup ?? null)}
          >
            Clean older updates
          </Button>
          <span className="dim">Keeps the highest verified local patch version. Combined, unmatched, and unverified files are protected.</span>
        </div> : null}
        <div className="updates-list" role="listbox" aria-multiselectable="true" aria-label="DLC and updates">
          {groups.length === 0 ? (
            <p className="dim updates-list__empty">No update or DLC files matched to this game yet.</p>
          ) : (
            groups.map((group) => (
              <Fragment key={group.name}>
                <div className="group-header">{group.name}</div>
                {group.items.map((update) => {
                  const selected = selectedUpdateIds.includes(update.id);
                  return (
                    <button
                      key={update.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      aria-label={`${update.fileName}${detectedVersionSuffix(update.detectedVersion)}`}
                      title={update.fileName}
                      className={`list__item updates-list__item${selected ? ' is-selected' : ''}`}
                      onClick={() =>
                        setSelectedUpdateIds((current) =>
                          current.includes(update.id)
                            ? current.filter((value) => value !== update.id)
                            : [...current, update.id],
                        )
                      }
                      onContextMenu={(event) => openUpdatesMenu(event, update.id)}
                    >
                      <span className="updates-list__name">{compactFileName(update.fileName)}</span>
                      {update.detectedVersion ? <span className="updates-list__version">
                        {detectedVersionSuffix(update.detectedVersion).trim()}
                      </span> : null}
                    </button>
                  );
                })}
              </Fragment>
            ))
          )}
        </div>
        <p className="install-summary">{installSummary}</p>
        <InstallControls gameId={details.id} updateIds={selectedUpdateIds} />
        <Button
          variant="primary"
          style={{ marginTop: 'var(--space-2)' }}
          onClick={() => setInstallIds(selectedUpdateIds)}
        >
          Install Game + Selected Updates
        </Button>
      </section>

      {updateHistory.length > 0 || details.containedTitles?.length || details.baseFile ? (
        <details className="details__disclosure details__package-details" key={`packages-${gameId}`}>
          <summary>Package details <span>{details.containedTitles?.length ?? 0} detected title{details.containedTitles?.length === 1 ? '' : 's'}</span></summary>
          {details.baseFile ? <p className="details__package-path">Base file: {details.baseFile.filePath}</p> : null}
          {updateHistory.length > 0 ? <div className="details__package-history">
            <h4>{missingUpdate === undefined ? 'Newer releases' : 'Earlier releases'}</h4>
            <ul>{updateHistory.map((version) => (
              <li key={version.version}>{releasedVersionLabel(version.version, version.releaseDate)}</li>
            ))}</ul>
          </div> : null}
          {details.containedTitles?.length ? <ul className="details__package-list">{details.containedTitles.map((item, index) => (
            <li key={`${item.filePath}:${item.titleId ?? index}`}>
              <div><strong>{item.type.toUpperCase()}</strong> · {item.name} · {item.titleId ?? 'Title ID unknown'} ·{' '}
                {item.rawVersion === null ? 'version unknown' : `v${item.rawVersion}`}</div>
              <small>{item.provisional ? `Provisional filename${item.inspectionError ? ` · ${item.inspectionError}` : ''}`
                : `Verified ${item.source}`} · {item.filePath}</small>
            </li>
          ))}</ul> : null}
        </details>
      ) : null}

      {screenshots.length > 0 ? (
        <section aria-label="Screenshots">
          <h3 className="details__section-title">Screenshots</h3>
          <div className="screenshot-strip">
            {screenshots.map((shot, index) => (
              <button
                key={shot.id}
                type="button"
                className="screenshot-thumb"
                aria-label={`Open screenshot ${index + 1} of ${screenshots.length}`}
                onClick={() => setScreenshotIndex(index)}
              >
                <img src={shot.displayUrl} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {updateMenuElement}
      {trailerOpen && details.trailerUrl ? (
        <TrailerDialog url={details.trailerUrl} onClose={() => setTrailerOpen(false)} />
      ) : null}
      {installIds ? (
        <InstallDialog gameId={details.id} updateIds={installIds} onClose={() => setInstallIds(null)} />
      ) : null}
      {suggestedInstall ? <InstallDialog gameId={details.id} suggested
        onClose={() => setSuggestedInstall(false)} /> : null}
      {screenshotIndex !== null ? (
        <ScreenshotViewer
          screenshots={screenshots}
          initialIndex={screenshotIndex}
          onClose={() => setScreenshotIndex(null)}
        />
      ) : null}
      {deleteIds ? (
        <ConfirmDialog
          title="Delete update files"
          danger
          confirmLabel="Delete from disk"
          message={`Delete ${deleteIds.length} file(s) from disk?\n\n${deleteFileNames(deleteIds)}\n\nThis cannot be undone.`}
          onCancel={() => setDeleteIds(null)}
          onConfirm={() => void deleteSelectedUpdates(deleteIds)}
        />
      ) : null}
      {cleanupPreview ? (
        <ConfirmDialog
          title="Clean older updates"
          danger
          confirmLabel="Delete older updates"
          message={`Keep v${cleanupPreview.latestLocalVersion}:\n${cleanupPreview.keepFiles.map((file) => file.filePath).join('\n')}\n\nDelete ${cleanupPreview.deleteFiles.length} older update file(s) (${formatBytes(cleanupPreview.deleteFiles.reduce((size, file) => size + file.fileSize, 0))}):\n${cleanupPreview.deleteFiles.map((file) => `v${file.rawVersion} · ${file.filePath}`).join('\n')}\n\nThis cannot be undone. DLC, combined packages, unmatched and unverified files are excluded.`}
          onCancel={() => setCleanupPreview(null)}
          onConfirm={() => void confirmCleanup()}
        />
      ) : null}
    </article>
  );
}
