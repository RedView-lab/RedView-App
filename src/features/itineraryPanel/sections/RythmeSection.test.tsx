// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

import { renderComponent, type RenderedComponent } from '@/shared/test/renderComponent';
import { createDefaultRhythmState } from '../lib/project/defaultState';
import type { RhythmState } from '../types';
import { RythmeSection } from './RythmeSection';

let view: RenderedComponent | null = null;

afterEach(() => {
  view?.unmount();
  view = null;
});

function render(patch: Partial<RhythmState> = {}, props: Partial<Parameters<typeof RythmeSection>[0]> = {}) {
  const onChange = vi.fn();
  view = renderComponent(
    createElement(RythmeSection, { rhythm: { ...createDefaultRhythmState(), ...patch }, onChange, ...props }),
  );
  return { view, onChange };
}

const SPEED_UP = 'Accélérer l’estimation de 5 %';
const SLOW_DOWN = 'Ralentir l’estimation de 5 %';

describe('RythmeSection — Pondérer', () => {
  it('+ et − avancent par pas de 5 %', () => {
    const { view, onChange } = render();
    view.click(view.button(SPEED_UP));
    expect(onChange).toHaveBeenLastCalledWith('paceWeightPct', 5);
    view.click(view.button(SLOW_DOWN));
    expect(onChange).toHaveBeenLastCalledWith('paceWeightPct', -5);
  });

  it('revenir à 0 % retire la pondération (estampille d’origine)', () => {
    const { view, onChange } = render({ paceWeightPct: 5 });
    view.click(view.button(SLOW_DOWN));
    expect(onChange).toHaveBeenLastCalledWith('paceWeightPct', undefined);
  });

  it('affiche la valeur non neutre, remise à 0 % au clic ; boutons bornés', () => {
    const { view, onChange } = render({ paceWeightPct: 50 });
    const value = view.container.querySelector<HTMLButtonElement>('.rvi-rythme-figma__weight-value');
    expect(value?.textContent?.replace(/\s/g, '')).toBe('+50%');
    expect(view.button(SPEED_UP).disabled).toBe(true);
    expect(view.button(SLOW_DOWN).disabled).toBe(false);
    view.click(value!);
    expect(onChange).toHaveBeenLastCalledWith('paceWeightPct', undefined);
  });

  it('aucune valeur affichée à 0 %', () => {
    const { view } = render();
    expect(view.container.querySelector('.rvi-rythme-figma__weight-value')).toBeNull();
  });
});

describe('RythmeSection — profil vitesse', () => {
  it('la liste des profils propose 8 → 50 km/h sous les profils existants', () => {
    const { view, onChange } = render();
    view.click(view.container.querySelector('.rvi-rythme-figma__profile-btn')!);
    const options = [...document.body.querySelectorAll<HTMLButtonElement>('.rvi-rythme-figma__profile-menu [role="option"]')];
    const labels = options.map((option) => option.textContent?.replace(/\u00a0/g, ' '));
    expect(labels.slice(0, 5)).toEqual(['Débutant', 'Intermédiaire', 'Avancé', 'Expert', 'Personnalisé']);
    expect(labels.slice(5)).toEqual(Array.from({ length: 22 }, (_, i) => `${8 + i * 2} km/h`));
    view.click(options.find((option) => option.textContent === '24\u00a0km/h')!);
    // Vitesse posée avant le profil (sinon la normalisation le ramène à un niveau).
    expect(onChange.mock.calls).toEqual([['targetSpeedKmh', 24], ['rhythmProfile', 'speed']]);
  });

  it('à pied, la liste s’arrête à 20 km/h', () => {
    const { view } = render({}, { discipline: 'trail' });
    view.click(view.container.querySelector('.rvi-rythme-figma__profile-btn')!);
    const last = [...document.body.querySelectorAll('.rvi-rythme-figma__profile-menu [role="option"]')].at(-1);
    expect(last?.textContent).toBe('20\u00a0km/h');
  });

  it('le bouton affiche la vitesse choisie, sélectionnée dans la liste', () => {
    const { view } = render({ rhythmProfile: 'speed', targetSpeedKmh: 32, practiceLevel: 'expert' });
    expect(view.container.querySelector('.rvi-rythme-figma__profile-text')?.textContent).toBe('32\u00a0km/h');
    view.click(view.container.querySelector('.rvi-rythme-figma__profile-btn')!);
    const selected = [...document.body.querySelectorAll('.rvi-rythme-figma__profile-menu [aria-selected="true"]')];
    expect(selected.map((option) => option.textContent)).toEqual(['32\u00a0km/h']);
  });
});

describe('RythmeSection — résultats sous le bouton', () => {
  const summary = { totalSeconds: 5 * 3600, movingSeconds: 4 * 3600, pauseSeconds: 3600, movingKmh: 25, paceSecondsPerKm: null };

  it('temps total, déplacement avec km/h, pauses', () => {
    const { view } = render({}, { resultSummary: summary, resultLabel: 'Re-calculer' });
    const rows = [...view.container.querySelectorAll('.rvi-rythme-figma__result-row')].map((row) =>
      [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent?.replace(/\u00a0/g, ' ')],
    );
    expect(rows).toEqual([
      ['Temps total', '5h00m'],
      ['En déplacement', '4h00m · 25,0 km/h'],
      ['Pauses', '1h00m'],
    ]);
  });

  it('estompé pendant un recalcul, sans ligne de pause quand il n’y en a pas', () => {
    const { view } = render({}, { resultSummary: { ...summary, pauseSeconds: 0 }, calculateDisabled: true });
    expect(view.container.querySelector('.rvi-rythme-figma__results')?.classList.contains('is-stale')).toBe(true);
    expect(view.container.querySelectorAll('.rvi-rythme-figma__result-row')).toHaveLength(2);
  });

  it('masqué sur une erreur de calcul', () => {
    const { view } = render({}, { resultSummary: summary, calculateError: 'Échec' });
    expect(view.container.querySelector('.rvi-rythme-figma__results')).toBeNull();
  });
});
