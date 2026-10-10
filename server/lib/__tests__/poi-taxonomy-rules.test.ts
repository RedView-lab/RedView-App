import { describe, expect, it } from 'vitest';

import taxonomy from '../../../src/features/poi/lib/poi-taxonomy.json';
import {
  condMatches,
  makeResolveCategory,
  parseCategoryList,
  ruleToOverpassFilter,
} from '../../poi-ingest/lib/taxonomy-rules.mjs';

// Règles de la taxonomie POI telles que les importeurs du VPS les appliquent
// (server/poi-ingest) : même JSON que le client.
const resolve = makeResolveCategory(taxonomy);

describe('conditions', () => {
  it('notIn : tag absent ou hors de la liste', () => {
    const cond = { k: 'cemetery', notIn: ['grave', 'sector'] };
    expect(condMatches({}, cond)).toBe(true);
    expect(condMatches({ cemetery: 'war_cemetery' }, cond)).toBe(true);
    expect(condMatches({ cemetery: 'grave' }, cond)).toBe(false);
  });
});

describe('cimetières', () => {
  it('un cimetière communal ou un enclos paroissial est un cimetière', () => {
    expect(resolve({ landuse: 'cemetery' })).toBe('cemetery');
    expect(resolve({ landuse: 'cemetery', name: 'Cimetière de Montmartre', religion: 'christian' })).toBe('cemetery');
    expect(resolve({ amenity: 'grave_yard' })).toBe('cemetery');
    expect(resolve({ landuse: 'cemetery', cemetery: 'war_cemetery' })).toBe('cemetery');
  });

  it("une tombe ou un carré cartographiés dans un cimetière n'en sont pas un", () => {
    for (const inner of ['grave', 'sector', 'section', 'tomb', 'columbarium', 'pet']) {
      expect(resolve({ landuse: 'cemetery', cemetery: inner })).toBeNull();
      expect(resolve({ amenity: 'grave_yard', cemetery: inner })).toBeNull();
    }
  });

  it("un robinet dans un cimetière reste un point d'eau", () => {
    expect(resolve({ man_made: 'water_tap', landuse: 'cemetery' })).toBe('water_tap');
    expect(resolve({ amenity: 'drinking_water', landuse: 'cemetery' })).toBe('drinking_water');
  });
});

describe('--categories', () => {
  it('restreint la sortie sans changer la priorité de la taxonomie complète', () => {
    const only = makeResolveCategory(taxonomy, ['cemetery']);
    expect(only({ landuse: 'cemetery' })).toBe('cemetery');
    expect(only({ amenity: 'drinking_water' })).toBeNull();
    // Classé eau potable par la taxonomie complète : jamais réétiqueté cimetière.
    expect(only({ amenity: 'drinking_water', landuse: 'cemetery' })).toBeNull();
  });

  it('refuse une clé inconnue', () => {
    expect(parseCategoryList(taxonomy, 'cemetery, fountain')).toEqual(['cemetery', 'fountain']);
    expect(parseCategoryList(taxonomy, '')).toBeNull();
    expect(() => parseCategoryList(taxonomy, 'cimetiere')).toThrow(/inconnue/);
  });
});

describe('filtres Overpass des relations', () => {
  it('traduit égalité, appartenance et exclusion', () => {
    expect(ruleToOverpassFilter([{ k: 'amenity', v: 'fountain' }])).toBe('["amenity"="fountain"]');
    expect(ruleToOverpassFilter([{ k: 'railway', in: ['station', 'halt'] }])).toBe('["railway"~"^(station|halt)$"]');
    expect(ruleToOverpassFilter([{ k: 'landuse', v: 'cemetery' }, { k: 'cemetery', notIn: ['grave', 'sector'] }]))
      .toBe('["landuse"="cemetery"]["cemetery"!~"^(grave|sector)$"]');
  });

  it("une règle faite d'exclusions seules ne donne aucune requête", () => {
    expect(ruleToOverpassFilter([{ k: 'cemetery', notIn: ['grave'] }])).toBeNull();
  });

  it('chaque règle de la taxonomie donne un filtre', () => {
    for (const category of taxonomy.categories) {
      for (const rule of category.rules) expect(ruleToOverpassFilter(rule)).toMatch(/^\["/);
    }
  });
});
