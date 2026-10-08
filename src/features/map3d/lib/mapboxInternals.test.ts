import bundle from 'mapbox-gl/dist/mapbox-gl.js?raw';
import mapboxPackage from 'mapbox-gl/package.json';
import { describe, expect, it } from 'vitest';

import packageJson from '../../../../package.json';

/**
 * Garde des API privées de Mapbox GL JS.
 *
 * L'app s'appuie sur des membres internes (préfixe `_`, ou sans API publique)
 * que Mapbox peut renommer dans n'importe quelle version mineure. La CI tourne
 * sans jeton Mapbox : aucun test de bout en bout n'afficherait la carte. Ce test
 * lit le bundle réellement chargé par l'app et casse dès qu'un de ces membres
 * disparaît. À une montée de version de mapbox-gl : relancer ce test, vérifier
 * chaque usage listé ci-dessous, puis seulement changer la version épinglée.
 */
const PRIVATE_MEMBERS: Record<string, string> = {
  _requestRenderFrame: 'livePresence/engine/FollowController.ts — caméra suivie dans la file de rendu',
  _updateContainerDimensions: 'map3d/lib/mapContainerZoom.ts — correction du zoom CSS du canevas',
  _preloadTiles: 'centerPanel/flyover/video/videoMap.ts — préchargement des tuiles de la vidéo',
  _reloadTile: 'altitude/lib/altitude-dem-source.ts — rechargement des tuiles altitude périmées',
  _triggerFrame: 'centerPanel/flyover/video/videoMap.ts — boucle de rendu pilotée par l’export',
  _order: 'itineraryPanel/lib/route-layer/itineraryLayers.ts — ordre des calques du style',
  _evaluateOpacity: 'src/index.css (.rvi-analysis-hover-dot) — réécrit le pointer-events des marqueurs, compensé par !important',
  _cache: 'centerPanel/flyover/video/videoMap.ts — cache de tuiles des sources',
  _tiles: 'videoMap.ts, altitude-dem-source.ts — tuiles chargées d’une source',
};

describe('API privées de mapbox-gl utilisées par l’app', () => {
  it('la version installée est celle épinglée dans package.json', () => {
    const installed = mapboxPackage.version;
    const declared: Record<string, string> = { ...packageJson.dependencies, ...packageJson.devDependencies };
    expect(declared['mapbox-gl']).toBe(installed);
  });

  it.each(Object.entries(PRIVATE_MEMBERS))('%s existe toujours (%s)', (member) => {
    expect(new RegExp(`\\b${member}\\b`).test(bundle)).toBe(true);
  });

  it('transform.fov reste un accesseur (FOV du flyover, du suivi et de la vidéo)', () => {
    expect(bundle).toContain('get fov()');
    expect(bundle).toContain('set fov(');
  });
});
