import { useCallback, useEffect, useState, type ReactNode } from 'react';

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

interface OpenState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/**
 * Right-click menus used by the library, grid and update lists. Keyboard users
 * get the same actions through the row detail buttons, so this stays a pointer
 * affordance rather than the only path to an action.
 */
export function useContextMenu(): {
  open: (event: { clientX: number; clientY: number; preventDefault: () => void }, items: ContextMenuItem[]) => void;
  element: ReactNode;
} {
  const [state, setState] = useState<OpenState | null>(null);

  const close = useCallback(() => setState(null), []);

  useEffect(() => {
    if (!state) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [state, close]);

  const open = useCallback((event: { clientX: number; clientY: number; preventDefault: () => void }, items: ContextMenuItem[]) => {
    event.preventDefault();
    setState({ x: event.clientX, y: event.clientY, items });
  }, []);

  const element = state ? (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onMouseDown={close} onContextMenu={(event) => event.preventDefault()} />
      <div
        className="context-menu"
        role="menu"
        style={{
          left: Math.min(state.x, Math.max(0, window.innerWidth - 240)),
          top: Math.min(state.y, Math.max(0, window.innerHeight - state.items.length * 32 - 16)),
        }}
      >
        {state.items.map((item) => (
          <div key={item.label}>
            {item.separatorBefore ? <div className="context-menu__separator" /> : null}
            <button
              type="button"
              role="menuitem"
              className={item.danger ? 'context-menu__item context-menu__item--danger' : 'context-menu__item'}
              disabled={item.disabled}
              onClick={() => {
                close();
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>
    </>
  ) : null;

  return { open, element };
}
