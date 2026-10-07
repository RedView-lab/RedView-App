import { describe, expect, it } from 'vitest';
import { toggleFavoriteInPopupState } from './poi-popup';
import { formatPoiPauseLabel } from './poi-sprites';

describe('popup POI : étoile', () => {
  it('coche la pause avec le favori, à la durée affichée', () => {
    const next = toggleFavoriteInPopupState({ favoriteEnabled: false, pauseEnabled: false, pauseDurationMin: 15 });
    expect(next).toMatchObject({ favoriteEnabled: true, pauseEnabled: true, pauseDurationMin: 15 });
  });

  it('décoche la pause en retirant le favori', () => {
    const next = toggleFavoriteInPopupState({
      favoriteEnabled: true,
      pauseEnabled: true,
      pauseDurationMin: 30,
      isDurationDropdownOpen: true,
    });
    expect(next).toMatchObject({ favoriteEnabled: false, pauseEnabled: false, isDurationDropdownOpen: false });
  });
});

describe('libellé de pause', () => {
  it('écrit les minutes, puis les heures', () => {
    expect(formatPoiPauseLabel(15)).toBe('15 min');
    expect(formatPoiPauseLabel(59.6)).toBe('1 h');
    expect(formatPoiPauseLabel(90)).toBe('1 h 30');
    expect(formatPoiPauseLabel(360)).toBe('6 h');
    expect(formatPoiPauseLabel(0)).toBe('1 min');
  });
});
