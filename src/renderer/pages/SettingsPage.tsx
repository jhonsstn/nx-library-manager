import { SettingsForm } from '@renderer/features/settings/SettingsForm';
import '../styles/settings.css';

/** Settings route: one scrolling page of panels (spec 12). */
export function SettingsPage() {
  return (
    <div className="scroll-area settings-page">
      <h1 className="settings-page__title">Settings</h1>
      <SettingsForm />
    </div>
  );
}
