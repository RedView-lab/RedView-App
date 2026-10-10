/**
 * Fuseau IANA d'une position de la carte, résolu hors ligne à partir de
 * polygones de fuseaux simplifiés (@photostructure/tz-lookup, CC0). La table
 * d'~70 Ko est chargée au premier usage pour rester hors des bundles d'entrée.
 *
 * Les fonctions solaires expriment date et heure à l'horloge du lieu affiché,
 * pas de la machine qui fait tourner le navigateur : un lever de soleil à
 * Londres ne doit pas se lire à l'heure de Paris parce que l'utilisateur se
 * trouve à Paris.
 */

type TzLookup = (latitude: number, longitude: number) => string;

let lookupPromise: Promise<TzLookup | null> | null = null;
/** Table chargée : lecture synchrone pour les calculs d'horaires (cf. timeZoneAtSync). */
let loadedLookup: TzLookup | null = null;

function loadLookup(): Promise<TzLookup | null> {
  lookupPromise ??= import('@photostructure/tz-lookup')
    .then((mod) => {
      loadedLookup = mod.default;
      return mod.default;
    })
    .catch((error: unknown) => {
      console.warn('[timeZoneAt] time-zone table unavailable', error);
      lookupPromise = null; // nouvel essai au prochain appel
      return null;
    });
  return lookupPromise;
}

/** Ramène une longitude dans [-180, 180] (Mapbox renvoie des copies du monde au-delà). */
function wrapLongitude(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * Fuseau IANA en (lng, lat), p. ex. « Europe/London » — « Etc/GMT±N » en mer.
 * Résout null quand les coordonnées sont invalides ou que la table n'a pas pu
 * être chargée ; les appelants gardent leur propre repli.
 */
export async function resolveTimeZoneAt(lng: number, lat: number): Promise<string | null> {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  const lookup = await loadLookup();
  if (!lookup) return null;
  try {
    return lookup(lat, wrapLongitude(lng));
  } catch {
    return null;
  }
}

/** Charge la table des fuseaux en arrière-plan (cf. timeZoneAtSync). */
export async function preloadTimeZoneTable(): Promise<void> {
  await loadLookup();
}

/**
 * Fuseau IANA en (lng, lat) sans attendre : null tant que la table n'est pas
 * chargée (preloadTimeZoneTable) ou pour des coordonnées invalides. Pour les
 * calculs synchrones (horaires de passage, exports), qui gardent alors le
 * fuseau du navigateur.
 */
export function timeZoneAtSync(lng: number, lat: number): string | null {
  if (!loadedLookup || !Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  try {
    return loadedLookup(lat, wrapLongitude(lng));
  } catch {
    return null;
  }
}
