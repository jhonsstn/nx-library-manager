import { useEffect, useRef, useState } from 'react';
import { DEFAULT_ART_SIZE, GameGrid, MAX_ART_SIZE, MIN_ART_SIZE } from '@renderer/features/grid/GameGrid';
import { useSettings, useUpdateSettings } from '@renderer/query/hooks';

/**
 * Grid route: windowed cover grid plus the "Art size" slider from
 * `ui._grid_tab`. The slider is local state so dragging stays responsive; the
 * value is persisted to settings when the interaction ends.
 */
export function GridPage() {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const [artSize, setArtSize] = useState(DEFAULT_ART_SIZE);
  const adjusted = useRef(false);
  const persistedRef = useRef(DEFAULT_ART_SIZE);

  const storedSize = settings.data?.gridCoverSize;
  useEffect(() => {
    if (adjusted.current) return;
    if (storedSize === undefined) return;
    if (storedSize < MIN_ART_SIZE || storedSize > MAX_ART_SIZE) return;
    persistedRef.current = storedSize;
    setArtSize(storedSize);
  }, [storedSize]);

  const persist = () => {
    if (persistedRef.current === artSize) return;
    persistedRef.current = artSize;
    updateSettings.mutate({ gridCoverSize: artSize });
  };

  return (
    <div className="pane-column">
      <div className="toolbar">
        <label className="field__label" htmlFor="grid-art-size">
          Art size
        </label>
        <input
          id="grid-art-size"
          className="range grid-toolbar__range"
          type="range"
          min={MIN_ART_SIZE}
          max={MAX_ART_SIZE}
          step={1}
          value={artSize}
          onChange={(event) => {
            adjusted.current = true;
            setArtSize(Number(event.target.value));
          }}
          onPointerUp={persist}
          onKeyUp={persist}
          onBlur={persist}
        />
        <span className="grid-toolbar__size" aria-live="polite">
          {artSize} px
        </span>
      </div>
      <GameGrid artSize={artSize} />
    </div>
  );
}
