import { GameGrid } from '@renderer/features/grid/GameGrid';

/**
 * Favorites route. Reuses the grid with `favoritesOnly` so filtering, virtual
 * scrolling and the context menu stay in one place (spec 12: do not duplicate
 * data fetching).
 */
export function FavoritesPage() {
  return (
    <div className="pane-column">
      <GameGrid favoritesOnly />
    </div>
  );
}
