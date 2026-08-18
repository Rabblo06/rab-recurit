export type Theme = 'light' | 'dark';

const KEY = 'theme';

export function getTheme(): Theme {
  return (localStorage.getItem(KEY) as Theme) || 'light';
}

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(KEY, theme);
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'light' ? 'dark' : 'light';
  applyTheme(next);
  return next;
}

export function initTheme() {
  applyTheme(getTheme());
}
