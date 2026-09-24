import type { MtpInventoryDto, ScanProgressDto } from '@shared/types/domain';
import { Button } from '@renderer/components/Button';
import { ProgressBar } from '@renderer/components/Feedback';

/** Sentinel option meaning "do not filter by genre" (mirrors the Qt combo box). */
export const ALL_GENRES = 'All Genres';

export interface LibraryFiltersProps {
  search: string;
  onSearchChange: (value: string) => void;
  genres: string[];
  genre: string;
  onGenreChange: (value: string) => void;
  needsReview: boolean;
  onNeedsReviewChange: (value: boolean) => void;
  needsUpdate: boolean;
  onNeedsUpdateChange: (value: boolean) => void;
  readyToInstall: boolean;
  onReadyToInstallChange: (value: boolean) => void;
  inventory: MtpInventoryDto | null;
  onRefreshInventory: () => void;
  showHidden: boolean;
  onShowHiddenChange: (value: boolean) => void;
  scanProgress: ScanProgressDto | null;
  scanning: boolean;
  onRescan: () => void;
  onScanMetadata: () => void;
  onOpenSettings: () => void;
  onExportBackup: () => void;
}

function progressText(progress: ScanProgressDto): string {
  const parts = [`Scanning library (${progress.phase})`];
  if (progress.checkedFiles > 0) parts.push(`${progress.checkedFiles} files checked`);
  if (progress.candidateFiles > 0) parts.push(`${progress.candidateFiles} candidates`);
  parts.push(`${progress.gamesFound} games`, `${progress.updatesFound} updates`);
  return parts.join(' · ');
}

/**
 * Library toolbar: search, genre, the two review flags and the library-wide
 * actions. Ports the widget row built in `ui._library_tab` plus the scan
 * progress feedback the Qt build showed in its status bar.
 */
export function LibraryFilters({
  search,
  onSearchChange,
  genres,
  genre,
  onGenreChange,
  needsReview,
  onNeedsReviewChange,
  needsUpdate,
  onNeedsUpdateChange,
  readyToInstall,
  onReadyToInstallChange,
  inventory,
  onRefreshInventory,
  showHidden,
  onShowHiddenChange,
  scanProgress,
  scanning,
  onRescan,
  onScanMetadata,
  onOpenSettings,
  onExportBackup,
}: LibraryFiltersProps) {
  const sortedGenres = [...genres].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
  const fraction =
    scanProgress && scanProgress.candidateFiles > 0
      ? Math.min(1, scanProgress.checkedFiles / scanProgress.candidateFiles)
      : 0;

  return (
    <div className="library-filters">
      <div className="toolbar">
        <input
          className="input library-filters__search"
          type="search"
          value={search}
          placeholder="Search library"
          aria-label="Search library"
          spellCheck={false}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        <select
          className="select library-filters__genre"
          aria-label="Genre"
          value={genre}
          onChange={(event) => onGenreChange(event.target.value)}
        >
          <option value={ALL_GENRES}>{ALL_GENRES}</option>
          {sortedGenres.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={needsReview}
            onChange={(event) => onNeedsReviewChange(event.target.checked)}
          />
          Need Review
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={needsUpdate}
            onChange={(event) => onNeedsUpdateChange(event.target.checked)}
          />
          Needs Update?
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={readyToInstall} disabled={inventory?.state !== 'ready'}
            onChange={(event) => onReadyToInstallChange(event.target.checked)} />
          Ready to install
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(event) => onShowHiddenChange(event.target.checked)}
          />
          Hidden games only
        </label>
        <span className="toolbar__spacer" />
        <span className="dim" role="status">{inventory?.state === 'ready'
          ? `Switch checked ${inventory.checkedAt?.slice(11, 16) ?? ''}`
          : inventory?.state === 'scanning' ? 'Checking Switch…'
            : inventory?.state === 'partial' ? 'Switch inventory incomplete'
              : inventory?.state === 'unavailable' || inventory?.state === 'error'
                ? 'Switch inventory unavailable' : 'Switch inventory disconnected'}</span>
        <Button onClick={onRefreshInventory} disabled={inventory?.state === 'scanning'}>
          Refresh Switch
        </Button>
        <Button onClick={onRescan} disabled={scanning}>
          Rescan Library
        </Button>
        <Button onClick={onScanMetadata}>Scan All Metadata</Button>
        <Button onClick={onOpenSettings}>Settings</Button>
        <Button onClick={onExportBackup}>Export Backup</Button>
      </div>
      {scanProgress ? (
        <div className="library-filters__progress" role="status" aria-live="polite">
          <span>{progressText(scanProgress)}</span>
          {fraction > 0 ? <ProgressBar value={fraction} /> : null}
        </div>
      ) : null}
    </div>
  );
}
