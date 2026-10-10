import { describe, expect, it } from 'vitest';

import {
  buildGpsPoiName,
  formatOpeningIntervals,
  formatRouteOffset,
  gpsCategoryCode,
  hasHandwrittenHours,
  type GpsPoiNameInput,
} from './gpsNames';

const h = (hours: number, minutes = 0) => hours * 60 + minutes;

function poi(input: Partial<GpsPoiNameInput>): GpsPoiNameInput {
  return {
    lateralM: 10,
    side: 'left',
    openingIntervals: null,
    placeName: null,
    editedName: null,
    ...input,
  };
}

describe('convention de nommage GPS', () => {
  it('les exemples de la convention', () => {
    expect(buildGpsPoiName(poi({ featureCategory: 'drinking_water', lateralM: 10, side: 'left' }), 'fr')).toBe('EAU_G10');
    expect(buildGpsPoiName(poi({ featureCategory: 'supermarket', lateralM: 20, side: 'right' }), 'fr')).toBe('SUP_D20');
    expect(buildGpsPoiName(poi({ featureCategory: 'hotel', lateralM: 11, side: 'left', placeName: 'Hôtel de la Gare' }), 'fr'))
      .toBe('HOT_G11_Hôtel de la Gare');
    expect(buildGpsPoiName(poi({ featureCategory: 'restaurant', lateralM: 2.4, side: 'right', placeName: 'Le Bon Coin' }), 'fr'))
      .toBe('RES_D02_Le Bon Coin');
    expect(buildGpsPoiName(poi({
      featureCategory: 'bakery',
      lateralM: 3,
      side: 'right',
      openingIntervals: [{ start: h(7), end: h(19) }],
      placeName: 'La Mie Câline',
    }), 'fr')).toBe('BOU_D03_7-19_La Mie Câline');
  });

  it('en anglais : codes et côtés anglais (L / R)', () => {
    expect(buildGpsPoiName(poi({ featureCategory: 'fountain', side: 'left' }), 'en')).toBe('WAT_L10');
    expect(buildGpsPoiName(poi({ featureCategory: 'bakery', side: 'right', placeName: 'Paul', openingIntervals: [] }), 'en'))
      .toBe('BAK_R10_closed_Paul');
  });

  it('pas de nom propre pour l’eau ou les toilettes, sauf saisi à la main', () => {
    expect(buildGpsPoiName(poi({ featureCategory: 'fountain', placeName: 'Fontaine Saint-Jean' }), 'fr')).toBe('EAU_G10');
    expect(buildGpsPoiName(poi({ featureCategory: 'toilets', editedName: 'Cimetière' }), 'fr')).toBe('TOI_G10_Cimetière');
  });

  it('le nom saisi remplace celui du commerce ; ses horaires écrits à la main priment', () => {
    const bakery = poi({
      featureCategory: 'bakery',
      side: 'right',
      lateralM: 3,
      openingIntervals: [{ start: h(6, 30), end: h(13) }],
      placeName: 'Boulangerie Dupont',
    });
    expect(buildGpsPoiName({ ...bakery, editedName: 'Dupont' }, 'fr')).toBe('BOU_D03_6.30-13_Dupont');
    expect(buildGpsPoiName({ ...bakery, editedName: '7-19_Dupont' }, 'fr')).toBe('BOU_D03_7-19_Dupont');
  });

  it('une adresse ou une plage de kilomètres dans le nom saisi ne passe pas pour des horaires (B2-2)', () => {
    for (const name of ['Dupont 7-19', '8h30-12h Dupont', 'Dupont 22-2', 'Fermé lundi', 'Dupont 24h']) {
      expect(hasHandwrittenHours(name), name).toBe(true);
    }
    for (const name of ['Boulangerie 12-14 rue', 'Km 120-125', 'Route 7-9', 'Dupont, D 9-10', 'Lot 3-5 av. Foch']) {
      expect(hasHandwrittenHours(name), name).toBe(false);
    }
    const bakery = poi({ featureCategory: 'bakery', side: 'left', lateralM: 3, openingIntervals: [{ start: h(7), end: h(19) }] });
    expect(buildGpsPoiName({ ...bakery, editedName: 'Boulangerie 12-14 rue' }, 'fr')).toBe('BOU_G03_7-19_Boulangerie 12-14 rue');
  });

  it('« 24h » seulement pour un commerce', () => {
    const always = [{ start: 0, end: h(24) }];
    expect(buildGpsPoiName(poi({ featureCategory: 'drinking_water', openingIntervals: always }), 'fr')).toBe('EAU_G10');
    expect(buildGpsPoiName(poi({ featureCategory: 'fuel', side: 'right', lateralM: 40, openingIntervals: always, placeName: 'Total' }), 'fr'))
      .toBe('STA_D40_24h_Total');
  });

  it('repli sur la ligne du panneau quand la catégorie OSM est inconnue', () => {
    expect(gpsCategoryCode(undefined, 'fountains', 'fr')).toBe('EAU');
    expect(gpsCategoryCode(undefined, 'health', 'fr')).toBe('SAN');
    expect(gpsCategoryCode(undefined, undefined, 'fr')).toBe('POI');
    // Codes sans ambiguïté entre boulangerie / boucherie, restaurant / restauration rapide.
    expect(gpsCategoryCode('butcher', 'bakeries', 'fr')).toBe('BCH');
    expect(gpsCategoryCode('fast_food', 'fastFood', 'fr')).toBe('FAS');
    // Cimetière : CIM / CEM, sans nom (« Cimetière de … » n'apprend rien au compteur).
    expect(gpsCategoryCode('cemetery', 'cemeteries', 'fr')).toBe('CIM');
    expect(gpsCategoryCode(undefined, 'cemeteries', 'en')).toBe('CEM');
  });
});

describe('distance au tracé', () => {
  it('deux chiffres au moins, côté selon le sens de marche', () => {
    expect(formatRouteOffset(10, 'left', 'fr')).toBe('G10');
    expect(formatRouteOffset(3.2, 'right', 'fr')).toBe('D03');
    expect(formatRouteOffset(250, 'right', 'en')).toBe('R250');
    expect(formatRouteOffset(1_250, 'left', 'en')).toBe('L1250');
    expect(formatRouteOffset(12_400, 'left', 'fr')).toBe('G12k');
  });

  it('sur le tracé : 00, sans côté', () => {
    expect(formatRouteOffset(0.4, 'left', 'fr')).toBe('00');
    expect(formatRouteOffset(Number.NaN, 'left', 'fr')).toBe('00');
    expect(formatRouteOffset(6, null, 'fr')).toBe('06');
  });
});

describe('horaires du jour de passage', () => {
  it('format court des feuilles de route', () => {
    expect(formatOpeningIntervals([{ start: h(9), end: h(22) }], 'fr')).toBe('9-22');
    expect(formatOpeningIntervals([{ start: h(8, 30), end: h(17, 30) }], 'fr')).toBe('8.30-17.30');
    expect(formatOpeningIntervals([{ start: h(14), end: h(19) }, { start: h(8), end: h(12) }], 'fr')).toBe('8-12,14-19');
    expect(formatOpeningIntervals([{ start: h(18), end: h(26) }], 'fr')).toBe('18-2');
    expect(formatOpeningIntervals([{ start: h(18), end: h(24) }], 'fr')).toBe('18-24');
  });

  it('plages jointives fusionnées ; 24 h sur 24 ; fermé', () => {
    expect(formatOpeningIntervals([{ start: h(8), end: h(12) }, { start: h(12), end: h(19) }], 'fr')).toBe('8-19');
    expect(formatOpeningIntervals([{ start: 0, end: h(24) }], 'fr')).toBe('24h');
    expect(formatOpeningIntervals([], 'fr')).toBe('fermé');
    expect(formatOpeningIntervals([], 'en')).toBe('closed');
  });

  it('horaires déjà écrits dans un nom', () => {
    for (const name of ['9-22', '8.30-17.30', '7h-19h La Mie', 'Dupont 6:30 - 13:00', 'ouvert 24h', 'Fermé lundi', '24/7 shop']) {
      expect(hasHandwrittenHours(name), name).toBe(true);
    }
    for (const name of ['Carrefour Market', 'Hôtel des Alpes', 'D20', 'Le 7 Bis']) {
      expect(hasHandwrittenHours(name), name).toBe(false);
    }
  });
});
