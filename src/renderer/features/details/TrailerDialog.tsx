import { youtubeEmbedUrl, youtubePlayerUrl } from '@shared/format/images';
import { getCatalogApi } from '@renderer/api';
import { Button } from '@renderer/components/Button';
import { Modal } from '@renderer/components/Modal';
import { useToast } from '@renderer/components/Toast';

export interface TrailerDialogProps {
  url: string;
  onClose: () => void;
}

/**
 * Trailer playback for the selected game. Ports `ui.open_trailer`: the Qt build
 * embedded a web view, so the trailer plays inside a dialog and the renderer
 * itself is never navigated. Opening the browser goes through the main process
 * (`app.openExternal`).
 */
export function TrailerDialog({ url, onClose }: TrailerDialogProps) {
  const toast = useToast();

  const openInBrowser = async () => {
    try {
      await getCatalogApi().app.openExternal(youtubePlayerUrl(url));
    } catch (error) {
      toast.error('Could not open the trailer', error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Modal
      title="Trailer"
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={() => void openInBrowser()}>Open in browser</Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="stack">
        <iframe
          className="trailer-frame"
          src={youtubeEmbedUrl(url)}
          title="Trailer"
          allow="accelerometer; autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
        />
        <span className="details__path">{youtubePlayerUrl(url)}</span>
        <span className="dim">If the trailer does not play here, use “Open in browser”.</span>
      </div>
    </Modal>
  );
}
