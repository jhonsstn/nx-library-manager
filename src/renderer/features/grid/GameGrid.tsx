import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ListGamesInput } from '@shared/contracts/api';
import { higherResImageUrl } from '@shared/format/images';
import type { GameSummaryDto } from '@shared/types/domain';
import { useContextMenu, type ContextMenuItem } from '@renderer/components/ContextMenu';
import { EmptyState, ErrorText, Skeleton } from '@renderer/components/Feedback';
import { ConfirmDialog } from '@renderer/components/Modal';
import { useToast } from '@renderer/components/Toast';
import { useSelection } from '@renderer/app/SelectionProvider';
import { useExportBackup, useGames, useMarkAsUpdate, useSetFavorite } from '@renderer/query/hooks';

/** Art slider bounds, matching `ui._grid_tab`'s QSlider range. */
export const MIN_ART_SIZE = 110;
export const MAX_ART_SIZE = 260;
export const DEFAULT_ART_SIZE = 170;

/** Height/width ratio of a grid cover, matching `ui._grid_icon_size`. */
const ART_ASPECT = 1.45;
/** `.grid__item` horizontal padding plus its border. */
const ITEM_PADDING = 16;
/** `.grid__row` column gap (`var(--space-3)`) and `.grid-scroll` side padding. */
const COLUMN_GAP = 12;
const SCROLL_PADDING = 32;
/** Space reserved under the cover for the title and badges. */
const LABEL_HEIGHT = 62;

export interface GameGridProps {
  /** Requests only favourites from the catalog; the Grid and Favorites pages share this component. */
  favoritesOnly?: boolean;
  /** Cover width in pixels; the Grid page owns the slider. */
  artSize?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Catalog grid with windowed rows (`@tanstack/react-virtual`) so multi-thousand
 * game libraries only mount the visible cells. Ports `ui._grid_tab`,
 * `_refresh_grid_list`, `update_grid_item_size`, `open_grid_game` and
 * `_open_grid_menu`; the Favorites page reuses it with `favoritesOnly`.
 */
export function GameGrid({ favoritesOnly = false, artSize = DEFAULT_ART_SIZE }: GameGridProps) {
  const filters = useMemo<ListGamesInput>(() => (favoritesOnly ? { favoritesOnly: true } : {}), [favoritesOnly]);
  const gamesQuery = useGames(filters);
  const games = gamesQuery.data?.items ?? [];

  const { selectedGameId, selectGame } = useSelection();
  const navigate = useNavigate();
  const toast = useToast();
  const setFavorite = useSetFavorite();
  const markAsUpdate = useMarkAsUpdate();
  const exportBackup = useExportBackup();
  const { open: openMenu, element: menuElement } = useContextMenu();
  const [markTarget, setMarkTarget] = useState<GameSummaryDto | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setViewportWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const artHeight = Math.round(artSize * ART_ASPECT);
  const itemWidth = artSize + ITEM_PADDING;
  const rowHeight = artHeight + LABEL_HEIGHT;
  const usableWidth = Math.max(0, viewportWidth - SCROLL_PADDING);
  const columns = Math.max(1, Math.floor((usableWidth + COLUMN_GAP) / (itemWidth + COLUMN_GAP)));
  const rowCount = Math.ceil(games.length / columns);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 3,
  });

  const openInLibrary = (gameId: number) => {
    selectGame(gameId);
    navigate('/library');
  };

  const toggleFavorite = (game: GameSummaryDto) => {
    setFavorite.mutate(
      { gameId: game.id, favorite: !game.favorite },
      { onError: (error) => toast.error('Could not update the favorite', errorMessage(error)) },
    );
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

  const menuItems = (game: GameSummaryDto): ContextMenuItem[] => [
    { label: 'Open in library', onSelect: () => openInLibrary(game.id) },
    {
      label: game.favorite ? 'Remove favorite' : 'Favorite game',
      onSelect: () => toggleFavorite(game),
    },
    { label: 'Mark as DLC/update', onSelect: () => setMarkTarget(game) },
    { label: 'Export catalog backup', separatorBefore: true, onSelect: () => void runExportBackup() },
  ];

  const openCellMenu = (event: MouseEvent<HTMLElement>, game: GameSummaryDto) => {
    openMenu(event, menuItems(game));
  };

  const renderCell = (game: GameSummaryDto) => {
    const selected = game.id === selectedGameId;
    const url = game.coverDisplayUrl ?? (game.coverImageUrl ? higherResImageUrl(game.coverImageUrl) : null);
    return (
      <button
        key={game.id}
        type="button"
        className={`grid__item${selected ? ' is-selected' : ''}${game.favorite ? ' is-favorite' : ''}`}
        style={{ width: itemWidth }}
        title={game.displayTitle}
        aria-label={game.displayTitle}
        onClick={() => selectGame(game.id)}
        onDoubleClick={() => openInLibrary(game.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') openInLibrary(game.id);
        }}
        onContextMenu={(event) => openCellMenu(event, game)}
      >
        {url ? (
          <img className="grid__art" style={{ width: artSize, height: artHeight }} src={url} alt="" loading="lazy" />
        ) : (
          <span className="grid__art grid__art--empty" style={{ width: artSize, height: artHeight }}>
            No cover
          </span>
        )}
        <span className="grid__label">{game.displayTitle}</span>
        <span className="grid__badges">
          {game.favorite ? (
            <span className="badge badge--favorite" aria-label="Favorite">
              ★ Favorite
            </span>
          ) : null}
          {game.hasNewerUpdate ? <span className="badge badge--update">Update</span> : null}
          {game.needsReview ? <span className="badge badge--review">Review</span> : null}
        </span>
      </button>
    );
  };

  return (
    <>
      <div className="grid-scroll" ref={scrollRef}>
        {gamesQuery.isPending ? (
          <div className="grid" aria-busy="true" aria-label="Loading games">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} width={itemWidth} height={artHeight} />
            ))}
          </div>
        ) : gamesQuery.isError ? (
          <div role="alert" style={{ padding: 'var(--space-4)' }}>
            <ErrorText error={gamesQuery.error} />
          </div>
        ) : games.length === 0 ? (
          <EmptyState>
            {favoritesOnly
              ? 'No favorites yet. Mark a game as a favorite to see it here.'
              : 'No games in the catalog yet. Run Rescan Library to populate it.'}
          </EmptyState>
        ) : (
          <div className="grid-virtual" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => (
              <div
                key={row.key}
                className="grid__row"
                style={{
                  transform: `translateY(${row.start}px)`,
                  height: row.size,
                  gridTemplateColumns: `repeat(${columns}, ${itemWidth}px)`,
                }}
              >
                {games.slice(row.index * columns, row.index * columns + columns).map(renderCell)}
              </div>
            ))}
          </div>
        )}
      </div>
      {menuElement}
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
    </>
  );
}
