import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { InstallableUpdateDto } from '@shared/contracts/api';
import { Button } from '@renderer/components/Button';
import { useContextMenu } from '@renderer/components/ContextMenu';
import { EmptyState, ErrorText, Skeleton } from '@renderer/components/Feedback';
import { ConfirmDialog } from '@renderer/components/Modal';
import { useToast } from '@renderer/components/Toast';
import { InstallDialog } from '@renderer/features/install/InstallDialog';
import { InstallQueueTray } from '@renderer/features/install/InstallQueueTray';
import { UnmatchedList } from '@renderer/features/unmatched/UnmatchedList';
import { queryKeys } from '@renderer/query/keys';
import { useAssignUpdates, useFileMutations, useGames, useUpdates } from '@renderer/query/hooks';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Unmatched Updates tab (spec 13, Flow D). Files land here when the scanner
 * cannot attach them to a game; the user assigns them to a chosen game, deletes
 * them, or installs them straight to the Switch.
 */
export function UnmatchedPage() {
  const updates = useUpdates({ unmatchedOnly: true });
  const games = useGames({});
  const assign = useAssignUpdates();
  const files = useFileMutations();
  const queryClient = useQueryClient();
  const toast = useToast();
  const menu = useContextMenu();

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(new Set());
  const [targetGameId, setTargetGameId] = useState('');
  const [pendingDelete, setPendingDelete] = useState<InstallableUpdateDto[] | null>(null);
  const [installTargets, setInstallTargets] = useState<InstallableUpdateDto[] | null>(null);

  const rows = updates.data ?? [];
  const selectedRows = rows.filter((row) => selectedIds.has(row.id));
  const selectedUpdateIds = [...selectedIds].sort((left, right) => left - right);

  const toggle = (id: number) =>
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectOnly = (id: number) =>
    setSelectedIds((current) => (current.size === 1 && current.has(id) ? new Set() : new Set([id])));

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.updates({ unmatchedOnly: true }) });

  const assignSelected = () => {
    const gameId = Number(targetGameId);
    if (!targetGameId || selectedUpdateIds.length === 0) return;
    const count = selectedUpdateIds.length;
    assign.mutate(
      { gameId, updateIds: selectedUpdateIds },
      {
        onSuccess: () => {
          setSelectedIds(new Set());
          toast.success('Updates assigned', `${count} file(s) attached to the chosen game.`);
        },
        onError: (error) => toast.error('Could not assign the selected files', messageOf(error)),
      },
    );
  };

  const deleteSelected = async (targets: InstallableUpdateDto[]) => {
    let deleted = 0;
    for (const row of targets) {
      try {
        const result = await files.deleteFile.mutateAsync({ kind: 'update', updateId: row.id });
        if (result.deletedFromDisk) deleted += 1;
      } catch (error) {
        toast.error('Delete failed', messageOf(error));
        return;
      }
    }
    setSelectedIds(new Set());
    toast.success('Delete complete', `${deleted} file(s) removed.`);
  };

  const openMenu = (event: ReactMouseEvent<HTMLElement>, row: InstallableUpdateDto) => {
    if (!selectedIds.has(row.id)) selectOnly(row.id);
    const targets = selectedIds.has(row.id) ? selectedRows : [row];
    menu.open(event, [
      { label: 'Install selected update/DLC file(s)', onSelect: () => setInstallTargets(targets) },
      {
        label: 'Assign selected to chosen game',
        onSelect: assignSelected,
        disabled: !targetGameId,
      },
      {
        label: 'Delete selected update/DLC file(s)',
        danger: true,
        separatorBefore: true,
        onSelect: () => setPendingDelete(targets),
      },
    ]);
  };

  return (
    <>
      <div className="toolbar">
        <h1 className="unmatched__title">Unmatched Updates</h1>
        <Button onClick={() => void refresh()}>Refresh</Button>
        <select
          className="select unmatched__game-select"
          aria-label="Assign to game"
          value={targetGameId}
          onChange={(event) => setTargetGameId(event.target.value)}
        >
          <option value="">Assign to game…</option>
          {(games.data?.items ?? []).map((game) => (
            <option key={game.id} value={game.id}>
              {game.displayTitle}
            </option>
          ))}
        </select>
        <Button variant="primary" onClick={assignSelected} disabled={selectedIds.size === 0 || !targetGameId}>
          Assign Selected
        </Button>
        <Button onClick={() => setPendingDelete(selectedRows)} disabled={selectedIds.size === 0}>
          Delete selected
        </Button>
        <Button onClick={() => setInstallTargets(selectedRows)} disabled={selectedIds.size === 0}>
          Install selected
        </Button>
      </div>

      <div className="scroll-area">
        <ErrorText error={updates.error} />
        {updates.isLoading ? (
          <div className="stack">
            <Skeleton width="70%" />
            <Skeleton width="55%" />
            <Skeleton width="62%" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState>Everything is matched — no unmatched update or DLC files.</EmptyState>
        ) : (
          <UnmatchedList
            rows={rows}
            selectedIds={selectedIds}
            onToggle={toggle}
            onSelectOnly={selectOnly}
            onSelectAll={(selected) => setSelectedIds(selected ? new Set(rows.map((row) => row.id)) : new Set())}
            onOpenMenu={openMenu}
          />
        )}
        {assign.error ? <ErrorText error={assign.error} /> : null}
      </div>

      <div className="unmatched__tray">
        <InstallQueueTray />
      </div>

      {menu.element}

      {installTargets ? (
        <InstallDialog
          updateIds={installTargets.map((row) => row.id)}
          onClose={() => setInstallTargets(null)}
        />
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title="Delete update files"
          message={`Delete ${pendingDelete.length} selected update/DLC file(s) from disk and remove them from the catalog?\n\n${pendingDelete
            .map((row) => row.fileName)
            .join('\n')}`}
          confirmLabel="Delete"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const targets = pendingDelete;
            setPendingDelete(null);
            void deleteSelected(targets);
          }}
        />
      ) : null}
    </>
  );
}
