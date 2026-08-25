import { useState } from 'react';
import { IconCheck } from '@tabler/icons-react';
import { applyTheme, getTheme, type Theme } from '../../../shared/lib/theme';

const OPTIONS: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System setting' },
];

export default function AppearanceSection() {
  const [theme, setTheme] = useState<Theme>(getTheme());

  function select(value: Theme) {
    applyTheme(value);
    setTheme(value);
  }

  return (
    <div className="settings-section">
      <h3>Appearance</h3>
      <p>Select or customize your interface.</p>
      <div className="theme-card-grid">
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`theme-card${theme === opt.value ? ' selected' : ''}`}
            onClick={() => select(opt.value)}
          >
            <div className={`theme-card-preview theme-preview-${opt.value}`} />
            <span className="theme-card-label">
              {theme === opt.value && <IconCheck size={12} />}
              {opt.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
