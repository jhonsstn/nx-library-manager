import { useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GameSummaryDto } from '@shared/types/domain';
import { useContextMenu, type ContextMenuItem } from '@renderer/components/ContextMenu';
import { ConfirmDialog } from '@renderer/components/Modal';
import { useToast } from '@renderer/components/Toast';
import { useSelection } from '@renderer/app/SelectionProvider';
import { useDebouncedValue } from '@renderer/hooks/useDebouncedValue';
import { useAppEvents } from '@renderer/query/AppEventsProvider';
import { useExportBackup, useFileMutations, useGames, useGenres, useMarkAsUpdate, useScan, useSetFavorite } from '@renderer/query/hooks';
import { GameDetailsPane } from '@renderer/features/details/GameDetailsPane';
import { BulkMetadataDialog } from '@renderer/features/metadata/BulkMetadataDialog';
import { MetadataRematchDialog } from '@renderer/features/metadata/MetadataRematchDialog';
import { GameList } from '@renderer/features/library/GameList';
import { ALL_GENRES, LibraryFilters } from '@renderer/features/library/LibraryFilters';
import '@renderer/styles/details.css';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Library route: filter/list pane on the left, game details on the right.
 * Ports the Qt library tab (`ui._library_tab`, `refresh_games`, `refresh_genres`,
 * `load_game`, `open_game_menu`, `show_game_in_library`).
 */
export function LibraryPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const scan = useScan();
  const exportBackup = useExportBackup();
  const setFavorite = useSetFavorite();
  const markAsUpdate = useMarkAsUpdate();
  const deleteFile = useFileMutations().deleteFile;
  const { scanProgress } = useAppEvents();
  const { selectedGameId, selectGame } = useSelection();
  const { open: openMenu, element: menuElement } = useContextMenu();

  const [search, setSearch] = useState('');
  const [genre, setGenre] = useState<string>(ALL_GENRES);
  const [needsReview, setNeedsReview] = useState(false);
  const [needsUpdate, setNeedsUpdate] = useState(false);
  const [bulkMetadataOpen, setBulkMetadataOpen] = useState(false);
  const [rematchGameId, setRematchGameId] = useState<number | null>(null);
  const [markTarget, setMarkTarget] = useState<GameSummaryDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GameSummaryDto | null>(null);

  const debouncedSearch = useDebouncedValue(search);
  const trimmedSearch = debouncedSearch.trim();

  const games = useGames({
    search: trimmedSearch || undefined,
    genre: genre === ALL_GENRES ? undefined : genre,
    needsReview,
    needsUpdate,
  });
  const genres = useGenres();

  const scanRunning = scanProgress !== null || scan.start.isPending;

  const runScan = () => {
    scan.start.mutate({}, { onError: (error) => toast.error('Rescan failed', errorMessage(error)) });
  };

  const runExportBackup = async () => {
    try {
      const path = await exportBackup.mutateAsync();
      if (path) toast.success('Catalog backup exported', path);
      else toast.info('Backup cancelled', 'No file was written.');
    } catch (error) {
      toast.error('Backup failed', errorMessage(error));
    }
  };

  const gameMenuItems = (game: GameSummaryDto): ContextMenuItem[] => [
    { label: 'Search/change metadata match', onSelect: () => setRematchGameId(game.id) },
    {
      label: game.favorite ? 'Remove favorite' : 'Favorite game',
      onSelect: () =>
        setFavorite.mutate(
          { gameId: game.id, favorite: !game.favorite },
          { onError: (error) => toast.error('Could not update the favorite', errorMessage(error)) },
        ),
    },
    { label: 'Mark as DLC/update', onSelect: () => setMarkTarget(game) },
    { label: 'Export catalog backup', onSelect: () => void runExportBackup() },
    {
      label: 'Delete game file from disk',
      danger: true,
      separatorBefore: true,
      disabled: game.baseFile === null,
      onSelect: () => setDeleteTarget(game),
    },
  ];

  const openGameMenu = (event: MouseEvent<HTMLElement>, game: GameSummaryDto) => {
    openMenu(event, gameMenuItems(game));
  };

  return (
    <>
      <div className="split">
        <section className="split__pane pane-column" aria-label="Library">
          <LibraryFilters
            search={search}
            onSearchChange={setSearch}
            genres={genres.data ?? []}
            genre={genre}
            onGenreChange={setGenre}
            needsReview={needsReview}
            onNeedsReviewChange={setNeedsReview}
            needsUpdate={needsUpdate}
            onNeedsUpdateChange={setNeedsUpdate}
            scanProgress={scanProgress}
            scanning={scanRunning}
            onRescan={runScan}
            onScanMetadata={() => setBulkMetadataOpen(true)}
            onOpenSettings={() => navigate('/settings')}
            onExportBackup={() => void runExportBackup()}
          />
          <GameList
            games={games.data?.items ?? []}
            loading={games.isPending}
            error={games.isError ? games.error : null}
            selectedGameId={selectedGameId}
            onSelect={selectGame}
            onContextMenu={openGameMenu}
            emptyMessage="No games match the current filters."
          />
        </section>
        <section className="split__pane split__pane--right" aria-label="Game details">
          {selectedGameId === null ? (
            <p className="empty-state">Select a game</p>
          ) : (
            <GameDetailsPane gameId={selectedGameId} />
          )}
        </section>
      </div>
      {menuElement}
      {bulkMetadataOpen ? <BulkMetadataDialog onClose={() => setBulkMetadataOpen(false)} /> : null}
      {rematchGameId !== null ? (
        <MetadataRematchDialog gameId={rematchGameId} onClose={() => setRematchGameId(null)} />
      ) : null}
      {markTarget ? (
        <ConfirmDialog
          title="Mark as DLC/update"
          message={`Move "${markTarget.displayTitle}" out of the game list and treat its files as update/DLC files?`}
          confirmLabel="Mark as DLC/update"
          onCancel={() => setMarkTarget(null)}
          onConfirm={() => {
            markAsUpdate.mutate(markTarget.id, {
              onSuccess: () => toast.success('Marked as update/DLC', markTarget.displayTitle),
              onError: (error) => toast.error('Could not mark the game', errorMessage(error)),
            });
            setMarkTarget(null);
          }}
        />
      ) : null}
      {deleteTarget?.baseFile ? (
        <ConfirmDialog
          title="Delete game file"
          danger
          confirmLabel="Delete from disk"
          message={`Delete "${deleteTarget.baseFile.fileName}" from disk?\n\n${deleteTarget.baseFile.filePath}\n\nThis cannot be undone.`}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const file = deleteTarget.baseFile;
            setDeleteTarget(null);
            if (!file) return;
            deleteFile.mutate(
              { kind: 'game', gameId: deleteTarget.id },
              {
                onSuccess: () => toast.success('Game file deleted', file.filePath),
                onError: (error) => toast.error('Could not delete the game file', errorMessage(error)),
              },
            );
          }}
        />
      ) : null}
    </>
  );
}
