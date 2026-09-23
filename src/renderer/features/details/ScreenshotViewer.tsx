import { useEffect, useState } from 'react';
import type { ScreenshotDto } from '@shared/types/domain';
import { Button } from '@renderer/components/Button';
import { Modal } from '@renderer/components/Modal';

export interface ScreenshotViewerProps {
  screenshots: ScreenshotDto[];
  /** Index the viewer opens on; navigation is kept local to the dialog. */
  initialIndex: number;
  onClose: () => void;
}

/**
 * Full-size screenshot preview with previous/next navigation, porting the Qt
 * `ImagePreviewDialog`. Cached (`catalog-image://`) or remote URLs come from
 * `displayUrl` so the renderer never touches the filesystem itself.
 */
export function ScreenshotViewer({ screenshots, initialIndex, onClose }: ScreenshotViewerProps) {
  const [index, setIndex] = useState(initialIndex);
  const total = screenshots.length;

  useEffect(() => {
    if (index > total - 1) setIndex(Math.max(0, total - 1));
  }, [index, total]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') setIndex((current) => (current - 1 + total) % total);
      else if (event.key === 'ArrowRight') setIndex((current) => (current + 1) % total);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [total]);

  const current = screenshots[Math.min(index, Math.max(0, total - 1))];
  if (!current) return null;

  return (
    <Modal
      title="Screenshots"
      wide
      onClose={onClose}
      footer={
        <>
          <Button
            aria-label="Previous screenshot"
            disabled={total < 2}
            onClick={() => setIndex((value) => (value - 1 + total) % total)}
          >
            Previous
          </Button>
          <span className="muted" aria-live="polite">
            {index + 1} / {total}
          </span>
          <Button
            aria-label="Next screenshot"
            disabled={total < 2}
            onClick={() => setIndex((value) => (value + 1) % total)}
          >
            Next
          </Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <figure className="screenshot-viewer">
        <img src={current.displayUrl} alt={`Screenshot ${index + 1} of ${total}`} />
        <figcaption className="dim">Image {index + 1} of {total}</figcaption>
      </figure>
    </Modal>
  );
}
