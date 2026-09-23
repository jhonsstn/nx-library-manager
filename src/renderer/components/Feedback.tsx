import type { ReactNode } from 'react';
import { SwitchCatalogError } from '@shared/errors/app-error';

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row">
      <span className="spinner" aria-hidden="true" />
      {label ? <span className="muted">{label}</span> : null}
    </span>
  );
}

export function Skeleton({ width = '100%', height = 14 }: { width?: string | number; height?: number }) {
  return <div className="skeleton" style={{ width, height }} aria-hidden="true" />;
}

export function ProgressBar({ value, max = 1 }: { value: number; max?: number }) {
  const percent = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <div className="progress__bar" style={{ width: `${percent}%` }} />
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

/** Renders a failure with its stable code so support can act on it. */
export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  if (error instanceof SwitchCatalogError) {
    return (
      <p className="error-text">
        {error.message} <span className="dim">({error.code})</span>
      </p>
    );
  }
  return <p className="error-text">{error instanceof Error ? error.message : String(error)}</p>;
}
