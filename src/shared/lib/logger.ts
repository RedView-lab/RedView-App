/**
 * RedView Centralised Structured Logger
 * 
 * Provides named loggers with consistent styling, level filtering,
 * and runtime toggle via window.setLogLevel() or localStorage.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export const LOG_LEVELS: Record<string, number> = Object.freeze({
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4,
});

const DEFAULT_DEV_LEVEL: LogLevel = 'info';
const DEFAULT_PROD_LEVEL: LogLevel = 'warn';

const STORAGE_KEY = 'RV_LOG_LEVEL';

function parseLogLevel(level: string | number | undefined | null): number {
  if (typeof level === 'number') {
    return Math.max(0, Math.min(4, Math.floor(level)));
  }
  if (typeof level === 'string') {
    const key = level.toUpperCase().trim();
    if (key in LOG_LEVELS) return LOG_LEVELS[key];
  }
  const isDev = Boolean(import.meta.env?.DEV);
  return isDev ? LOG_LEVELS[DEFAULT_DEV_LEVEL.toUpperCase()] : LOG_LEVELS[DEFAULT_PROD_LEVEL.toUpperCase()];
}

function getInitialLogLevel(): number {
  try {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return parseLogLevel(stored);
    }
  } catch {
    /* ignore storage errors */
  }
  const isDev = Boolean(import.meta.env?.DEV);
  return isDev ? LOG_LEVELS[DEFAULT_DEV_LEVEL.toUpperCase()] : LOG_LEVELS[DEFAULT_PROD_LEVEL.toUpperCase()];
}

let _currentLevel: number = getInitialLogLevel();

export interface ScopedLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  isDebug(): boolean;
  isInfo(): boolean;
}

const BADGE_COLORS: Record<string, string> = {
  Map3D: '#2563eb',     // Blue
  Weather: '#d97706',   // Amber
  BRouter: '#7c3aed',   // Purple
  LiDAR: '#059669',     // Emerald
  Projects: '#0891b2',  // Cyan
  Auth: '#db2777',      // Pink
  SW: '#4f46e5',        // Indigo
  App: '#475569',       // Slate
};

export function syncLogLevelToServiceWorker(levelStr: LogLevel): void {
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'SET_SW_LOG_LEVEL',
        level: levelStr,
      });
    }
  } catch {
    /* best-effort */
  }
}

export function setLogLevel(level: LogLevel): void {
  _currentLevel = parseLogLevel(level);
  try {
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, level.toLowerCase());
    }
  } catch {
    /* ignore storage error */
  }
  syncLogLevelToServiceWorker(level);
  console.info(
    `%c RedView Logger %c Log level changed to ${level.toUpperCase()}`,
    'background:#2563eb;color:#fff;font-weight:bold;padding:1px 5px;border-radius:3px;',
    'color:#94a3b8;font-style:italic;',
  );
}

export function getLogLevel(): LogLevel {
  for (const [name, val] of Object.entries(LOG_LEVELS)) {
    if (val === _currentLevel) return name.toLowerCase() as LogLevel;
  }
  return 'info';
}

export function createLogger(namespace: string, customColor?: string): ScopedLogger {
  const color = customColor || BADGE_COLORS[namespace] || '#475569';
  const badgeStyle = `background:${color};color:#ffffff;font-weight:bold;padding:1px 5px;border-radius:3px;font-size:10px;`;
  const resetStyle = '';

  const formatArgs = (args: unknown[]): unknown[] => {
    if (args.length === 0) return [`%c ${namespace} %c`, badgeStyle, resetStyle];
    if (typeof args[0] === 'string' && args[0].includes('%c')) {
      return [`%c ${namespace} %c ` + args[0], badgeStyle, resetStyle, ...args.slice(1)];
    }
    return [`%c ${namespace} %c`, badgeStyle, resetStyle, ...args];
  };

  return {
    isDebug(): boolean {
      return _currentLevel <= LOG_LEVELS.DEBUG;
    },
    isInfo(): boolean {
      return _currentLevel <= LOG_LEVELS.INFO;
    },
    debug(...args: unknown[]): void {
      if (_currentLevel > LOG_LEVELS.DEBUG) return;
      console.log(...formatArgs(args));
    },
    info(...args: unknown[]): void {
      if (_currentLevel > LOG_LEVELS.INFO) return;
      console.info(...formatArgs(args));
    },
    warn(...args: unknown[]): void {
      if (_currentLevel > LOG_LEVELS.WARN) return;
      console.warn(...formatArgs(args));
    },
    error(...args: unknown[]): void {
      if (_currentLevel > LOG_LEVELS.ERROR) return;
      console.error(...formatArgs(args));
    },
  };
}

// Global default loggers
export const logger = {
  map3d: createLogger('Map3D'),
  weather: createLogger('Weather'),
  brouter: createLogger('BRouter'),
  lidar: createLogger('LiDAR'),
  projects: createLogger('Projects'),
  auth: createLogger('Auth'),
  sw: createLogger('SW'),
  app: createLogger('App'),
};

// Expose helper on window for developer convenience
if (typeof window !== 'undefined') {
  (window as unknown as {
    setLogLevel: typeof setLogLevel;
    getLogLevel: typeof getLogLevel;
  }).setLogLevel = setLogLevel;
  (window as unknown as {
    setLogLevel: typeof setLogLevel;
    getLogLevel: typeof getLogLevel;
  }).getLogLevel = getLogLevel;
}
