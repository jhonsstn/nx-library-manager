import { useId } from 'react';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

interface FieldShellProps {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

export function FieldShell({ label, hint, error, children }: FieldShellProps) {
  return (
    <div className="field">
      <label className="field__label">
        {label}
        {children}
      </label>
      {hint ? <span className="dim">{hint}</span> : null}
      {error ? <span className="field__error">{error}</span> : null}
    </div>
  );
}

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function TextField({ label, hint, error, ...rest }: TextFieldProps) {
  return (
    <FieldShell label={label} hint={hint} error={error}>
      <input className="input" {...rest} />
    </FieldShell>
  );
}

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  hint?: string;
  options: Array<{ value: string; label: string }>;
}

export function SelectField({ label, hint, options, ...rest }: SelectFieldProps) {
  return (
    <FieldShell label={label} hint={hint}>
      <select className="select" {...rest}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export interface CheckboxFieldProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  disabled?: boolean;
}

export function CheckboxField({ label, checked, onChange, hint, disabled }: CheckboxFieldProps) {
  return (
    <div className="field">
      <label className="checkbox">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
      {hint ? <span className="dim">{hint}</span> : null}
    </div>
  );
}

export interface FolderFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBrowse: () => void;
  displayValue?: string;
  hint?: string;
  disabled?: boolean;
  browseLabel?: string;
}

/** Text input plus a Browse button; the path itself is validated in main. */
export function FolderField({
  label,
  value,
  onChange,
  onBrowse,
  displayValue,
  hint,
  disabled,
  browseLabel = 'Browse',
}: FolderFieldProps) {
  const inputId = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      <div className="field__row">
        <input
          id={inputId}
          className="input"
          value={displayValue ?? value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          spellCheck={false}
        />
        <button type="button" className="btn" onClick={onBrowse} disabled={disabled}>
          {browseLabel}
        </button>
      </div>
      {hint ? <span className="dim">{hint}</span> : null}
    </div>
  );
}
