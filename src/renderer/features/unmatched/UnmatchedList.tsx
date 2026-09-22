import type { MouseEvent } from 'react';
import type { InstallableUpdateDto } from '@shared/contracts/api';
import { detectedVersionSuffix } from '@shared/format/versions';

export interface UnmatchedListProps {
  rows: InstallableUpdateDto[];
  selectedIds: ReadonlySet<number>;
  onToggle: (id: number) => void;
  /** Plain click keeps a single row selected; modifiers extend the selection. */
  onSelectOnly: (id: number) => void;
  onSelectAll: (selected: boolean) => void;
  onOpenMenu: (event: MouseEvent<HTMLElement>, row: InstallableUpdateDto) => void;
}

/**
 * Update/DLC rows that are not attached to a game yet. Selection is a real
 * checkbox column so keyboard users get the same multi-select as mouse users.
 */
export function UnmatchedList({
  rows,
  selectedIds,
  onToggle,
  onSelectOnly,
  onSelectAll,
  onOpenMenu,
}: UnmatchedListProps) {
  const allSelected = rows.length > 0 && rows.every((row) => selectedIds.has(row.id));

  return (
    <ul className="list unmatched-list" aria-label="Unmatched update/DLC files">
      <li className="list__item list__item--static unmatched-list__header">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={() => onSelectAll(!allSelected)}
          aria-label="Select all unmatched files"
        />
        <span className="dim">
          {selectedIds.size} of {rows.length} selected
        </span>
      </li>
      {rows.map((row) => {
        const version = detectedVersionSuffix(row.detectedVersion);
        const selected = selectedIds.has(row.id);
        return (
          <li
            key={row.id}
            className={selected ? 'list__item is-selected unmatched-list__row' : 'list__item unmatched-list__row'}
            onContextMenu={(event) => onOpenMenu(event, row)}
          >
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggle(row.id)}
              aria-label={`Select ${row.fileName}`}
            />
            <button
              type="button"
              className="unmatched-list__main"
              aria-pressed={selected}
              onClick={(event) =>
                event.ctrlKey || event.metaKey || event.shiftKey ? onToggle(row.id) : onSelectOnly(row.id)
              }
              onContextMenu={(event) => onOpenMenu(event, row)}
            >
              <span className="unmatched-list__name">
                {row.fileName}
                {version}
              </span>
              <span className="mono dim unmatched-list__path">{row.filePath}</span>
            </button>
            <span className="badge" title={`Detected group: ${row.group}`}>
              {row.group}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
