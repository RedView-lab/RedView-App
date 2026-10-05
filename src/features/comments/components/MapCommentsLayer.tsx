import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { LngLat, Map as MapboxMap } from 'mapbox-gl';

import type { ProjectCommentThread } from '@/features/itineraryPanel/types';
import type { MapOverlayInsets } from '@/features/map3d/components/panelPlacement';
import { flyToBounds } from '@/features/map3d/lib/cameraFlight';

import { useCommentToolOptional, type CommentToolValue } from '../context/commentTool';
import { commentAnchorAt } from '../context/useCommentModeMapEvents';
import { CommentMarkerRegistry, type CommentMarkerEntry } from '../hooks/commentMarkerRegistry';
import { useCommentZoneLayer, type CommentZoneShape } from '../hooks/useCommentZoneLayer';
import { useMapAnchoredCard } from '../hooks/useMapAnchoredCard';
import { canManageThread } from '../lib/commentActions';
import { clusterPins } from '../lib/clusters';
import { isThreadUnread } from '../lib/readState';
import { CommentClusterPin, CommentDraftPin, CommentPin } from './CommentPin';
import { CommentDraftCard, CommentThreadCard } from './CommentThreadCard';
import '../styles/comments.css';

/**
 * Commentaires sur la carte 3D : bulles (marqueurs Mapbox sur le relief,
 * regroupées quand elles se chevauchent), zone du fil survolé ou ouvert, et
 * calque au-dessus des panneaux (z 40, comme la fiche POI) pour la carte du fil
 * ouvert et la saisie d'un nouveau commentaire.
 */

interface MapCommentsLayerProps {
  map: MapboxMap | null;
  overlayInsets?: MapOverlayInsets | null;
}

type PinEntry =
  | (CommentMarkerEntry & { kind: 'thread'; thread: ProjectCommentThread })
  | (CommentMarkerEntry & { kind: 'cluster'; threads: ProjectCommentThread[] })
  | (CommentMarkerEntry & { kind: 'draft' });

const CLOCK_TICK_MS = 30_000;
/** Zoom maximal d'un clic sur un groupe ; au-delà, son premier fil s'ouvre. */
const CLUSTER_MAX_ZOOM = 18;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Fils dessinés sur la carte : résolus seulement sur demande, rien quand les bulles sont masquées (Maj+C). */
function visibleThreads(tool: CommentToolValue): ProjectCommentThread[] {
  const showAll = tool.armed || !tool.pinsHidden;
  const showResolved = Boolean(tool.view?.showResolved);
  return tool.threads.filter((thread) => thread.id === tool.openThreadId
    || (showAll && (thread.resolvedAt === undefined || showResolved)));
}

export function MapCommentsLayer({ map, overlayInsets }: MapCommentsLayerProps) {
  const tool = useCommentToolOptional();
  if (!tool || !map) return null;
  return <MapCommentsLayerInner map={map} tool={tool} overlayInsets={overlayInsets} />;
}

function MapCommentsLayerInner({ map, tool, overlayInsets }: { map: MapboxMap; tool: CommentToolValue; overlayInsets?: MapOverlayInsets | null }) {
  const [registry] = useState(() => new CommentMarkerRegistry());
  const elements = useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  const now = useNow();
  // Regroupement relu à la fin de chaque mouvement de carte (nouveau rendu).
  const [, setCameraVersion] = useState(0);
  useEffect(() => {
    const bump = () => setCameraVersion((version) => version + 1);
    map.on('moveend', bump);
    map.on('resize', bump);
    return () => {
      map.off('moveend', bump);
      map.off('resize', bump);
    };
  }, [map]);

  const threads = visibleThreads(tool);
  const { openThreadId, hoveredThreadId, draft, me } = tool;
  const reads = tool.view?.reads;

  // Le fil ouvert et le survolé restent seuls (on voit ce qu'on regarde).
  const clusters = clusterPins(threads
    .filter((thread) => thread.id !== openThreadId && thread.id !== hoveredThreadId)
    .map((thread) => {
      const point = map.project([thread.anchor.lng, thread.anchor.lat]);
      return { id: thread.id, x: point.x, y: point.y };
    }));

  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const grouped = new Set<string>();
  const entries: PinEntry[] = [];
  for (const cluster of clusters) {
    if (cluster.ids.length < 2) continue;
    const members = cluster.ids.map((id) => byId.get(id)).filter((thread): thread is ProjectCommentThread => !!thread);
    members.forEach((thread) => grouped.add(thread.id));
    const first = members[0];
    entries.push({
      kind: 'cluster', key: `c:${cluster.ids.join(',')}`, lng: first.anchor.lng, lat: first.anchor.lat,
      dragThreadId: null, raised: false, threads: members,
    });
  }
  for (const thread of threads) {
    if (grouped.has(thread.id)) continue;
    entries.push({
      kind: 'thread', key: `t:${thread.id}`, lng: thread.anchor.lng, lat: thread.anchor.lat,
      dragThreadId: canManageThread(thread, me) ? thread.id : null,
      raised: thread.id === openThreadId || thread.id === hoveredThreadId,
      thread,
    });
  }
  if (draft) entries.push({ kind: 'draft', key: 'draft', lng: draft.anchor.lng, lat: draft.anchor.lat, dragThreadId: null, raised: true });

  const moveThread = tool.moveThread;
  const handleDragEnd = useCallback((threadId: string, lngLat: LngLat) => {
    moveThread({ threadId, anchor: commentAnchorAt(map, lngLat) });
  }, [map, moveThread]);

  // Liste voulue appliquée aux marqueurs après chaque rendu (rien ne change : rien n'est touché).
  useEffect(() => {
    registry.sync(map, entries, handleDragEnd);
  });
  useEffect(() => () => registry.clear(), [registry]);

  // Zone du fil survolé ou ouvert, et celle en cours de tracé / de saisie.
  const zoneShapes: CommentZoneShape[] = [];
  for (const id of new Set([openThreadId, hoveredThreadId])) {
    const zone = id ? byId.get(id)?.zone : undefined;
    if (zone) zoneShapes.push({ zone, draft: false });
  }
  if (draft?.zone) zoneShapes.push({ zone: draft.zone, draft: true });
  if (tool.dragZone) zoneShapes.push({ zone: tool.dragZone, draft: true });
  useCommentZoneLayer(map, zoneShapes);

  const { openThread, setHoveredThreadId, nameOf } = tool;
  const handleOpenPin = useCallback((threadId: string) => {
    if (registry.wasJustDragged(`t:${threadId}`)) return;
    openThread(threadId);
  }, [openThread, registry]);

  const handleOpenCluster = useCallback((threadIds: readonly string[]) => {
    const members = threads.filter((thread) => threadIds.includes(thread.id));
    if (members.length === 0) return;
    if (map.getZoom() >= CLUSTER_MAX_ZOOM - 0.5) {
      openThread(members[0].id);
      return;
    }
    const lngs = members.map((thread) => thread.anchor.lng);
    const lats = members.map((thread) => thread.anchor.lat);
    flyToBounds(map, [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], {
      maxZoom: Math.min(CLUSTER_MAX_ZOOM, map.getZoom() + 3),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
    });
  }, [map, openThread, threads]);

  const entryByKey = new Map(entries.map((entry) => [entry.key, entry]));
  const portals: ReactNode[] = [];
  for (const [key, element] of elements) {
    const entry = entryByKey.get(key);
    if (!entry) continue;
    if (entry.kind === 'thread') {
      const { thread } = entry;
      portals.push(createPortal(
        <CommentPin
          thread={thread}
          authorName={nameOf(thread.messages[0]?.authorId ?? thread.createdBy, thread.messages[0]?.authorName)}
          unread={isThreadUnread(thread, me.userId, reads)}
          open={thread.id === openThreadId}
          highlighted={thread.id === hoveredThreadId}
          now={now}
          onOpen={handleOpenPin}
          onHover={setHoveredThreadId}
        />,
        element,
        key,
      ));
    } else if (entry.kind === 'cluster') {
      portals.push(createPortal(
        <CommentClusterPin
          threads={entry.threads}
          nameOf={nameOf}
          unread={entry.threads.some((thread) => isThreadUnread(thread, me.userId, reads))}
          onOpen={handleOpenCluster}
        />,
        element,
        key,
      ));
    } else {
      portals.push(createPortal(<CommentDraftPin userId={me.userId} name={me.name} />, element, key));
    }
  }

  const openThreadData = threads.find((thread) => thread.id === openThreadId) ?? null;

  return (
    <>
      {portals}
      <div className="rv-comments-overlay">
        {draft ? (
          <AnchoredCard key="draft" map={map} anchor={draft.anchor} overlayInsets={overlayInsets}>
            <CommentDraftCard tool={tool} />
          </AnchoredCard>
        ) : null}
        {openThreadData ? (
          <AnchoredCard key={openThreadData.id} map={map} anchor={openThreadData.anchor} overlayInsets={overlayInsets}>
            <CommentThreadCard tool={tool} thread={openThreadData} now={now} />
          </AnchoredCard>
        ) : null}
      </div>
    </>
  );
}

function AnchoredCard({ map, anchor, overlayInsets, children }: {
  map: MapboxMap;
  anchor: { lng: number; lat: number };
  overlayInsets?: MapOverlayInsets | null;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useMapAnchoredCard(map, anchor, ref, overlayInsets);
  return (
    <div ref={ref} className="rv-comments-overlay__card">
      {children}
    </div>
  );
}
