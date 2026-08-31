// ---------------------------------------------------------------------------
// Service Worker DEM — Centralised Structured Logger
// ---------------------------------------------------------------------------

const SW_LOG_LEVELS = Object.freeze({
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4,
});

const SW_BADGE_COLORS = Object.freeze({
  build: '#2563eb',     // Blue
  'build-hr': '#3b82f6',// Lighter blue
  dispatch: '#64748b',  // Slate
  swiss: '#dc2626',     // Red
  spain: '#ea580c',     // Orange
  norway: '#16a34a',    // Green
  slope: '#9333ea',     // Purple
  altitude: '#0284c7',  // Sky
  health: '#ca8a04',    // Gold
  ortho: '#0d9488',     // Teal
  aws: '#d97706',       // Amber
  queue: '#475569',     // Gray
  upgrade: '#4f46e5',   // Indigo
  lifecycle: '#059669', // Emerald
});

let _currentSwLogLevel = SW_LOG_LEVELS.WARN; // Default to WARN (quiet in normal operation)

function parseSwLogLevel(level) {
  if (typeof level === 'number') return Math.max(0, Math.min(4, level));
  if (typeof level === 'string') {
    const upper = level.toUpperCase().trim();
    if (upper in SW_LOG_LEVELS) return SW_LOG_LEVELS[upper];
  }
  return SW_LOG_LEVELS.WARN;
}

function formatSwBadge(subsystem) {
  const color = SW_BADGE_COLORS[subsystem] || '#475569';
  return [`%c sw-dem:${subsystem} %c`, `background:${color};color:#ffffff;font-weight:bold;padding:1px 5px;border-radius:3px;font-size:10px;`, ''];
}

const swLog = {
  LEVELS: SW_LOG_LEVELS,

  setLevel(level) {
    _currentSwLogLevel = parseSwLogLevel(level);
  },

  getLevel() {
    return _currentSwLogLevel;
  },

  isDebug() {
    return _currentSwLogLevel <= SW_LOG_LEVELS.DEBUG;
  },

  debug(subsystem, ...args) {
    if (_currentSwLogLevel > SW_LOG_LEVELS.DEBUG) return;
    const [tag, style, reset] = formatSwBadge(subsystem);
    if (typeof args[0] === 'string' && args[0].includes('%c')) {
      console.log(`%c sw-dem:${subsystem} %c ` + args[0], style, reset, ...args.slice(1));
    } else {
      console.log(tag, style, reset, ...args);
    }
  },

  info(subsystem, ...args) {
    if (_currentSwLogLevel > SW_LOG_LEVELS.INFO) return;
    const [tag, style, reset] = formatSwBadge(subsystem);
    if (typeof args[0] === 'string' && args[0].includes('%c')) {
      console.info(`%c sw-dem:${subsystem} %c ` + args[0], style, reset, ...args.slice(1));
    } else {
      console.info(tag, style, reset, ...args);
    }
  },

  warn(subsystem, ...args) {
    if (_currentSwLogLevel > SW_LOG_LEVELS.WARN) return;
    const [tag, style, reset] = formatSwBadge(subsystem);
    if (typeof args[0] === 'string' && args[0].includes('%c')) {
      console.warn(`%c sw-dem:${subsystem} %c ` + args[0], style, reset, ...args.slice(1));
    } else {
      console.warn(tag, style, reset, ...args);
    }
  },

  error(subsystem, ...args) {
    if (_currentSwLogLevel > SW_LOG_LEVELS.ERROR) return;
    const [tag, style, reset] = formatSwBadge(subsystem);
    console.error(tag, style, reset, ...args);
  },
};
