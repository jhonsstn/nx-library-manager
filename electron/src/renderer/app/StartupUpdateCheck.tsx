import { useEffect, useRef } from 'react';
import { getCatalogApi } from '../api';
import { useSettings } from '../query/hooks';
import { useToast } from '../components/Toast';

/**
 * Startup update check (spec 15: "query latest GitHub release; compare semantic
 * versions; notify user; open release page"). Runs at most once per session and
 * never blocks startup or an active install.
 */
export function StartupUpdateCheck() {
  const settings = useSettings();
  const toast = useToast();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    if (!settings.data?.autoCheckUpdatesOnStartup) return;
    ran.current = true;

    void (async () => {
      try {
        const info = await getCatalogApi().app.checkForUpdates();
        if (!info.updateAvailable) return;
        toast.info(
          `${info.releaseName} is available`,
          `Installed: v${info.currentVersion}\nLatest: ${info.latestVersion}`,
        );
      } catch {
        // A silent startup check must never interrupt the user (spec 15).
      }
    })();
  }, [settings.data?.autoCheckUpdatesOnStartup, toast]);

  return null;
}
