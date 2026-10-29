import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useAuth } from '../hooks/useAuth';

// Applies the signed-in user's Appearance settings (theme + accent) to the
// whole document. The preference lives on user.settings.appearance on the
// server, and is cached in localStorage so a reload paints the right theme
// before /auth/me comes back (no dark-to-light flash).

const ThemeContext = createContext(null);

const THEME_KEY = 'career_theme';
const ACCENT_KEY = 'career_accent';

export const ACCENT_GRADIENTS = {
  violet: 'linear-gradient(135deg,#8b5cf6 0%,#6366f1 45%,#3b82f6 100%)',
  pink: 'linear-gradient(135deg,#ec4899 0%,#a855f7 50%,#6366f1 100%)',
  indigo: 'linear-gradient(135deg,#6366f1 0%,#4f46e5 50%,#3b82f6 100%)',
  teal: 'linear-gradient(135deg,#14b8a6 0%,#06b6d4 50%,#3b82f6 100%)',
  amber: 'linear-gradient(135deg,#f59e0b 0%,#f97316 50%,#ef4444 100%)',
};

export function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return 'dark';
}

function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}
function read(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

export function applyThemeToDocument(pref) {
  document.documentElement.setAttribute('data-theme', resolveTheme(pref));
  store(THEME_KEY, pref);
}

export function applyAccentToDocument(accent) {
  document.documentElement.style.setProperty('--gradient', ACCENT_GRADIENTS[accent] || ACCENT_GRADIENTS.violet);
  store(ACCENT_KEY, accent);
}

export function ThemeProvider({ children }) {
  const { user } = useAuth();
  const [theme, setTheme] = useState(() => read(THEME_KEY, 'system'));
  const [accent, setAccent] = useState(() => read(ACCENT_KEY, 'violet'));

  // Apply the cached values immediately (before the user is loaded).
  useEffect(() => { applyThemeToDocument(theme); }, [theme]);
  useEffect(() => { applyAccentToDocument(accent); }, [accent]);

  // Adopt the server-stored preference whenever the user object changes.
  useEffect(() => {
    const appearance = user?.settings?.appearance;
    if (!appearance) return;
    if (appearance.theme) setTheme(appearance.theme);
    if (appearance.accent) setAccent(appearance.accent);
  }, [user]);

  // Follow the OS preference live while "system" is selected.
  useEffect(() => {
    if (theme !== 'system' || typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => applyThemeToDocument('system');
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else if (mq.removeListener) mq.removeListener(onChange);
    };
  }, [theme]);

  const setAppearance = useCallback((nextTheme, nextAccent) => {
    if (nextTheme) setTheme(nextTheme);
    if (nextAccent) setAccent(nextAccent);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, accent, setAppearance }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
};
