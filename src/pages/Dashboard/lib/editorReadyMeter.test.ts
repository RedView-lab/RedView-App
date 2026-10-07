import { describe, expect, it } from 'vitest';

import { EditorReadyMeter } from './editorReadyMeter';

describe('EditorReadyMeter', () => {
  it('ouverture depuis le gestionnaire : du clic à la carte prête, une seule fois', () => {
    const meter = new EditorReadyMeter();
    meter.start(10_000, false);
    expect(meter.observe('ready', 10_100)).toBeNull(); // statut resté de l'ouverture précédente
    expect(meter.observe('loading', 10_200)).toBeNull();
    expect(meter.observe('ready', 13_400)).toEqual({ ms: 3400, cold: false });
    expect(meter.observe('loading', 14_000)).toBeNull();
    expect(meter.observe('ready', 15_000)).toBeNull();
  });

  it('lien direct : mesuré depuis la navigation', () => {
    const meter = new EditorReadyMeter();
    meter.start(800, true);
    meter.observe('loading', 900);
    expect(meter.observe('ready', 4200)).toEqual({ ms: 4200, cold: true });
  });

  it('onglet masqué, annulation, durée aberrante : rien', () => {
    const meter = new EditorReadyMeter();
    meter.start(0, false);
    meter.observe('loading', 10);
    meter.markHidden();
    expect(meter.observe('ready', 2000)).toBeNull();

    meter.start(0, false);
    meter.observe('loading', 10);
    meter.cancel();
    expect(meter.observe('ready', 2000)).toBeNull();

    meter.start(0, false);
    meter.observe('loading', 10);
    expect(meter.observe('ready', 200_000)).toBeNull();
  });
});
