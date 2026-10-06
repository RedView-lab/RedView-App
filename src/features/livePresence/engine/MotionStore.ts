import type { MotionViewport } from '@/features/collab/protocol';
import type { MotionEvent } from '@/features/collab/realtime';

import { PlayoutClock, SampleTrack, type TrackSample } from '../lib/playout';

/**
 * Flux `motion` des autres éditeurs, rejoués en différé (lib/playout) : une
 * horloge par éditeur pour tous ses flux (caméra, pointeur, graphique), qui
 * restent donc synchrones entre eux — en suivi, son curseur est exactement là
 * où il pointe sur sa vue. Hors React : les boucles d'affichage (curseurs,
 * suivi) lisent `frame()` à chaque image et dorment quand tout est au repos.
 */

interface PeerTracks {
  clock: PlayoutClock;
  /** [lng, lat, zoom, cap, inclinaison, champ] ; charge utile : sa zone visible à cet instant. */
  cam: SampleTrack<MotionViewport>;
  /** [lng, lat] ; absent hors de la carte. */
  ptr: SampleTrack;
  /** [distance (m)], identité : l'itinéraire survolé. */
  chart: SampleTrack;
  lastViewport: MotionViewport | null;
  /** Dernier message en direct reçu (temps local) : l'onglet le plus actif d'un utilisateur. */
  lastActivityAt: number;
}

export interface PeerMotionFrame {
  cam: TrackSample<MotionViewport> | null;
  ptr: TrackSample | null;
  chart: TrackSample | null;
  /** Plus rien à jouer : tout est au dernier échantillon reçu. */
  settled: boolean;
}

type Listener = (clientId: string) => void;

export class MotionStore {
  private readonly peers = new Map<string, PeerTracks>();
  private readonly listeners = new Set<Listener>();
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  ingest(event: MotionEvent, arrival = this.now()): void {
    const tracks = this.tracksOf(event.from);
    const { fields, t, snapshot } = event;
    if (!snapshot) {
      // Ses flux étaient posés (image clé de repos reçue) : un trou dans ses horodatages est un repos.
      const atRest = tracks.cam.isSettled() && tracks.ptr.isSettled() && tracks.chart.isSettled();
      tracks.clock.observe(t, arrival, atRest);
      tracks.lastActivityAt = arrival;
    }
    const put = <P>(track: SampleTrack<P>, sample: { t: number; values: number[] | null; key?: string; payload?: P }) => {
      if (snapshot) track.resetTo(sample);
      else track.push(sample);
    };
    if (fields.vp) tracks.lastViewport = fields.vp;
    if (fields.cam) put(tracks.cam, { t, values: [...fields.cam], payload: fields.vp ?? tracks.lastViewport ?? undefined });
    if (fields.ptr !== undefined) put(tracks.ptr, { t, values: fields.ptr ? [...fields.ptr] : null });
    if (fields.chart !== undefined) {
      put(tracks.chart, fields.chart ? { t, values: [fields.chart[1]], key: fields.chart[0] } : { t, values: null });
    }
    for (const listener of [...this.listeners]) listener(event.from);
  }

  /** Ce qu'il faut afficher de `clientId` maintenant (null : rien reçu de lui). */
  frame(clientId: string, now = this.now()): PeerMotionFrame | null {
    const tracks = this.peers.get(clientId);
    if (!tracks) return null;
    const time = tracks.clock.playbackTime(now);
    const cam = tracks.cam.sample(time);
    const ptr = tracks.ptr.sample(time);
    const chart = tracks.chart.sample(time);
    return {
      cam,
      ptr,
      chart,
      settled: (cam?.settled ?? true) && (ptr?.settled ?? true) && (chart?.settled ?? true),
    };
  }

  has(clientId: string): boolean {
    return this.peers.has(clientId);
  }

  clientIds(): string[] {
    return [...this.peers.keys()];
  }

  /** Dernier message en direct de `clientId` (temps local), `-Infinity` sans. */
  lastActivity(clientId: string): number {
    return this.peers.get(clientId)?.lastActivityAt ?? Number.NEGATIVE_INFINITY;
  }

  /** Éditeurs partis (ou session coupée) oubliés. */
  retain(clientIds: ReadonlySet<string>): void {
    for (const clientId of [...this.peers.keys()]) {
      if (clientIds.has(clientId)) continue;
      this.peers.delete(clientId);
      for (const listener of [...this.listeners]) listener(clientId);
    }
  }

  /** Appelé à chaque message reçu (et au départ d'un éditeur) : de quoi réveiller une boucle d'affichage. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    const ids = [...this.peers.keys()];
    this.peers.clear();
    for (const clientId of ids) for (const listener of [...this.listeners]) listener(clientId);
  }

  private tracksOf(clientId: string): PeerTracks {
    let tracks = this.peers.get(clientId);
    if (!tracks) {
      tracks = {
        clock: new PlayoutClock(),
        cam: new SampleTrack<MotionViewport>({ wrap: [0, 3] }),
        ptr: new SampleTrack({ wrap: [0] }),
        chart: new SampleTrack(),
        lastViewport: null,
        lastActivityAt: Number.NEGATIVE_INFINITY,
      };
      this.peers.set(clientId, tracks);
    }
    return tracks;
  }
}
