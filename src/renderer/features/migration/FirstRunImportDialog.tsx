import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getCatalogApi } from '@renderer/api';
import { Button } from '@renderer/components/Button';
import { ErrorText } from '@renderer/components/Feedback';
import { Modal } from '@renderer/components/Modal';
import { useToast } from '@renderer/components/Toast';
import { catalogKeysToInvalidate, queryKeys } from '@renderer/query/keys';
import { useLegacyDataInfo, useSettings } from '@renderer/query/hooks';

/**
 * First-run migration prompt (spec 13, Flow A). Deliberately modal and not
 * dismissible: the user either imports the old catalog or starts fresh, and the
 * original data is never moved or deleted either way.
 */
export function FirstRunImportDialog() {
  const legacy = useLegacyDataInfo();
  const settings = useSettings();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const info = legacy.data;
  const dismissed = settings.data?.legacyImportDismissed;
  if (!info?.found || dismissed !== false) return null;

  const run = async (action: 'import' | 'skip') => {
    setBusy(true);
    setError(null);
    try {
      const next =
        action === 'import'
          ? await getCatalogApi().app.importLegacyData()
          : await getCatalogApi().app.skipLegacyImport();
      queryClient.setQueryData(queryKeys.settings(), next);
      await queryClient.invalidateQueries({ queryKey: queryKeys.legacyDataInfo() });
      for (const key of catalogKeysToInvalidate()) await queryClient.invalidateQueries({ queryKey: key });
      toast.success(
        action === 'import' ? 'Existing data imported' : 'Starting fresh',
        action === 'import'
          ? 'Copied from the previous installation — the original files were left untouched.'
          : 'The catalog stays empty until you scan a folder.',
      );
    } catch (thrown) {
      setError(thrown);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Existing Switch Game Catalog data found"
      onClose={() => undefined}
      footer={
        <>
          <Button onClick={() => void run('skip')} disabled={busy}>
            Start Fresh
          </Button>
          <Button variant="primary" onClick={() => void run('import')} disabled={busy}>
            Import Existing Data
          </Button>
        </>
      }
    >
      <p className="panel__hint">
        A previous installation was found in <span className="mono">{info.sourceDirectory}</span>. Import its catalog to
        keep your library, favorites and manual matches — no rescan needed.
      </p>
      <ul className="list">
        <li className="list__item list__item--static">
          <span className="list__title">Games</span>
          <span>{info.games}</span>
        </li>
        <li className="list__item list__item--static">
          <span className="list__title">Updates/DLC</span>
          <span>{info.updates}</span>
        </li>
        <li className="list__item list__item--static">
          <span className="list__title">Favorites</span>
          <span>{info.favorites}</span>
        </li>
      </ul>
      <p className="dim">Importing copies the old data. The original Switch Game Catalog files are left untouched.</p>
      <ErrorText error={error} />
      <ErrorText error={legacy.error} />
    </Modal>
  );
}
