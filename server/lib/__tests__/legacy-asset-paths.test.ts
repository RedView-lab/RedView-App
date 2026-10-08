import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveLegacyAssetPath } from '../legacy-asset-paths.mjs';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../public');
const existsInPublic = (urlPath: string) => fs.statSync(path.join(PUBLIC_DIR, urlPath), { throwIfNoEntry: false })?.isFile() === true;

describe('resolveLegacyAssetPath', () => {
  // URL que demandait le build d'avant le rangement de public/ (e1f879b) : un
  // onglet resté ouvert sur ce build doit encore recevoir chaque icône.
  const OLD_BUILD_URLS = [
    '/svgv2/icone/save-01.svg',
    '/svgv2/icone/Button utility.svg',
    '/svgv2/icone/itinerary-3d/start.svg',
    '/svgv2/poi/eau.svg',
    '/svgv2/poi/dropdown-maps/water.svg',
    '/svgv2/poi/favorites/bakery-favorite.svg',
    '/right-click-icons/start.svg',
    '/landing/svg/FR.svg',
    '/landing/icons/redview-logo.svg',
    '/project-browser/settings/display-dark.png',
    '/multiPOI.svg',
  ];

  it.each(OLD_BUILD_URLS)('%s → un fichier de public/', (oldUrl) => {
    const resolved = resolveLegacyAssetPath(oldUrl);
    expect(resolved).not.toBeNull();
    expect(existsInPublic(resolved!), `${oldUrl} → ${resolved}`).toBe(true);
  });

  it('chaque fichier des nouveaux dossiers reste joignable par son ancienne URL', () => {
    const pairs: Array<[string, string]> = [
      ['/svgv2/icone/', 'icons/ui'],
      ['/svgv2/poi/', 'icons/poi'],
      ['/right-click-icons/', 'icons/context-menu'],
      ['/landing/svg/', 'flags'],
      ['/landing/icons/', 'brand'],
      ['/project-browser/settings/', 'images/settings'],
    ];
    for (const [oldPrefix, dir] of pairs) {
      const files = fs.readdirSync(path.join(PUBLIC_DIR, dir), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(path.join(PUBLIC_DIR, dir), path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) expect(resolveLegacyAssetPath(oldPrefix + file)).toBe(`/${dir}/${file}`);
    }
  });

  it('laisse les chemins actuels et inconnus tels quels', () => {
    for (const current of ['/icons/ui/save-01.svg', '/flags/FR.svg', '/', '/assets/main.js', '/svgv2/icone/', '/svgv2', '/landing']) {
      expect(resolveLegacyAssetPath(current)).toBeNull();
    }
  });
});
