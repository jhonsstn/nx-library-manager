import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { SelectionProvider } from './SelectionProvider';
import { StatusBar } from '../components/StatusBar';
import { LibraryPage } from '../pages/LibraryPage';
import { GridPage } from '../pages/GridPage';
import { FavoritesPage } from '../pages/FavoritesPage';
import { UnmatchedPage } from '../pages/UnmatchedPage';
import { SettingsPage } from '../pages/SettingsPage';
import { StartupUpdateCheck } from './StartupUpdateCheck';
import { useUpdates } from '../query/hooks';

const NAV_ITEMS = [
  { to: '/library', label: 'Library' },
  { to: '/grid', label: 'Grid' },
  { to: '/favorites', label: 'Favorites' },
] as const;

/**
 * Application shell: persistent sidebar plus route content (spec 12). The
 * Unmatched entry only appears while unmatched files exist.
 */
export function App() {
  const unmatched = useUpdates({ unmatchedOnly: true });
  const unmatchedCount = unmatched.data?.length ?? 0;

  return (
    <SelectionProvider>
      <div className="app-shell">
        <nav className="sidebar" aria-label="Sections">
          <div className="sidebar__brand">Switch Game Catalog</div>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? 'sidebar__link is-active' : 'sidebar__link')}
            >
              {item.label}
            </NavLink>
          ))}
          {unmatchedCount > 0 ? (
            <NavLink
              to="/unmatched"
              className={({ isActive }) => (isActive ? 'sidebar__link is-active' : 'sidebar__link')}
            >
              Unmatched <span className="badge badge--review">{unmatchedCount}</span>
            </NavLink>
          ) : null}
          <NavLink
            to="/settings"
            className={({ isActive }) => (isActive ? 'sidebar__link is-active' : 'sidebar__link')}
          >
            Settings
          </NavLink>
          <div className="sidebar__footer">Local catalog for personal Switch files</div>
        </nav>

        <main className="app-content">
          <Routes>
            <Route path="/" element={<Navigate to="/library" replace />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/grid" element={<GridPage />} />
            <Route path="/favorites" element={<FavoritesPage />} />
            <Route path="/unmatched" element={<UnmatchedPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/library" replace />} />
          </Routes>
        </main>

        <StatusBar />
        <StartupUpdateCheck />
      </div>
    </SelectionProvider>
  );
}
