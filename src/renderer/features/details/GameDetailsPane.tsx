import { Fragment, useEffect, useState, type MouseEvent } from 'react';
import { formatBytes } from '@shared/format/bytes';
import { installSizeText } from '@shared/format/install';
import {
  detectedVersionSuffix,
  formatInstalledStatus,
  formatVersionStatusText,
  releasedVersionLabel,
} from '@shared/format/versions';
import type { GameDetailsDto, UpdateFileDto, UpdateGroupName } from '@shared/types/domain';
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
  useUnmatchUpdates,
} from '@renderer/query/hooks';
import { ScreenshotViewer } from './ScreenshotViewer';
import { TrailerDialog } from './TrailerDialog';

export interface GameDetailsPaneProps {
  gameId: number;
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

/**
 * Right-hand details pane. Ports `ui.load_game`, `update_install_estimate`,
 * `installed_status_text`, `open_screenshot` and `open_trailer`: cover, metadata,
 * version status, description, the grouped DLC/update list with multi-select,
 * install controls and the screenshot strip.
 */
export function GameDetailsPane({ gameId }: GameDetailsPaneProps) {
  const query = useGame(gameId);
  const toast = useToast();
  const setFavorite = useSetFavorite();
  const setNeedsReview = useSetNeedsReview();
  const unmatchUpdates = useUnmatchUpdates();
  const deleteFile = useFileMutations().deleteFile;
  const { open: openUpdateMenu, element: updateMenuElement } = useContextMenu();

  const [selectedUpdateIds, setSelectedUpdateIds] = useState<number[]>([]);
  const [installIds, setInstallIds] = useState<number[] | null>(null);
  const [deleteIds, setDeleteIds] = useState<number[] | null>(null);
  const [trailerOpen, setTrailerOpen] = useState(false);
  const [screenshotIndex, setScreenshotIndex] = useState<number | null>(null);

  useEffect(() => {
    setSelectedUpdateIds([]);
    setInstallIds(null);
    setDeleteIds(null);
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
  const pathText = details.baseFile
    ? `${details.baseFile.fileType} | ${formatBytes(details.baseFile.fileSize)} | ${details.baseFile.filePath}`
    : 'No base game file recorded.';

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

  return (
    <article className="stack">
      <div className="details">
        <Cover src={details.coverDisplayUrl} alt={details.displayTitle} favorite={details.favorite} />
        <div>
          <h2 className="details__title">{details.displayTitle}</h2>
          <p className="details__meta">
            Release: {details.releaseDate || 'Unknown'} | Developer: {details.developer || 'Unknown'} | Publisher:{' '}
            {details.publisher || 'Unknown'}
          </p>
          <p className="details__meta">Genres: {details.genres.join(', ') || 'Unknown'}</p>
          <p className="details__meta">Catalog source: {details.metadataProvider?.toUpperCase() ?? 'Local file only'}</p>
          {details.trailerUrl ? (
            <Button className="details__trailer" onClick={() => setTrailerOpen(true)}>
              Trailer
            </Button>
          ) : null}
          <div className="row row--wrap" style={{ marginBottom: 'var(--space-2)' }}>
            <Button onClick={toggleFavorite}>{details.favorite ? 'Remove favorite' : 'Favorite game'}</Button>
            <Button onClick={toggleNeedsReview}>
              {details.needsReview ? 'Clear needs review' : 'Mark as needs review'}
            </Button>
          </div>
          <p className="details__path">{pathText}</p>
          <p className="details__meta">Title ID: {details.titleId ?? 'Unknown (provisional)'}</p>
          <p className="details__status">
            {details.versionStatus.kind === 'unknown'
              ? `Update status unknown: ${details.versionStatus.uncertainty ?? 'Insufficient metadata.'}`
              : formatVersionStatusText({ localVersion, latest: details.versionStatus.latest })}
          </p>
          {details.versionStatus.missingUpdate ? (
            <p className="details__status">Latest known update file missing: {releasedVersionLabel(
              details.versionStatus.missingUpdate.version,
              details.versionStatus.missingUpdate.releaseDate,
            )} (TitleDB)</p>
          ) : null}
          {updateHistory.length > 0 ? (
            <section aria-label={details.versionStatus.missingUpdate === undefined
              ? 'Newer updates available' : 'Earlier released updates'}>
              <h3 className="details__section-title">{details.versionStatus.missingUpdate === undefined
                ? 'Newer Updates Available' : 'Earlier released updates'}</h3>
              <ul className="list">
                {updateHistory.map((version) => (
                  <li key={version.version} className="list__item list__item--static">
                    {releasedVersionLabel(version.version, version.releaseDate)}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <p className="details__status">{formatInstalledStatus(details.installed)}</p>
          <div
            className="textarea details__description"
            role="textbox"
            aria-readonly="true"
            aria-label="Description"
            tabIndex={0}
          >
            {details.description || 'No description cached yet.'}
          </div>
        </div>
      </div>

      <section aria-label="DLC and updates">
        <h3 className="details__section-title">DLC/Updates</h3>
        {details.containedTitles?.length ? <div className="stack">
          <h4>Detected package contents</h4>
          <ul className="list">{details.containedTitles.map((item, index) => (
            <li className="list__item list__item--static" key={`${item.filePath}:${item.titleId ?? index}`}>
              {item.type.toUpperCase()} · {item.name} · {item.titleId ?? 'Title ID unknown'} ·{' '}
              {item.rawVersion === null ? 'version unknown' : `v${item.rawVersion}`} ·{' '}
              {item.provisional ? `provisional filename${item.inspectionError ? ` (${item.inspectionError})` : ''}`
                : `verified ${item.source}`} · {item.filePath}
            </li>
          ))}</ul>
        </div> : null}
        {details.knownDlc?.length ? <div className="stack">
          <h4>Known DLC (TitleDB)</h4>
          <p className="dim">Catalog refreshed {details.knownDlcRefreshedAt ?? 'unknown date'}. File presence is based on this library only.</p>
          <ul className="list">{details.knownDlc.map((item) => (
            <li className="list__item list__item--static" key={item.titleId}>
              {item.name} · {item.titleId} · {item.filePresent ? 'file present' : 'file missing'}
            </li>
          ))}</ul>
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
                      <span className="list__title">
                        {update.fileName}
                        {detectedVersionSuffix(update.detectedVersion)}
                      </span>
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
    </article>
  );
}
