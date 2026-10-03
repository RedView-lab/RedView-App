export const RAIL_ITEM_HEIGHT_PX = 32;
export const BASE_HOUR_ROW_HEIGHT_PX = 96;
export const DEFAULT_START_MINUTES = 8 * 60;
export const DAY_WINDOW_DAYS = 6;
export const KM_MARKER_MIN_STEP = 25;
export const MIN_RENDER_DURATION_MIN = 15;
export const MINUTES_PER_DAY = 24 * 60;
export const ATTACHED_PAUSE_HEIGHT_PX = 24;
export const PAUSE_CHIP_MIN_HEIGHT_PX = 28;
export const TIMELINE_BLOCK_GAP_PX = 4;
export const TIMELINE_VIEWPORT_TOP_INSET_PX = 10;
export const TIMELINE_VIEWPORT_BOTTOM_INSET_PX = 10;

/* Largeur d'une carte (= d'une colonne-jour) → densité de la carte, cf.
 * `.rvi-tl-schedule[data-density]` dans _schedule.css. La vue 6 jours n'est
 * prise que si chaque colonne garde CARD_COMPACT_MIN_WIDTH_PX ; sinon 1 jour,
 * dont la carte est plafonnée à SINGLE_DAY_CARD_MAX_WIDTH_PX (même valeur que
 * `--rvi-tl-card-max-width`). Rail = zoom vertical + heures + bordures. */
export const SCHEDULE_RAIL_WIDTH_PX = 74;
export const CARD_REGULAR_MIN_WIDTH_PX = 440;
export const CARD_COMPACT_MIN_WIDTH_PX = 260;
export const SINGLE_DAY_CARD_MAX_WIDTH_PX = 600;
/* Nom de carte sur plusieurs lignes quand la carte est haute (longue pause attachée). */
export const CARD_NAME_LINE_HEIGHT_PX = 18;
export const CARD_NAME_MAX_LINES = 3;

export const WEEKDAY_SHORT = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'] as const;
export const WEEKDAY_SHORT_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;