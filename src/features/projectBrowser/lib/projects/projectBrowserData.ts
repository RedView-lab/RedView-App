/**
 * Constants for the Project Browser overlay.
 *
 * The mock card list ("fake projects") used to live here. Real projects
 * now come from Supabase via `src/lib/projects.ts`; this inline SVG stays
 * as a local fallback when a project thumbnail is missing or broken.
 */
export const PROJECT_BROWSER_PREVIEW_URL = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" fill="none">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="640" y2="360" gradientUnits="userSpaceOnUse">
        <stop stop-color="#2a2a2a"/>
        <stop offset="1" stop-color="#111111"/>
      </linearGradient>
      <linearGradient id="ridge" x1="320" y1="88" x2="320" y2="292" gradientUnits="userSpaceOnUse">
        <stop stop-color="#525252" stop-opacity="0.95"/>
        <stop offset="1" stop-color="#242424" stop-opacity="1"/>
      </linearGradient>
    </defs>
    <rect width="640" height="360" fill="url(#bg)"/>
    <circle cx="494" cy="92" r="38" fill="#d54234" fill-opacity="0.88"/>
    <path d="M0 282L110 224L186 250L276 158L344 213L424 144L526 211L640 168V360H0V282Z" fill="url(#ridge)"/>
    <path d="M0 303L88 267L165 292L256 224L339 251L436 188L542 249L640 214V360H0V303Z" fill="#191919" fill-opacity="0.92"/>
    <rect x="38" y="38" width="152" height="18" rx="9" fill="#ffffff" fill-opacity="0.12"/>
    <rect x="38" y="68" width="118" height="12" rx="6" fill="#ffffff" fill-opacity="0.08"/>
  </svg>`,
)}`;
