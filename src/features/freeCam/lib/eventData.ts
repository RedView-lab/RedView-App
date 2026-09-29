/** Marqueur ajouté aux events `move*` émis par la FreeCam (pour ne pas se resynchroniser sur soi-même). */
export const FREECAM_EVENT_DATA = { freeCam: true } as const;

export function isFreeCamEvent(event: object): boolean {
  return (event as { freeCam?: boolean }).freeCam === true;
}
