import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import type { CollabState } from '@/features/collab/client/collabClient';
import type { CollabRealtime } from '@/features/collab/realtime';

import type { LivePresenceValue } from '../context/LivePresenceContext';
import { LivePresenceSession, type CollabPresenceInput } from '../engine/LivePresenceSession';

/**
 * Présence en direct du projet ouvert (curseurs, suivre un éditeur,
 * Spotlight) : une session hors React par éditeur monté, nourrie par la
 * carte et la session de co-édition, lue par `useSyncExternalStore`. Null
 * sans session de co-édition (projet solo).
 */
export function useLivePresence({
  map,
  realtime,
  collabState,
}: {
  map: MapboxMap | null;
  realtime: CollabRealtime | null;
  collabState: CollabState | null;
}): LivePresenceValue | null {
  const [session] = useState(() => new LivePresenceSession());

  useEffect(() => () => session.dispose(), [session]);
  useEffect(() => {
    session.setRealtime(realtime);
  }, [realtime, session]);
  useEffect(() => {
    session.setMap(map);
  }, [map, session]);

  const peers = collabState?.peers;
  const self = collabState?.self ?? null;
  const online = collabState?.status === 'online';
  const collab = useMemo<CollabPresenceInput | null>(
    () => (peers ? { peers, self, online } : null),
    [online, peers, self],
  );
  useEffect(() => {
    session.setCollab(collab);
  }, [collab, session]);

  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);

  // Actions stables : les effets qui en dépendent ne repartent pas à chaque changement de présence.
  const actions = useMemo(() => ({
    store: session.store,
    followUser: (userId: string, options?: { viaSpotlight?: boolean }) => session.followUser(userId, options),
    stopFollowing: () => session.stopFollowing(),
    setPresenting: (on: boolean) => session.setPresenting(on),
    publishActiveItinerary: (itineraryId: string | null) => session.publishActiveItinerary(itineraryId),
    setChartPointResolver: (resolver: Parameters<LivePresenceSession['setChartPointResolver']>[0]) => session.setChartPointResolver(resolver),
  }), [session]);

  return useMemo<LivePresenceValue | null>(
    () => (realtime ? { ...snapshot, ...actions } : null),
    [actions, realtime, snapshot],
  );
}
