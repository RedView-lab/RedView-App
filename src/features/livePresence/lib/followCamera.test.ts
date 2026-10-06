import { describe, expect, it } from 'vitest';

import { cameraFromWire, followCamera, viewportFromWire, visibleRect, type LeaderViewport, type MapViewportShape } from './followCamera';

const LEADER_CAMERA = { lng: 6.8694, lat: 45.9237, zoom: 13.4, bearing: -25, pitch: 62, fov: 36.87 };
const INSETS = { top: 64, right: 360, bottom: 300, left: 420 };

/** Point principal du padding rendu (centre de la zone de padding, comme Mapbox). */
function principal(viewport: MapViewportShape, padding: { top: number; right: number; bottom: number; left: number }) {
  return {
    x: (padding.left + viewport.width - padding.right) / 2,
    y: (padding.top + viewport.height - padding.bottom) / 2,
  };
}

describe('cadrage contain du suivi', () => {
  it('même écran, même mise en page : vue identique (padding = ses encarts)', () => {
    const leader: LeaderViewport = { width: 1600, height: 900, insets: INSETS, padding: INSETS };
    const camera = followCamera(LEADER_CAMERA, leader, { width: 1600, height: 900, insets: INSETS });
    expect(camera.center).toEqual([LEADER_CAMERA.lng, LEADER_CAMERA.lat]);
    expect(camera.zoom).toBeCloseTo(LEADER_CAMERA.zoom, 12);
    expect(camera).toMatchObject({ bearing: -25, pitch: 62, fov: 36.87 });
    expect(camera.padding).toEqual(INSETS);
  });

  it('padding différent mais même point principal : même rendu', () => {
    // Il a un padding nul : il regarde le centre de sa carte, décalé dans sa zone visible.
    const leader: LeaderViewport = { width: 1600, height: 900, insets: INSETS, padding: { top: 0, right: 0, bottom: 0, left: 0 } };
    const follower = { width: 1600, height: 900, insets: INSETS };
    const camera = followCamera(LEADER_CAMERA, leader, follower);
    const point = principal(follower, camera.padding);
    expect(point.x).toBeCloseTo(800, 9);
    expect(point.y).toBeCloseTo(450, 9);
    expect(camera.zoom).toBeCloseTo(LEADER_CAMERA.zoom, 12);
  });

  it('écran plus petit : zoom arrière pour tout contenir, au ratio le plus serré', () => {
    const leader: LeaderViewport = { width: 2560, height: 1440, insets: INSETS, padding: INSETS };
    const follower = { width: 1280, height: 800, insets: INSETS };
    const camera = followCamera(LEADER_CAMERA, leader, follower);
    const leaderVisible = visibleRect(leader);
    const followerVisible = visibleRect(follower);
    const scale = Math.min(followerVisible.width / leaderVisible.width, followerVisible.height / leaderVisible.height);
    expect(camera.zoom).toBeCloseTo(LEADER_CAMERA.zoom + Math.log2(scale), 12);
    expect(scale).toBeLessThan(1);
    // Sa zone visible, mise à l'échelle, tient dans la mienne.
    expect(leaderVisible.width * scale).toBeLessThanOrEqual(followerVisible.width + 1e-9);
    expect(leaderVisible.height * scale).toBeLessThanOrEqual(followerVisible.height + 1e-9);
    // Son centre est au centre de ma zone visible.
    const point = principal(follower, camera.padding);
    expect(point.x).toBeCloseTo(followerVisible.x + followerVisible.width / 2, 9);
    expect(point.y).toBeCloseTo(followerVisible.y + followerVisible.height / 2, 9);
  });

  it('écran plus grand : zoom avant (sa vue remplit la mienne)', () => {
    const leader: LeaderViewport = { width: 1280, height: 800, insets: INSETS, padding: INSETS };
    const camera = followCamera(LEADER_CAMERA, leader, { width: 2560, height: 1440, insets: INSETS });
    expect(camera.zoom).toBeGreaterThan(LEADER_CAMERA.zoom);
  });

  it('FreeCam qui regarde le ciel (padding haut) : décalage optique reproduit à l’échelle', () => {
    const lensShift = { ...INSETS, top: INSETS.top + 500 };
    const leader: LeaderViewport = { width: 1600, height: 900, insets: INSETS, padding: lensShift };
    const follower = { width: 1600, height: 900, insets: INSETS };
    const camera = followCamera(LEADER_CAMERA, leader, follower);
    expect(principal(follower, camera.padding).y).toBeCloseTo(principal(leader, lensShift).y, 9);
  });

  it('padding toujours valide : jamais négatif, jamais toute la carte', () => {
    const leader: LeaderViewport = { width: 1600, height: 900, insets: INSETS, padding: { top: 0, right: 0, bottom: 0, left: 1500 } };
    const follower = { width: 900, height: 700, insets: { top: 0, right: 800, bottom: 0, left: 0 } };
    const camera = followCamera(LEADER_CAMERA, leader, follower);
    const { top, right, bottom, left } = camera.padding;
    for (const value of [top, right, bottom, left]) expect(value).toBeGreaterThanOrEqual(0);
    expect(left + right).toBeLessThan(follower.width);
    expect(top + bottom).toBeLessThan(follower.height);
  });

  it('zoom borné aux limites de la carte', () => {
    const leader: LeaderViewport = { width: 3840, height: 2160, insets: INSETS, padding: INSETS };
    const camera = followCamera({ ...LEADER_CAMERA, zoom: 0.5 }, leader, { width: 900, height: 600, insets: { top: 0, right: 0, bottom: 0, left: 0 } }, { minZoom: 0, maxZoom: 22 });
    expect(camera.zoom).toBe(0);
  });

  it('format du fil → caméra et zone visible', () => {
    expect(cameraFromWire([1, 2, 3, 4, 5, 6])).toEqual({ lng: 1, lat: 2, zoom: 3, bearing: 4, pitch: 5, fov: 6 });
    expect(viewportFromWire([1600, 900, 1, 2, 3, 4, 5, 6, 7, 8])).toEqual({
      width: 1600, height: 900, insets: { top: 1, right: 2, bottom: 3, left: 4 }, padding: { top: 5, right: 6, bottom: 7, left: 8 },
    });
  });
});
