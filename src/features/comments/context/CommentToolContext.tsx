import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';

import { useProjectStoreOptional } from '@/features/itineraryPanel/context/ProjectStore/hooks';
import { listenItineraryMapAction } from '@/features/itineraryPanel/lib/mapActionBridge';
import { createDocumentId } from '@/features/itineraryPanel/lib/project/ids';
import type {
  ProjectCommentAnchor,
  ProjectCommentsView,
  ProjectCommentThread,
  ProjectCommentZone,
} from '@/features/itineraryPanel/types';
import { flyToLocation } from '@/features/map3d/lib/cameraFlight';
import { getCameraOwner } from '@/features/map3d/lib/cameraOwnership';
import { translateAppText } from '@/shared/i18n';

import { useLidarCommentSync } from '../bridge/useLidarCommentSync';
import {
  applyCommentAction,
  findThread,
  type CommentAction,
  type CommentAuthor,
  type CommentTextInput,
} from '../lib/commentActions';
import { mergeMentionCandidates } from '../lib/identity';
import type { MentionCandidate } from '../lib/messageText';
import { countUnreadThreads, markThreadRead, markThreadUnread, pruneReadMarks } from '../lib/readState';
import type { CommentZoneDrawing } from '../lib/zoneDrawing';
import {
  CommentToolContext,
  type CommentDraft,
  type CommentSubTool,
  type CommentToolValue,
  type ThreadAction,
} from './commentTool';
import { commentAnchorAt, useCommentModeMapEvents } from './useCommentModeMapEvents';

/**
 * Mode commentaire et état des bulles, comme l'outil Commentaire de Figma :
 *  - mode (touche C, bouton de la barre d'outils) : clic sur la carte = bulle,
 *    Maj + glisser (ou sous-outil « zone ») = commentaire de zone ;
 *  - fil ouvert (carte à côté de sa bulle), saisie d'un nouveau commentaire,
 *    bulle survolée (depuis la carte ou la liste) ;
 *  - écritures par le réducteur unique (lib/commentActions.ts) et le canal
 *    `commitComments` du ProjectStore (jamais dans annuler) ; lu / non lu et
 *    options de la liste dans la vue de l'utilisateur.
 * Les bulles restent visibles et cliquables hors du mode (Maj+C les masque).
 */

interface CommentToolProviderProps {
  children: ReactNode;
  map: MapboxMap | null;
  /** Projet ouvert (pont vers le viewer LiDAR). */
  projectId?: string | null;
  me: CommentAuthor;
  /** Membres du projet partagé et éditeurs présents (mentions et noms). */
  members?: readonly MentionCandidate[];
}

/** Zoom minimal pour « aller au commentaire » quand l'auteur n'a pas laissé de point de vue. */
const FOCUS_MIN_ZOOM = 13;

export function CommentToolProvider({ children, map, projectId = null, me, members: memberList = [] }: CommentToolProviderProps) {
  const store = useProjectStoreOptional();
  const project = store?.project ?? null;
  const threads = useMemo(() => project?.comments ?? [], [project?.comments]);
  const view = project?.commentsView;
  const activeItinerary = project?.itineraries.find((itinerary) => itinerary.id === project.activeItineraryId) ?? null;

  const [armed, setArmed] = useState(false);
  const [subTool, setSubTool] = useState<CommentSubTool>('point');
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [draftFocusRequest, setDraftFocusRequest] = useState(0);
  const [dragZone, setDragZone] = useState<ProjectCommentZone | null>(null);
  const [zoneDrawing, setZoneDrawing] = useState<CommentZoneDrawing | null>(null);
  const draftTextRef = useRef('');

  const members = useMemo(() => mergeMentionCandidates([{ userId: me.userId, name: me.name }], memberList), [me, memberList]);
  const nameOf = useCallback((userId: string, fallback?: string) => {
    return members.find((member) => member.userId === userId)?.name ?? (fallback || translateAppText('Éditeur'));
  }, [members]);

  // Lu en dernier : les rappels gardent une identité stable.
  const openThreadData = findThread(threads, openThreadId);
  // Fil supprimé (par son créateur, ailleurs) : la carte se ferme.
  const visibleOpenThreadId = openThreadData ? openThreadId : null;
  const latest = useRef({ store, threads, view, map, me, openThreadId: visibleOpenThreadId, draft });
  useEffect(() => {
    latest.current = { store, threads, view, map, me, openThreadId: visibleOpenThreadId, draft };
  });

  const commit = useCallback((action: CommentAction): boolean => {
    const { store: current, me: author } = latest.current;
    if (!current) return false;
    return current.commitComments((comments) => applyCommentAction(comments, action, author));
  }, []);

  const updateView = useCallback((update: (view: ProjectCommentsView | undefined) => ProjectCommentsView | undefined) => {
    const current = latest.current.store;
    if (!current) return;
    current.setProject((prev) => {
      const next = update(prev.commentsView);
      return next === prev.commentsView ? prev : { ...prev, commentsView: next };
    });
  }, []);

  // ── Mode ───────────────────────────────────────────────────────────────
  const deactivate = useCallback(() => {
    setArmed(false);
    setDragZone(null);
    setZoneDrawing(null);
  }, []);
  const arm = useCallback((next: CommentSubTool = 'point') => {
    setSubTool(next);
    setArmed(true);
  }, []);
  const toggle = useCallback(() => {
    setArmed((current) => !current);
    setSubTool('point');
    setDragZone(null);
    setZoneDrawing(null);
  }, []);

  // ── Fil ouvert, saisie ─────────────────────────────────────────────────
  const flyToThread = useCallback((thread: ProjectCommentThread) => {
    const target = latest.current.map;
    if (!target || getCameraOwner() === 'flyover') return;
    const camera = thread.camera;
    flyToLocation(target, { lon: thread.anchor.lng, lat: thread.anchor.lat }, {
      zoom: camera?.zoom ?? Math.max(target.getZoom(), FOCUS_MIN_ZOOM),
      pitch: camera?.pitch ?? target.getPitch(),
      bearing: camera?.bearing ?? target.getBearing(),
    });
  }, []);

  const openThread = useCallback((threadId: string, options?: { fly?: boolean }) => {
    const thread = findThread(latest.current.threads, threadId);
    if (!thread) return;
    setDraft(null);
    draftTextRef.current = '';
    setOpenThreadId(threadId);
    if (options?.fly) flyToThread(thread);
  }, [flyToThread]);

  const closeThread = useCallback(() => setOpenThreadId(null), []);

  const startDraft = useCallback((next: CommentDraft) => {
    // Un texte en cours n'est jamais perdu : on y ramène le curseur.
    if (latest.current.draft && draftTextRef.current.trim()) {
      setDraftFocusRequest((request) => request + 1);
      return;
    }
    setOpenThreadId(null);
    draftTextRef.current = '';
    setDraft(next);
  }, []);

  const cancelDraft = useCallback(() => {
    draftTextRef.current = '';
    setDraft(null);
    setDragZone(null);
  }, []);

  const submitDraft = useCallback((input: CommentTextInput) => {
    const current = latest.current.draft;
    if (!current) return false;
    const target = latest.current.map;
    const threadId = createDocumentId('cm');
    const ok = commit({
      type: 'create-thread',
      threadId,
      messageId: createDocumentId('cmm'),
      anchor: current.anchor,
      ...(current.zone ? { zone: current.zone } : {}),
      ...(target ? { camera: { zoom: target.getZoom(), pitch: target.getPitch(), bearing: target.getBearing() } } : {}),
      text: input.text,
      ...(input.mentions?.length ? { mentions: input.mentions } : {}),
      at: new Date().toISOString(),
    });
    if (!ok) return false;
    draftTextRef.current = '';
    setDraft(null);
    setDragZone(null);
    setOpenThreadId(threadId);
    return true;
  }, [commit]);

  // ── Écritures ──────────────────────────────────────────────────────────
  const reply = useCallback((threadId: string, input: CommentTextInput) => commit({
    type: 'reply', threadId, messageId: createDocumentId('cmm'), text: input.text, mentions: input.mentions, at: new Date().toISOString(),
  }), [commit]);
  const editMessage = useCallback((threadId: string, messageId: string, input: CommentTextInput) => commit({
    type: 'edit-message', threadId, messageId, text: input.text, mentions: input.mentions, at: new Date().toISOString(),
  }), [commit]);
  const deleteMessage = useCallback((threadId: string, messageId: string) => commit({ type: 'delete-message', threadId, messageId }), [commit]);
  const deleteThread = useCallback((threadId: string) => commit({ type: 'delete-thread', threadId }), [commit]);
  const setResolved = useCallback((threadId: string, resolved: boolean) => commit({
    type: 'set-resolved', threadId, resolved, at: new Date().toISOString(),
  }), [commit]);
  const toggleReaction = useCallback((threadId: string, messageId: string, emoji: string) => commit({
    type: 'toggle-reaction', threadId, messageId, emoji,
  }), [commit]);
  const moveThread = useCallback((action: ThreadAction<'move-thread'>) => commit({ type: 'move-thread', ...action }), [commit]);

  const markUnread = useCallback((threadId: string) => {
    updateView((current) => markThreadUnread(current, threadId));
    setOpenThreadId((open) => (open === threadId ? null : open));
  }, [updateView]);

  const setViewOptions = useCallback((patch: Partial<Omit<ProjectCommentsView, 'reads'>>) => {
    updateView((current) => {
      const next = { ...current, ...patch };
      return Object.keys(patch).every((key) => current?.[key as keyof ProjectCommentsView] === next[key as keyof ProjectCommentsView]) ? current : next;
    });
  }, [updateView]);

  const pinsHidden = Boolean(view?.hidden);
  const togglePinsHidden = useCallback(() => {
    updateView((current) => ({ ...current, hidden: !current?.hidden }));
  }, [updateView]);

  // Fil ouvert = lu (jusqu'à son dernier message, y compris ceux qui arrivent
  // pendant qu'il est ouvert ; déjà lu : la vue reste la même, rien n'est écrit).
  useEffect(() => {
    if (!openThreadData) return;
    updateView((current) => markThreadRead(current, openThreadData));
  }, [openThreadData, updateView]);

  // Repères de lecture des fils supprimés : retirés.
  useEffect(() => {
    if (!view?.reads) return;
    const pruned = pruneReadMarks(view, threads);
    if (pruned !== view) updateView(() => pruned);
  }, [threads, updateView, view]);

  const unreadCount = useMemo(() => countUnreadThreads(threads, me.userId, view?.reads), [me.userId, threads, view?.reads]);

  // Viewer LiDAR (autre onglet) : mêmes fils, ses actions passent par le même réducteur.
  const markReadFromViewer = useCallback((threadId: string) => {
    const thread = findThread(latest.current.threads, threadId);
    if (thread) updateView((current) => markThreadRead(current, thread));
  }, [updateView]);
  useLidarCommentSync({
    projectId,
    me,
    members,
    threads,
    reads: view?.reads,
    onAction: commit,
    onMarkRead: markReadFromViewer,
    onMarkUnread: markUnread,
  });

  const navigate = useCallback((direction: 1 | -1) => {
    const list = latest.current.threads.filter((thread) => thread.resolvedAt === undefined || thread.id === latest.current.openThreadId);
    if (list.length === 0) return;
    const index = list.findIndex((thread) => thread.id === latest.current.openThreadId);
    const next = list[(index + direction + list.length) % list.length];
    openThread(next.id, { fly: true });
  }, [openThread]);

  // ── Carte en mode commentaire ──────────────────────────────────────────
  const handlePoint = useCallback((anchor: ProjectCommentAnchor) => {
    const { openThreadId: open, draft: current } = latest.current;
    // Premier clic : ferme ce qui est ouvert (comme Figma), le suivant pose une bulle.
    if (open) {
      setOpenThreadId(null);
      return;
    }
    if (current && !draftTextRef.current.trim()) {
      cancelDraft();
      return;
    }
    startDraft({ anchor });
  }, [cancelDraft, startDraft]);

  const handleZone = useCallback((anchor: ProjectCommentAnchor, zone: ProjectCommentZone) => {
    setDragZone(null);
    startDraft({ anchor, zone });
  }, [startDraft]);

  // Premier sommet d'une zone polygonale : comme une bulle, ce clic ferme d'abord ce qui est ouvert.
  const handleZoneStart = useCallback(() => {
    const { openThreadId: open, draft: current } = latest.current;
    if (open) {
      setOpenThreadId(null);
      return false;
    }
    if (current) {
      if (draftTextRef.current.trim()) setDraftFocusRequest((request) => request + 1);
      else cancelDraft();
      return false;
    }
    return true;
  }, [cancelDraft]);

  useCommentModeMapEvents({
    map,
    armed,
    subTool,
    onPoint: handlePoint,
    onZonePreview: setDragZone,
    onZone: handleZone,
    onZoneStart: handleZoneStart,
    onZoneDrawing: setZoneDrawing,
  });

  // Hors du mode : un clic sur la carte ferme le fil ouvert, ou la saisie vide (comme Figma).
  const hasOpenCard = visibleOpenThreadId !== null || draft !== null;
  useEffect(() => {
    if (!map || armed || !hasOpenCard) return;
    const handleClick = (event: MapMouseEvent) => {
      const target = event.originalEvent?.target;
      if (target instanceof Element && target.closest('[data-rv-comment-pin], [data-rv-comment-card]')) return;
      if (latest.current.draft) {
        if (!draftTextRef.current.trim()) cancelDraft();
        else setDraftFocusRequest((request) => request + 1);
        return;
      }
      setOpenThreadId(null);
    };
    map.on('click', handleClick);
    return () => {
      map.off('click', handleClick);
    };
  }, [armed, cancelDraft, hasOpenCard, map]);

  // « Commenter ici » (menu du clic droit de la carte) : saisie à ce point, sans passer par le mode.
  useEffect(() => listenItineraryMapAction((detail) => {
    if (detail.kind !== 'context-menu' || detail.payload.action !== 'add-comment') return;
    const { point } = detail.payload;
    const target = latest.current.map;
    startDraft({
      anchor: target
        ? commentAnchorAt(target, { lng: point.lng, lat: point.lat })
        : { lng: point.lng, lat: point.lat, elevationM: point.elevationMeters },
    });
  }), [startDraft]);

  const statusMessage = armed
    ? subTool === 'zone'
      ? zoneDrawing
        ? translateAppText('Cliquez sur un point pour fermer la zone · Entrée termine, Échap annule')
        : translateAppText('Cliquez pour poser les points de la zone, Maj + glisser pour un rectangle')
      : translateAppText('Cliquez pour commenter, Maj + glisser pour une zone')
    : null;

  const value = useMemo<CommentToolValue>(() => ({
    me,
    threads,
    view,
    members,
    nameOf,
    activeItinerary,
    armed,
    subTool,
    arm,
    toggle,
    deactivate,
    statusMessage,
    openThreadId: visibleOpenThreadId,
    openThread,
    closeThread,
    hoveredThreadId,
    setHoveredThreadId,
    draft,
    startDraft,
    cancelDraft,
    submitDraft,
    draftTextRef,
    draftFocusRequest,
    dragZone,
    zoneDrawing,
    reply,
    editMessage,
    deleteMessage,
    deleteThread,
    setResolved,
    toggleReaction,
    moveThread,
    markUnread,
    setViewOptions,
    pinsHidden,
    togglePinsHidden,
    unreadCount,
    flyToThread,
    navigate,
  }), [
    activeItinerary, arm, armed, cancelDraft, closeThread, deactivate, deleteMessage, deleteThread, draft, draftFocusRequest,
    dragZone, zoneDrawing, editMessage, flyToThread, hoveredThreadId, markUnread, me, members, moveThread, nameOf, navigate, openThread,
    visibleOpenThreadId, pinsHidden, reply, setResolved, setViewOptions, startDraft, statusMessage, subTool, submitDraft, threads,
    toggle, togglePinsHidden, toggleReaction, unreadCount, view,
  ]);

  return <CommentToolContext.Provider value={value}>{children}</CommentToolContext.Provider>;
}
