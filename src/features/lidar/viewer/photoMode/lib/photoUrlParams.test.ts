import { describe, expect, it } from 'vitest';
import { parsePhotoUrlOverrides } from './photoUrlParams';

describe('parsePhotoUrlOverrides', () => {
  it('reads every valid override', () => {
    const params = new URLSearchParams(
      'photo=1&photoDate=2026-07-14&photoTime=19:45&clouds=storm&coverage=70&cloudBase=-400&haze=10&ev=-0.5',
    );
    expect(parsePhotoUrlOverrides(params)).toEqual({
      enabled: true,
      date: '2026-07-14',
      time: '19:45',
      clouds: 'storm',
      coverage: 70,
      cloudBaseOffsetM: -400,
      haze: 10,
      exposureEv: -0.5,
    });
  });

  it('ignores invalid values instead of casting them', () => {
    const params = new URLSearchParams('photo=yes&photoDate=2026-13-01&photoTime=25:00&clouds=__proto__&coverage=150&ev=9');
    expect(parsePhotoUrlOverrides(params)).toEqual({});
  });

  it('ignores the wind of older links: the clouds are static', () => {
    expect(parsePhotoUrlOverrides(new URLSearchParams('wind=30&windFrom=NW'))).toEqual({});
  });
});
