import type { Map as MapboxMap } from 'mapbox-gl';

import type { PeerInfo, PresenceUpdate } from '@/features/collab/protocol';
import type { CollabRealtime } from '@/features/collab/realtime';
import { userAvatarColor, userAvatarInk } from '@/shared/components/UserAvatar/avatarColor';
import { translateAppText } from '@/shared/i18n';
import { notify } from '@/shared/ui/notify';

import { FOLLOW_GRACE_MS, SPOTLIGHT_COUNTDOWN_MS } from '../config';
import type { FollowState, LivePeer } from '../context';
import { pickClientOfUser, resolveFollowTarget, type FollowPeer } from '../lib/followChain';
import { FollowController } from './FollowController';
import { MotionStore } from './MotionStore';
import { PeerCursorsOverlay, type ChartPointResolver } from './PeerCursorsOverlay';
import { PresenceBroadcaster } from './PresenceBroadcaster';

/**
 * Présence en direct d'un projet ouvert en co-édition, hors React (lue par
 * `useSyncExternalStore`) : qui est là, qui je suis (et la chaîne de suivi),
 * qui présente sa vue, et les moteurs qui vont avec la carte (émetteur,
 * curseurs, suivi de caméra).
 *
 * Les entrées (carte, session, éditeurs présents) arrivent par `setMap`,
 * `setRealtime` et `setCollab` ; chaque changement recalcule tout et publie
 * un nouvel instantané. Suivre :
 *  - l'onglet cliqué ; s'il disparaît, un autre onglet du même utilisateur
 *    (rechargement), sinon arrêt après `FOLLOW_GRACE_MS` ;
 *  - la vue affichée est celle du bout de la chaîne (A suit B qui suit C → C) ;
 *  - lancé par un Spotlight : arrêté quand la présentation s'arrête.
 * Spotlight : le plus récent (numéro donné par la salle) l'emporte ; chacun
 * reçoit une proposition « Pas maintenant » et suit au bout du compte à rebours.
 */

export interface CollabPresenceInput {
  peers: readonly PeerInfo[];
  self: { clientId: string; userId: string } | null;
  online: boolean;
}

export interface LivePresenceSnapshot {
  selfClientId: string | null;
  selfUserId: string | null;
  /** Nom affiché de cet éditeur (sa pastille dans le bandeau de présentation). */
  selfName: string | null;
  peers: readonly LivePeer[];
  following: FollowState | null;
  followTarget: LivePeer | null;
  presenting: boolean;
  presenter: LivePeer | null;
  followers: readonly LivePeer[];
}

const EMPTY_SNAPSHOT: LivePresenceSnapshot = {
  selfClientId: null,
  selfUserId: null,
  selfName: null,
  peers: [],
  following: null,
  followTarget: null,
  presenting: false,
  presenter: null,
  followers: [],
};

const NO_COLLAB: CollabPresenceInput = { peers: [], self: null, online: false };

function toLivePeer(peer: PeerInfo): LivePeer {
  const color = userAvatarColor(peer.userId);
  return {
    clientId: peer.clientId,
    userId: peer.userId,
    name: peer.presence.name || translateAppText('Éditeur'),
    color,
    ink: userAvatarInk(color),
    following: peer.presence.following ?? null,
    spotlight: peer.presence.spotlight ?? null,
    activeItineraryId: peer.presence.activeItineraryId ?? null,
  };
}

export class LivePresenceSession {
  readonly store = new MotionStore();
  private map: MapboxMap | null = null;
  private realtime: CollabRealtime | null = null;
  private collab: CollabPresenceInput = NO_COLLAB;
  private broadcaster: PresenceBroadcaster | null = null;
  private overlay: PeerCursorsOverlay | null = null;
  private controller: FollowController | null = null;
  private chartPointResolver: ChartPointResolver = () => null;
  private unsubscribeMotion: (() => void) | null = null;

  private follow: FollowState | null = null;
  private presenting = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Spotlights déjà proposés (`clientId:numéro`) : une seule proposition par présentation. */
  private readonly handledSpotlights = new Set<string>();
  private cancelInvite: (() => void) | null = null;
  private previousPeerIds = new Set<string>();
  private wasOnline = false;
  private published: Partial<PresenceUpdate> = {};
  private activeItineraryId: string | null = null;

  private snapshot: LivePresenceSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();

  /* ── Lecture (useSyncExternalStore) ─────────────────────────────────── */

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): LivePresenceSnapshot => this.snapshot;

  /* ── Entrées ───────────────────────────────────────────────────────── */

  setMap(map: MapboxMap | null): void {
    if (this.map === map && (this.broadcaster || !map || !this.realtime)) return;
    this.map = map;
    this.rebuildEngines();
  }

  setRealtime(realtime: CollabRealtime | null): void {
    if (this.realtime === realtime) {
      if (realtime && !this.unsubscribeMotion) this.unsubscribeMotion = realtime.subscribeMotion((event) => this.store.ingest(event));
      return;
    }
    // Autre session (autre projet) : rien ne survit.
    this.unsubscribeMotion?.();
    this.unsubscribeMotion = null;
    this.store.clear();
    this.follow = null;
    this.presenting = false;
    this.handledSpotlights.clear();
    this.cancelInvite?.();
    this.cancelInvite = null;
    this.clearGrace();
    this.published = {};
    this.previousPeerIds = new Set();
    this.wasOnline = false;
    this.realtime = realtime;
    if (realtime) this.unsubscribeMotion = realtime.subscribeMotion((event) => this.store.ingest(event));
    this.rebuildEngines();
  }

  setCollab(collab: CollabPresenceInput | null): void {
    this.collab = collab ?? NO_COLLAB;
    this.update();
  }

  /* ── Actions ───────────────────────────────────────────────────────── */

  followUser(userId: string, options: { viaSpotlight?: boolean } = {}): void {
    const peers = this.followPeers();
    const clientId = pickClientOfUser(userId, peers, this.collab.self?.clientId ?? null, (id) => this.store.lastActivity(id));
    if (!clientId) return;
    const peer = this.collab.peers.find((candidate) => candidate.clientId === clientId);
    const name = peer?.presence.name || translateAppText('Éditeur');
    this.follow = { userId, clientId, name, color: userAvatarColor(userId), viaSpotlight: !!options.viaSpotlight };
    this.clearGrace();
    this.update();
  }

  stopFollowing(): void {
    if (!this.follow) return;
    this.follow = null;
    this.clearGrace();
    this.update();
  }

  setPresenting(on: boolean): void {
    if (this.presenting === on) return;
    this.presenting = on;
    this.update();
  }

  publishActiveItinerary(itineraryId: string | null): void {
    this.activeItineraryId = itineraryId;
    this.publish({ activeItineraryId: itineraryId });
  }

  setChartPointResolver(resolver: ChartPointResolver): void {
    this.chartPointResolver = resolver;
    this.overlay?.setChartPointResolver(resolver);
  }

  /** Tout débranché (carte, session) ; réutilisable : les `set…` suivants rebranchent. */
  dispose(): void {
    this.unsubscribeMotion?.();
    this.unsubscribeMotion = null;
    this.cancelInvite?.();
    this.cancelInvite = null;
    this.clearGrace();
    this.teardownEngines();
  }

  /* ── Moteurs liés à la carte ───────────────────────────────────────── */

  private rebuildEngines(): void {
    this.teardownEngines();
    const { map, realtime } = this;
    if (map && realtime) {
      this.broadcaster = new PresenceBroadcaster(map, realtime);
      this.broadcaster.connect();
      this.overlay = new PeerCursorsOverlay(map, this.store);
      this.overlay.setChartPointResolver(this.chartPointResolver);
      this.overlay.connect();
      this.controller = new FollowController(map, this.store, {
        onStop: () => {
          // L'utilisateur a repris la main (clic, molette, Échap…) : comme Figma, on ne suit plus.
          this.follow = null;
          this.clearGrace();
          this.update();
        },
      });
      // État complet aux autres dès que tout est branché.
      this.previousPeerIds = new Set();
      this.wasOnline = false;
    }
    this.update();
  }

  private teardownEngines(): void {
    this.controller?.dispose();
    this.controller = null;
    this.overlay?.disconnect();
    this.overlay = null;
    this.broadcaster?.disconnect();
    this.broadcaster = null;
  }

  /* ── Recalcul ──────────────────────────────────────────────────────── */

  private followPeers(): FollowPeer[] {
    return this.collab.peers.map((peer) => ({ clientId: peer.clientId, userId: peer.userId, following: peer.presence.following ?? null }));
  }

  private update(): void {
    const { self, online } = this.collab;
    const selfClientId = self?.clientId ?? null;
    const active = !!this.realtime;
    const peers = active ? this.collab.peers.filter((peer) => peer.clientId !== selfClientId).map(toLivePeer) : [];
    const peerIds = new Set(peers.map((peer) => peer.clientId));

    // Flux des éditeurs partis oubliés ; les autres gardent leur lecture en cours.
    this.store.retain(peerIds);

    // ── Spotlight : le plus récent l'emporte.
    const selfPresence = this.collab.peers.find((peer) => peer.clientId === selfClientId)?.presence;
    const mySpotlight = selfPresence?.spotlight ?? null;
    let presenter: LivePeer | null = null;
    for (const peer of peers) {
      if (peer.spotlight !== null && (!presenter || peer.spotlight > (presenter.spotlight ?? 0))) presenter = peer;
    }
    if (presenter && this.presenting && mySpotlight !== null && (presenter.spotlight ?? 0) > mySpotlight) {
      // Quelqu'un présente après moi : ma présentation s'arrête (la sienne me sera proposée).
      this.presenting = false;
    }
    if (presenter && this.presenting) presenter = null;

    // ── Suivi : onglet suivi (ou un autre du même utilisateur), bout de la chaîne.
    const followPeers = this.followPeers();
    let target: LivePeer | null = null;
    if (this.follow && online) {
      const follow = this.follow;
      const present = followPeers.some((peer) => peer.clientId === follow.clientId);
      const clientId = present
        ? follow.clientId
        : pickClientOfUser(follow.userId, followPeers, selfClientId, (id) => this.store.lastActivity(id));
      if (clientId) {
        this.clearGrace();
        if (clientId !== follow.clientId) this.follow = { ...follow, clientId };
        const livePeer = peers.find((peer) => peer.clientId === clientId);
        if (livePeer && livePeer.name !== follow.name) this.follow = { ...this.follow, name: livePeer.name };
        // Présentation finie (ses onglets sont là, plus aucun ne présente) : on arrête de le suivre.
        const userPresenting = peers.some((peer) => peer.userId === follow.userId && peer.spotlight !== null);
        if (follow.viaSpotlight && !userPresenting) {
          notify.info('{{name}} a arrêté de présenter', { name: follow.name });
          this.follow = null;
        } else {
          const resolved = resolveFollowTarget(clientId, followPeers, selfClientId);
          target = peers.find((peer) => peer.clientId === resolved) ?? null;
        }
      } else {
        this.startGrace(follow);
      }
    }
    if (this.follow && target) this.controller?.start(target.clientId);
    else if (!this.follow) this.controller?.stop();

    const followers = peers.filter((peer) => selfClientId !== null && peer.following === selfClientId);

    // ── Ce que je publie (présence regroupée à 10 Hz par la salle). En
    // présentation, mon numéro une fois connu : redonné à chaque reconnexion,
    // ma présentation garde son identité (pas reproposée à qui l'a déclinée).
    this.publish({ following: this.follow?.clientId ?? null, spotlight: this.presenting ? (mySpotlight ?? true) : false });

    // ── Émetteur : qui regarde, qui est là.
    const joined = [...peerIds].some((id) => !this.previousPeerIds.has(id));
    this.previousPeerIds = peerIds;
    if (this.broadcaster) {
      this.broadcaster.setWatched(this.presenting || followers.length > 0);
      this.broadcaster.setOthersPresent(peers.length > 0, joined);
      if (online && !this.wasOnline) this.broadcaster.sendKeyframe();
    }
    this.wasOnline = online;
    this.overlay?.setPeers(peers);

    this.proposeSpotlight(presenter);

    const following = this.follow;
    this.emit({
      selfClientId,
      selfUserId: self?.userId ?? null,
      selfName: selfPresence?.name ?? null,
      peers,
      following,
      followTarget: target,
      presenting: this.presenting,
      presenter,
      followers,
    });
  }

  /** Nouvelle présentation : proposée une fois, suivie au bout du compte à rebours (sauf « Pas maintenant »). */
  private proposeSpotlight(presenter: LivePeer | null): void {
    if (!presenter || presenter.spotlight === null) return;
    const key = `${presenter.clientId}:${presenter.spotlight}`;
    if (this.handledSpotlights.has(key)) return;
    this.handledSpotlights.add(key);
    if (this.follow?.userId === presenter.userId) {
      // Déjà en train de le suivre : le suivi devient celui de la présentation.
      this.follow = { ...this.follow, viaSpotlight: true };
      return;
    }
    this.cancelInvite?.();
    const presenterUserId = presenter.userId;
    this.cancelInvite = notify.prompt('{{name}} présente sa vue : vous allez la suivre', { name: presenter.name }, {
      actionLabel: 'Pas maintenant',
      durationMs: SPOTLIGHT_COUNTDOWN_MS,
      onTimeout: () => {
        this.cancelInvite = null;
        const still = this.snapshot.presenter;
        if (still && still.userId === presenterUserId) this.followUser(presenterUserId, { viaSpotlight: true });
      },
      onAction: () => {
        this.cancelInvite = null;
      },
    });
  }

  private startGrace(follow: FollowState): void {
    if (this.graceTimer) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.follow?.userId !== follow.userId) return;
      const stillGone = !this.collab.peers.some((peer) => peer.userId === follow.userId && peer.clientId !== this.collab.self?.clientId);
      if (!stillGone) return;
      notify.info('{{name}} a quitté le projet', { name: follow.name });
      this.follow = null;
      this.update();
    }, FOLLOW_GRACE_MS);
  }

  private clearGrace(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  /** Présence de cet éditeur : seuls les champs changés depuis le dernier envoi (une nouvelle session repart de rien). */
  private publish(patch: Partial<PresenceUpdate>): void {
    if (!this.realtime) return;
    const desired: Partial<PresenceUpdate> = { activeItineraryId: this.activeItineraryId, ...patch };
    const changed: Partial<PresenceUpdate> = {};
    let any = false;
    for (const key of Object.keys(desired) as Array<keyof PresenceUpdate>) {
      if (this.published[key] === desired[key]) continue;
      (changed as Record<string, unknown>)[key] = desired[key];
      any = true;
    }
    if (!any) return;
    this.published = { ...this.published, ...changed };
    this.realtime.updatePresence(changed);
  }

  /** Nouvel instantané seulement si quelque chose a changé ; les pairs inchangés gardent leurs objets (pas de rendu en aval). */
  private emit(next: LivePresenceSnapshot): void {
    const previous = this.snapshot;
    const peers = samePeers(previous.peers, next.peers) ? previous.peers : next.peers;
    const followers = samePeers(previous.followers, next.followers) ? previous.followers : next.followers;
    const followTarget = samePeer(previous.followTarget, next.followTarget) ? previous.followTarget : next.followTarget;
    const presenter = samePeer(previous.presenter, next.presenter) ? previous.presenter : next.presenter;
    if (
      previous.selfClientId === next.selfClientId
      && previous.selfUserId === next.selfUserId
      && previous.selfName === next.selfName
      && previous.following === next.following
      && previous.presenting === next.presenting
      && previous.peers === peers
      && previous.followers === followers
      && previous.followTarget === followTarget
      && previous.presenter === presenter
    ) {
      return;
    }
    this.snapshot = { ...next, peers, followers, followTarget, presenter };
    for (const listener of [...this.listeners]) listener();
  }
}

function samePeer(a: LivePeer | null, b: LivePeer | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.clientId === b.clientId && a.userId === b.userId && a.name === b.name && a.following === b.following
    && a.spotlight === b.spotlight && a.activeItineraryId === b.activeItineraryId;
}

function samePeers(a: readonly LivePeer[], b: readonly LivePeer[]): boolean {
  return a.length === b.length && a.every((peer, index) => samePeer(peer, b[index]));
}
