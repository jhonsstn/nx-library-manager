import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface SelectionValue {
  selectedGameId: number | null;
  selectGame: (gameId: number | null) => void;
}

const SelectionContext = createContext<SelectionValue | null>(null);

/**
 * Library and Grid share the selected game so "open in library" from the grid
 * keeps the same selection (spec 13, Flow C: selection stays stable).
 */
export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selectedGameId, selectGame] = useState<number | null>(null);
  const value = useMemo<SelectionValue>(() => ({ selectedGameId, selectGame }), [selectedGameId]);
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection(): SelectionValue {
  const context = useContext(SelectionContext);
  if (!context) throw new Error('useSelection must be used inside <SelectionProvider>.');
  return context;
}
