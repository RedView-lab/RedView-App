import mapboxgl from 'mapbox-gl';

/**
 * `Map#getSource` / `Map#getLayer` sans style chargé.
 *
 * Mapbox GL (3.21) les écrit `this.style.getOwnSource(id)` /
 * `this.style.getOwnLayer(id)` : tant que le style n'a jamais été posé — sa
 * requête a échoué (panne ou blocage de api.mapbox.com, proxy d'entreprise,
 * jeton refusé ou absent) — `style` est `undefined` et l'appel lève. Les
 * appelants de l'app (commentaires, opacité des calques du panneau droit…)
 * testent l'existence d'une source ou d'un calque avant d'agir, comme le
 * prévoit le contrat de ces méthodes (« undefined si introuvable ») : sans
 * style, une simple lecture faisait tomber tout l'éditeur sur la limite
 * d'erreur (« Anomalie d'affichage 3D ») dès l'import d'une trace, trouvé par
 * l'E2E du parcours principal sans jeton Mapbox.
 *
 * Le correctif rend ce contrat vrai sans style : `undefined`. La carte reste
 * vide (le contrôleur du style réessaie, useMap/controller), l'éditeur
 * reste utilisable.
 */

interface StyleLessMap {
  style?: unknown;
  getSource?: (id: string) => unknown;
  getLayer?: (id: string) => unknown;
}

let installed = false;

/** Patche `mapboxgl.Map` une fois ; à appeler avant de créer une carte. */
export function installStyleLessMapGuards(): void {
  if (installed) return;
  installed = true;
  const proto = mapboxgl.Map.prototype as unknown as StyleLessMap;
  for (const method of ['getSource', 'getLayer'] as const) {
    const original = proto[method];
    if (typeof original !== 'function') {
      console.warn(`[map3d] Map#${method} introuvable : lecture sans style non protégée`);
      continue;
    }
    proto[method] = function guarded(this: StyleLessMap, id: string) {
      if (!this.style) return undefined;
      return original.call(this, id);
    };
  }
}
