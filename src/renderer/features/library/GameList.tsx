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
}

const SKELETON_ROWS = 6;

/**
 * Library list rows. Each row is a `role="option"` in a single-select listbox
 * whose accessible name is the game title, so the row is reachable by keyboard
 * and by name (spec 12 accessibility) instead of only through the pointer-only
 * context menu. Every status the Qt build conveyed with colour carries text too.
 */
export function GameList({
  games,
  loading,
  error,
  selectedGameId,
  onSelect,
  onContextMenu,
  emptyMessage,
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
        return (
          <button
            key={game.id}
            type="button"
            role="option"
            aria-selected={selected}
            aria-label={game.displayTitle}
            className={`list__item library-row${selected ? ' is-selected' : ''}${
              game.favorite ? ' is-favorite' : ''
            }`}
            onClick={() => onSelect(game.id)}
            onContextMenu={(event) => onContextMenu(event, game)}
          >
            <span className="list__title">{game.displayTitle}</span>
            <span className="library-row__badges">
              {game.favorite ? (
                <span className="badge badge--favorite" aria-label="Favorite">
                  ★ Favorite
                </span>
              ) : null}
              {game.needsReview ? <span className="badge badge--review">Needs review</span> : null}
              {game.hasNewerUpdate ? <span className="badge badge--update">Update available</span> : null}
              {game.updateCount > 0 ? (
                <span className="list__meta">
                  {game.updateCount} update file{game.updateCount === 1 ? '' : 's'}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
