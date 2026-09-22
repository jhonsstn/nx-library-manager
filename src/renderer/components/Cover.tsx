import { useEffect, useState } from 'react';

export interface CoverProps {
  src: string | null | undefined;
  alt: string;
  favorite?: boolean;
  className?: string;
}

/** Cover art with a graceful placeholder, since caches can be empty offline. */
export function Cover({ src, alt, favorite, className }: CoverProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  if (!src || failed) {
    return (
      <div className={`cover cover--placeholder ${className ?? ''}`.trim()} aria-label={`${alt} (no cover art)`}>
        No cover art
      </div>
    );
  }
  return (
    <img
      className={`cover ${className ?? ''}`.trim()}
      src={src}
      alt={alt}
      loading="lazy"
      style={favorite ? { borderColor: 'var(--favorite)', boxShadow: 'inset 0 0 0 2px var(--favorite)' } : undefined}
      onError={() => setFailed(true)}
    />
  );
}
