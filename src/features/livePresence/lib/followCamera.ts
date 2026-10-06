import type { MotionCamera, MotionViewport } from '@/features/collab/protocol';

/**
 * Cadrage « contain » du suivi (comme tldraw / Figma) : la vue de l'éditeur
 * suivi tient entière dans la mienne, au ratio de mon écran.
 *
 * Mapbox place le centre de la carte au point principal (centre de la zone de
 * padding : décalage optique, le rendu ne dépend que de lui) et le zoom fixe
 * l'échelle au centre. Avec `V` la zone visible de chacun (carte moins les
 * panneaux qui la couvrent) :
 *  - échelle `s = min(Vf.w / Vl.w, Vf.h / Vl.h)` → `zoom_f = zoom_l + log2(s)` ;
 *  - point principal miroir `p_f = centre(Vf) + s · (p_l − centre(Vl))` : ce
 *    qu'il regarde au centre de sa zone visible est au centre de la mienne ;
 *    son décalage optique (FreeCam qui regarde le ciel) est reproduit ;
 *  - même centre, cap, inclinaison et champ vertical.
 * Même écran et même mise en page : vue identique. Le padding rendu part de
 * mes propres encarts (sémantique de l'application : zone utile), décalés
 * juste ce qu'il faut pour placer le point principal.
 */

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface MapViewportShape {
  width: number;
  height: number;
  /** Bords couverts par l'interface (panneaux). */
  insets: Insets;
}

export interface LeaderViewport extends MapViewportShape {
  /** Padding Mapbox de l'émetteur (son point principal). */
  padding: Insets;
}

export interface CameraState {
  lng: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
  fov: number;
}

export interface FollowCamera {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  fov: number;
  padding: Insets;
}

/** En deçà, une zone visible n'en est plus une (panneaux qui couvrent presque tout) : la carte entière compte. */
const MIN_VISIBLE_RATIO = 0.25;
/** Point principal gardé loin des bords (padding toujours valide pour Mapbox). */
const PRINCIPAL_MARGIN_RATIO = 0.05;

export function cameraFromWire(cam: MotionCamera | readonly number[]): CameraState {
  return { lng: cam[0], lat: cam[1], zoom: cam[2], bearing: cam[3], pitch: cam[4], fov: cam[5] };
}

export function viewportFromWire(vp: MotionViewport | readonly number[]): LeaderViewport {
  return {
    width: vp[0],
    height: vp[1],
    insets: { top: vp[2], right: vp[3], bottom: vp[4], left: vp[5] },
    padding: { top: vp[6], right: vp[7], bottom: vp[8], left: vp[9] },
  };
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Zone de la carte que l'interface ne couvre pas (par axe : toute la carte si presque tout est couvert). */
export function visibleRect({ width, height, insets }: MapViewportShape): Rect {
  const visibleWidth = width - insets.left - insets.right;
  const visibleHeight = height - insets.top - insets.bottom;
  const horizontal = visibleWidth >= width * MIN_VISIBLE_RATIO;
  const vertical = visibleHeight >= height * MIN_VISIBLE_RATIO;
  return {
    x: horizontal ? insets.left : 0,
    y: vertical ? insets.top : 0,
    width: horizontal ? visibleWidth : width,
    height: vertical ? visibleHeight : height,
  };
}

function principalPoint({ width, height, padding }: LeaderViewport): { x: number; y: number } {
  return {
    x: Math.min(width, Math.max(0, (padding.left + width - padding.right) / 2)),
    y: Math.min(height, Math.max(0, (padding.top + height - padding.bottom) / 2)),
  };
}

/** Deux bords (gauche/droite ou haut/bas) décalés pour centrer `center` dans `size`, jamais négatifs. */
function shiftedPair(insetBefore: number, insetAfter: number, size: number, center: number): [number, number] {
  // Encarts qui couvrent presque tout : padding minimal (toujours valide pour Mapbox).
  const usable = insetBefore + insetAfter < size * (1 - MIN_VISIBLE_RATIO);
  const before = usable ? insetBefore : 0;
  const after = usable ? insetAfter : 0;
  const delta = 2 * center - (before + size - after);
  let first = before + delta / 2;
  let second = after - delta / 2;
  const lowest = Math.min(first, second);
  if (lowest < 0) {
    first -= lowest;
    second -= lowest;
  }
  return [first, second];
}

export function followCamera(
  leader: CameraState,
  leaderViewport: LeaderViewport,
  follower: MapViewportShape,
  limits: { minZoom: number; maxZoom: number } = { minZoom: 0, maxZoom: 22 },
): FollowCamera {
  const leaderRect = visibleRect(leaderViewport);
  const followerRect = visibleRect(follower);
  const scale = Math.min(followerRect.width / leaderRect.width, followerRect.height / leaderRect.height);
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;

  const leaderPrincipal = principalPoint(leaderViewport);
  const marginX = follower.width * PRINCIPAL_MARGIN_RATIO;
  const marginY = follower.height * PRINCIPAL_MARGIN_RATIO;
  const x = followerRect.x + followerRect.width / 2 + safeScale * (leaderPrincipal.x - (leaderRect.x + leaderRect.width / 2));
  const y = followerRect.y + followerRect.height / 2 + safeScale * (leaderPrincipal.y - (leaderRect.y + leaderRect.height / 2));
  const principalX = Math.min(follower.width - marginX, Math.max(marginX, x));
  const principalY = Math.min(follower.height - marginY, Math.max(marginY, y));

  const [left, right] = shiftedPair(follower.insets.left, follower.insets.right, follower.width, principalX);
  const [top, bottom] = shiftedPair(follower.insets.top, follower.insets.bottom, follower.height, principalY);

  return {
    center: [leader.lng, leader.lat],
    zoom: Math.min(limits.maxZoom, Math.max(limits.minZoom, leader.zoom + Math.log2(safeScale))),
    bearing: leader.bearing,
    pitch: leader.pitch,
    fov: leader.fov,
    padding: { top, right, bottom, left },
  };
}
