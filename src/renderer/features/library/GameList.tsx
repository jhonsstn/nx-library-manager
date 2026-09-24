import type { MouseEvent } from 'react';
import type { GameSummaryDto } from '@shared/types/domain';
import { EmptyState, ErrorText, Skeleton } from '@renderer/components/Feedback';

export interface GameListProps {
  games: GameSummaryDto[];
  loading: boolean;
  error: unknown;
  selectedGameId: number | null;
  onSelect: (gameId: number) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>, game: GameSummaryDto) => void;
  emptyMessage: string;
  inventoryReady?: boolean;
}

const SKELETON_ROWS = 6;

/**
 * Library list rows. Each row is a `role="option"` in a single-select listbox
 * whose accessible name is the game title, so the row is reachable by keyboard
 * and by name (spec 12 accessibility) instead of only through the pointer-only
 * context menu. Compact status dots expose their meaning on hover and through
 * the row's accessible description.
 */
export function GameList({
  games,
  loading,
  error,
  selectedGameId,
  onSelect,
  onContextMenu,
  emptyMessage,
  inventoryReady = false,
}: GameListProps) {
  if (loading) {
    return (
      <div className="list library-list" aria-label="Loading games" aria-busy="true">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <div key={index} className="library-skeletons">
            <Skeleton width={index % 2 === 0 ? '60%' : '45%'} />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="library-list" role="alert">
        <ErrorText error={error} />
      </div>
    );
  }

  if (games.length === 0) {
    return (
      <div className="library-list">
        <EmptyState>{emptyMessage}</EmptyState>
      </div>
    );
  }

  return (
    <div className="list library-list" role="listbox" aria-label="Games">
      {games.map((game) => {
        const selected = game.id === selectedGameId;
        const updateStatuses = [
          game.hasNewerUpdate ? 'Latest known update file is missing' : null,
          game.hasCleanableUpdates ? 'Older tracked update files can be cleaned' : null,
        ].filter((status): status is string => status !== null);
        const switchText = inventoryReady && game.switchStatus ? [
          game.switchStatus.base === 'installed' ? 'Base game on Switch'
            : game.switchStatus.base === 'not-installed' ? 'Base game absent from Switch'
              : 'Base game status unknown',
          game.switchStatus.update === 'installed' ? 'Update on Switch'
            : game.switchStatus.update === 'not-installed' ? 'Update absent from Switch'
              : 'Update status unknown',
          game.switchStatus.localContentReady ? 'Local content ready to install' : 'No newer local content to install',
        ].join('; ') : null;
        const description = [...updateStatuses, ...(switchText ? [switchText] : [])];
        const descriptionId = description.length ? `game-update-status-${game.id}` : undefined;
        return (
          <button
            key={game.id}
            type="button"
            role="option"
            aria-selected={selected}
            aria-label={game.displayTitle}
            aria-describedby={descriptionId}
            className={`list__item library-row${selected ? ' is-selected' : ''}${
              game.favorite ? ' is-favorite' : ''
            }`}
            onClick={() => onSelect(game.id)}
            onContextMenu={(event) => onContextMenu(event, game)}
          >
            <span className="list__title">{game.displayTitle}</span>
            <span className="library-row__badges">
              {game.hidden ? <span className="badge">Hidden</span> : null}
              {game.favorite ? (
                <span className="badge badge--favorite" aria-label="Favorite">
                  ★ Favorite
                </span>
              ) : null}
              {game.needsReview ? <span className="badge badge--review">Needs review</span> : null}
              {game.hasNewerUpdate ? (
                <span className="library-row__status library-row__status--missing"
                  title="Latest known update file is missing" aria-hidden="true" />
              ) : null}
              {game.hasCleanableUpdates ? (
                <span className="library-row__status library-row__status--cleanup"
                  title="Older tracked update files can be cleaned" aria-hidden="true" />
              ) : null}
              {switchText ? <span className={`library-row__switch library-row__switch--${
                game.switchStatus?.localContentReady ? 'needs-content' : game.switchStatus?.base ?? 'unknown'}`}
                title={switchText} aria-hidden="true">S</span> : null}
            </span>
            {descriptionId ? (
              <span id={descriptionId} className="sr-only">{description.join('. ')}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
