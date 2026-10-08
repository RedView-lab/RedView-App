// ============================================
// Viewer LiDAR — commentaires (les bulles d'info de l'app, sur le nuage de points)
// ============================================
//
// Mêmes fils que sur la carte RedView (features/comments), reçus de l'onglet
// de l'app par le pont des commentaires (comments/bridge/lidarCommentChannel.ts) :
// l'app reste le seul rédacteur (session temps réel), le viewer lui envoie des
// actions. Sans réponse de l'app, la dernière copie stockée est affichée en
// lecture seule. Les bulles reposent sur le modèle de sol de la scène (son MNT,
// l'altitude stockée seulement en repli), sont reprojetées à chaque pose de
// caméra (transformations DOM, pas de rendu React par image) et s'estompent derrière une crête.

import {
  postLidarCommentMessage,
  readLidarCommentState,
  readStoredLidarCommentState,
  subscribeLidarComments,
  type LidarCommentState,
} from '@/features/comments/bridge/lidarCommentChannel';
import type { CommentDraft } from '@/features/comments/context/commentTool';
import type { CommentAction, CommentTextInput } from '@/features/comments/lib/commentActions';
import { createDocumentId } from '@/features/itineraryPanel/lib/project/ids';
import type { ProjectCommentAnchor, ProjectCommentZone } from '@/features/itineraryPanel/types';
import type { ProjectedScreenPoint } from '../route/terrainRaycaster';
import type { Vec3 } from '../tools/types';
import { mountViewerCommentsUi } from './mount';

export interface ViewerCommentsOptions {
  /** Parent du canvas de la scène (bulles et cartes sont posées dessus). */
  container: HTMLElement;
  /** Position dans le repère de rendu d'un point WGS84 (altitude du sol quand `altitudeM` est null) ; null hors de la scène. */
  toLocal(lon: number, lat: number, altitudeM: number | null): Vec3 | null;
  project(local: Vec3): ProjectedScreenPoint;
  /** Le modèle de sol ne cache pas ce point à l'œil. */
  isVisible(local: Vec3): boolean;
  /** Amène la caméra au-dessus d'une bulle (fil précédent / suivant). */
  centerOn(local: Vec3): void;
  /** Panneaux flottants sur la scène : une carte ouverte reste entre eux. */
  obstacles?: () => readonly Element[];
  /** Contour au sol de la zone de commentaire survolée / ouverte (null : aucune). */
  showZone?: (ring: ReadonlyArray<[number, number]> | null) => void;
}

export interface ViewerCommentsSnapshot {
  state: LidarCommentState | null;
  /** L'app répond : les écritures atteignent le projet. */
  live: boolean;
  openThreadId: string | null;
  hoveredThreadId: string | null;
  draft: CommentDraft | null;
  draftFocusRequest: number;
}

/** Hauteur d'une bulle (CommentPin) : une carte se place à côté, alignée en haut. */
const PIN_SIZE_PX = 36;
const CARD_GAP_PX = 8;
const EDGE_PX = 8;
/** Bulle cachée derrière une crête : estompée, toujours là. */
const OCCLUDED_OPACITY = '0.35';
/** Pas de réponse à HELLO dans ce délai : lecture seule (app fermée). */
const HELLO_TIMEOUT_MS = 1500;

const anchorKey = (anchor: ProjectCommentAnchor) => `${anchor.lng},${anchor.lat},${anchor.elevationM ?? ''}`;

export class ViewerComments {
  private readonly opts: ViewerCommentsOptions;
  private snapshot: ViewerCommentsSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly pins = new Map<string, HTMLElement>();
  private card: HTMLElement | null = null;
  private readonly locals = new Map<string, { key: string; local: Vec3 | null }>();
  private readonly unsubscribe: () => void;
  private readonly unmount: () => void;
  private helloTimer: number | null = null;
  /** Texte en cours de saisie dans le nouveau commentaire (gardé si on clique ailleurs). */
  readonly draftTextRef = { current: '' };

  constructor(opts: ViewerCommentsOptions) {
    this.opts = opts;
    this.snapshot = {
      state: readStoredLidarCommentState(),
      live: false,
      openThreadId: null,
      hoveredThreadId: null,
      draft: null,
      draftFocusRequest: 0,
    };
    this.unsubscribe = subscribeLidarComments((message) => {
      if (message.type === 'STATE') {
        const state = readLidarCommentState(message);
        if (!state) return;
        if (this.helloTimer != null) window.clearTimeout(this.helloTimer);
        this.helloTimer = null;
        this.update({ state, live: true });
      } else if (message.type === 'CLOSED' && message.projectId === this.snapshot.state?.projectId) {
        this.update({ live: false, draft: null });
      }
    });
    postLidarCommentMessage({ version: 1, type: 'HELLO' });
    this.helloTimer = window.setTimeout(() => {
      this.helloTimer = null;
      if (!this.snapshot.live) this.notify();
    }, HELLO_TIMEOUT_MS);
    window.addEventListener('keydown', this.onKeyDown);
    this.unmount = mountViewerCommentsUi(this, opts.container);
  }

  // ── Store lu par la couche React ───────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ViewerCommentsSnapshot => this.snapshot;

  /** Les commentaires peuvent être écrits depuis le viewer (l'app tient le projet ouvert). */
  get writable(): boolean {
    return this.snapshot.live && this.snapshot.state !== null;
  }

  private update(patch: Partial<ViewerCommentsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.syncZone();
    this.notify();
  }

  private shownZoneKey = '';

  /** Zone du fil survolé, sinon de celui ouvert, sinon du nouveau commentaire (comme sur la carte). */
  private syncZone(): void {
    const { state, hoveredThreadId, openThreadId, draft } = this.snapshot;
    const find = (id: string | null) => (id ? state?.threads.find((thread) => thread.id === id)?.zone : undefined);
    const zone = find(hoveredThreadId) ?? find(openThreadId) ?? draft?.zone ?? null;
    const key = zone ? JSON.stringify(zone.ring) : '';
    if (key === this.shownZoneKey) return;
    this.shownZoneKey = key;
    this.opts.showZone?.(zone ? zone.ring : null);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  // ── Éléments placés à chaque pose de caméra ────────────────────────────────

  registerPin(key: string, element: HTMLElement | null): void {
    if (element) this.pins.set(key, element);
    else this.pins.delete(key);
    this.updateOverlay();
  }

  registerCard(element: HTMLElement | null): void {
    this.card = element;
    this.updateOverlay();
  }

  private localOf(key: string, anchor: ProjectCommentAnchor): Vec3 | null {
    const cacheKey = anchorKey(anchor);
    const cached = this.locals.get(key);
    if (cached?.key === cacheKey) return cached.local;
    // Le MNT de la scène d'abord (sol LiDAR), sinon l'altitude de terrain stockée.
    const local = this.opts.toLocal(anchor.lng, anchor.lat, null) ?? this.opts.toLocal(anchor.lng, anchor.lat, anchor.elevationM);
    this.locals.set(key, { key: cacheKey, local });
    return local;
  }

  private anchorFor(key: string): ProjectCommentAnchor | null {
    if (key === 'draft') return this.snapshot.draft?.anchor ?? null;
    return this.snapshot.state?.threads.find((thread) => thread.id === key)?.anchor ?? null;
  }

  /** Position écran d'une bulle, null hors de l'écran ou hors de la scène. */
  private screenOf(key: string): { x: number; y: number; visible: boolean } | null {
    const anchor = this.anchorFor(key);
    const local = anchor ? this.localOf(key, anchor) : null;
    if (!local) return null;
    const point = this.opts.project(local);
    if (!point.inFront || !Number.isFinite(point.screenX) || !Number.isFinite(point.screenY)) return null;
    return { x: point.screenX, y: point.screenY, visible: this.opts.isVisible(local) };
  }

  /** Reprojette les bulles et la carte ouverte ; à appeler après un mouvement de caméra. */
  updateOverlay(): void {
    const width = this.opts.container.clientWidth;
    const height = this.opts.container.clientHeight;
    for (const [key, element] of this.pins) {
      const screen = this.screenOf(key);
      const onScreen = screen && screen.x > -40 && screen.y > -40 && screen.x < width + 40 && screen.y < height + 40;
      if (!screen || !onScreen) {
        element.style.visibility = 'hidden';
        continue;
      }
      element.style.visibility = 'visible';
      element.style.transform = `translate3d(${Math.round(screen.x)}px, ${Math.round(screen.y)}px, 0)`;
      element.style.opacity = screen.visible || key === this.snapshot.openThreadId || key === 'draft' ? '' : OCCLUDED_OPACITY;
    }
    this.placeCard(width, height);
  }

  private placeCard(width: number, height: number): void {
    const card = this.card;
    if (!card) return;
    const key = this.snapshot.draft ? 'draft' : this.snapshot.openThreadId;
    const screen = key ? this.screenOf(key) : null;
    if (!screen) {
      card.style.visibility = 'hidden';
      return;
    }
    const rect = card.getBoundingClientRect();
    const [minX, maxX] = this.freeSpan(width);
    let left = screen.x + PIN_SIZE_PX + CARD_GAP_PX;
    if (left + rect.width > maxX - EDGE_PX) left = screen.x - CARD_GAP_PX - rect.width;
    left = Math.max(minX + EDGE_PX, Math.min(left, maxX - rect.width - EDGE_PX));
    const top = Math.max(EDGE_PX, Math.min(screen.y - PIN_SIZE_PX, height - rect.height - EDGE_PX));
    card.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
    card.style.visibility = 'visible';
  }

  /** Intervalle horizontal entre les panneaux flottants (px du conteneur) ; toute la largeur s'ils ne laissent pas de place. */
  private freeSpan(width: number): [number, number] {
    const container = this.opts.container.getBoundingClientRect();
    let minX = 0;
    let maxX = width;
    for (const element of this.opts.obstacles?.() ?? []) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const left = rect.left - container.left;
      const right = rect.right - container.left;
      if (left + right < width) minX = Math.max(minX, right);
      else maxX = Math.min(maxX, left);
    }
    return maxX - minX > 360 ? [minX, maxX] : [0, width];
  }

  // ── Fils, nouveau commentaire ──────────────────────────────────────────────

  openThread(threadId: string, options?: { center?: boolean }): void {
    const thread = this.snapshot.state?.threads.find((candidate) => candidate.id === threadId);
    if (!thread) return;
    this.draftTextRef.current = '';
    this.update({ openThreadId: threadId, draft: null });
    this.send({ version: 1, type: 'MARK_READ', projectId: this.snapshot.state!.projectId, threadId });
    if (options?.center) {
      const local = this.localOf(threadId, thread.anchor);
      if (local) this.opts.centerOn(local);
    }
  }

  closeThread(): void {
    if (this.snapshot.openThreadId) this.update({ openThreadId: null });
  }

  setHovered(threadId: string | null): void {
    if (this.snapshot.hoveredThreadId !== threadId) this.update({ hoveredThreadId: threadId });
  }

  /** Fil ouvert suivant / précédent de la scène. */
  navigate(direction: 1 | -1): void {
    const threads = (this.snapshot.state?.threads ?? []).filter((thread) => thread.resolvedAt === undefined || thread.id === this.snapshot.openThreadId);
    if (threads.length === 0) return;
    const index = threads.findIndex((thread) => thread.id === this.snapshot.openThreadId);
    this.openThread(threads[(index + direction + threads.length) % threads.length].id, { center: true });
  }

  startDraft(anchor: ProjectCommentAnchor, zone?: ProjectCommentZone): void {
    if (!this.writable) return;
    if (this.snapshot.draft && this.draftTextRef.current.trim()) {
      this.update({ draftFocusRequest: this.snapshot.draftFocusRequest + 1 });
      return;
    }
    this.draftTextRef.current = '';
    this.locals.delete('draft');
    this.update({ draft: zone ? { anchor, zone } : { anchor }, openThreadId: null });
  }

  cancelDraft(): void {
    this.draftTextRef.current = '';
    if (this.snapshot.draft) this.update({ draft: null });
  }

  submitDraft(input: CommentTextInput): boolean {
    const draft = this.snapshot.draft;
    if (!draft || !this.writable) return false;
    const threadId = createDocumentId('cm');
    this.sendAction({
      type: 'create-thread',
      threadId,
      messageId: createDocumentId('cmm'),
      anchor: draft.anchor,
      ...(draft.zone ? { zone: draft.zone } : {}),
      text: input.text,
      ...(input.mentions?.length ? { mentions: [...input.mentions] } : {}),
      at: new Date().toISOString(),
    });
    this.draftTextRef.current = '';
    // Le fil s'ouvre dès que l'app l'a publié.
    this.update({ draft: null, openThreadId: threadId });
    return true;
  }

  /** Action de l'utilisateur, appliquée par l'app (même reducer, puis la session temps réel). */
  sendAction(action: CommentAction): boolean {
    const state = this.snapshot.state;
    if (!state || !this.writable) return false;
    this.send({ version: 1, type: 'COMMENT_ACTION', projectId: state.projectId, action });
    return true;
  }

  markUnread(threadId: string): void {
    const state = this.snapshot.state;
    if (!state || !this.writable) return;
    this.send({ version: 1, type: 'MARK_UNREAD', projectId: state.projectId, threadId });
    this.closeThread();
  }

  private send(message: Parameters<typeof postLidarCommentMessage>[0]): void {
    postLidarCommentMessage(message);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const target = event.target;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
    if (this.snapshot.draft) this.cancelDraft();
    else this.closeThread();
  };

  destroy(): void {
    if (this.helloTimer != null) window.clearTimeout(this.helloTimer);
    window.removeEventListener('keydown', this.onKeyDown);
    this.opts.showZone?.(null);
    this.unsubscribe();
    this.unmount();
    this.listeners.clear();
  }
}
