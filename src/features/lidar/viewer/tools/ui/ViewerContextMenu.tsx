// ============================================
// Viewer LiDAR — menu du clic droit
// ============================================
//
// Même menu que sur la carte RedView (carte en verre, en-tête du point,
// coordonnées, pente et altitude, actions de tracé). Les outils du viewer sont
// rangés dans deux sous-menus (« Mesurer › », « Analyser le terrain › ») qui
// s'ouvrent à côté du menu au survol, avec un court délai d'intention pour
// qu'un mouvement en diagonale vers un sous-menu ouvert ne le change pas ; la
// vue à la première personne et les actions de caméra restent à un clic.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { translateAppText as t } from '@/shared/i18n/config';
import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import { appScaledOverlayStyle, readRootAppScale } from '@/shared/lib/appScale';
import { computePanelPosition, resolvePanelPlacement } from '@/features/map3d/components/panelPlacement';
import {
  CommentGlyph,
  CopyButtonIcon,
  ElevationGlyph,
  FinishGlyph,
  GlobeGlyph,
  SlopeGlyph,
  StartGlyph,
  TrashGlyph,
  WaypointGlyph,
} from '@/features/map3d/components/MapContextMenu/icons';
import { copyTextToClipboard } from '@/features/map3d/components/MapContextMenu/utils';
import { classificationLabel } from '../classification';
import {
  buildTopoMapUrl,
  COORDINATE_FORMATS,
  formatAltitude,
  formatAngle,
  formatAspect,
  formatCoordinates,
  formatDistance,
  type CoordinateFormat,
} from '../format';
import { TOOL_SHORTCUTS } from '../shortcuts';
import { slopeBandOf } from '../terrain/slopeBands';
import type { ToolId } from '../types';
import {
  AreaGlyph,
  AvalancheGlyph,
  CenterGlyph,
  ChevronGlyph,
  DistanceGlyph,
  FaceSlopeGlyph,
  FallLineGlyph,
  HeightGlyph,
  LookAroundGlyph,
  MeasureGlyph,
  PinGlyph,
  PointsGlyph,
  ProfileGlyph,
  TerrainGlyph,
  TerrainAnalysisGlyph,
  ViewshedGlyph,
} from './glyphs';
import type { ContextMenuAction, ContextMenuModel, ToolsUiActions } from './toolsUiStore';

const MENU_EDGE_PADDING = 8;
const SUBMENU_GAP = 4;
/** Un sous-menu ne change qu'après que le pointeur s'est posé aussi longtemps sur un autre déclencheur (ms). */
const SUBMENU_INTENT_MS = 140;
const COORDINATE_FORMAT_STORAGE_KEY = 'rv-lidar-coordinate-format';
/** Un retour à cette hauteur au-dessus du modèle de sol affiche sa hauteur, m. */
const MIN_SHOWN_HEIGHT_M = 0.5;
/** Touche de la vue à la première personne (gérée par le contrôleur des outils). */
const LOOK_AROUND_SHORTCUT = 'O';

type SubmenuId = 'measure' | 'terrain';

interface SubmenuItem {
  tool: ToolId;
  icon: ReactNode;
  label: string;
  /** Seconde ligne, atténuée, sous le libellé. */
  note?: string;
  title?: string;
}

function submenuItems(id: SubmenuId): SubmenuItem[] {
  if (id === 'measure') {
    return [
      { tool: 'distance', icon: <DistanceGlyph />, label: t('Distance'), title: t('Distance au sol, à plat et directe, D+ / D−') },
      { tool: 'height', icon: <HeightGlyph />, label: t('Dénivelé et angle'), title: t('Hauteur, distance et angle entre deux points') },
      { tool: 'area', icon: <AreaGlyph />, label: t('Surface'), title: t('Surface drapée sur le relief, pentes et orientation') },
      { tool: 'profile', icon: <ProfileGlyph />, label: t('Profil'), title: t('Profil du terrain le long d’une ligne') },
      { tool: 'pin', icon: <PinGlyph />, label: t('Épingler le point') },
    ];
  }
  return [
    { tool: 'fallLine', icon: <FallLineGlyph />, label: t('Ligne de pente'), title: t('Où part une glissade ou une pierre lâchée ici') },
    {
      tool: 'avalanche',
      icon: <AvalancheGlyph />,
      label: t('Exposition avalanche'),
      note: t('(d’après le terrain, pas la neige)'),
      title: t('Classe ATES de ce point : zones de départ, avalanches qui peuvent l’atteindre et forêt, sans la neige du jour'),
    },
    { tool: 'viewshed', icon: <ViewshedGlyph />, label: t('Zones visibles d’ici'), title: t('Tout le terrain visible depuis ce point, œil à 1,7 m') },
  ];
}

function readStoredFormat(): CoordinateFormat {
  try {
    const stored = window.localStorage.getItem(COORDINATE_FORMAT_STORAGE_KEY);
    if (stored && (COORDINATE_FORMATS as readonly string[]).includes(stored)) return stored as CoordinateFormat;
  } catch {
    /* stockage indisponible */
  }
  return 'dd';
}

function storeFormat(format: CoordinateFormat): void {
  try {
    window.localStorage.setItem(COORDINATE_FORMAT_STORAGE_KEY, format);
  } catch {
    /* stockage indisponible */
  }
}

interface ViewerContextMenuProps {
  model: ContextMenuModel;
  actions: ToolsUiActions;
}

export function ViewerContextMenu({ model, actions }: ViewerContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const triggerRefs = useRef<Record<SubmenuId, HTMLButtonElement | null>>({ measure: null, terrain: null });
  const intentTimerRef = useRef<number | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const [position, setPosition] = useState<CSSProperties>({ left: 0, top: 0, visibility: 'hidden' });
  const [submenu, setSubmenu] = useState<SubmenuId | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState<CSSProperties>({ left: 0, top: 0, visibility: 'hidden' });
  const [format, setFormat] = useState<CoordinateFormat>(readStoredFormat);
  const [copied, setCopied] = useState(false);
  const { pick, slope } = model;

  // S'ouvre à côté du clic, vers le côté libre le plus grand, dans la fenêtre.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const scale = readRootAppScale();
    const width = el.offsetWidth * scale;
    const height = el.offsetHeight * scale;
    const placement = resolvePanelPlacement(model.clientX, model.clientY, window.innerWidth, window.innerHeight);
    const pos = computePanelPosition(
      model.clientX,
      model.clientY,
      width,
      height,
      window.innerWidth,
      window.innerHeight,
      MENU_EDGE_PADDING,
      placement,
    );
    // Le coin au clic reste carré, comme sur la carte.
    const corner = `border${placement.vertical === 'down' ? 'Top' : 'Bottom'}${placement.horizontal === 'right' ? 'Left' : 'Right'}Radius`;
    setPosition({ ...appScaledOverlayStyle({ top: pos.top, left: pos.left, scale }), [corner]: 0 });
    setSubmenu(null);
  }, [model]);

  // Le sous-menu s'ouvre du côté où il y a de la place, sa première ligne au niveau du déclencheur.
  useLayoutEffect(() => {
    const trigger = submenu ? triggerRefs.current[submenu] : null;
    const menu = menuRef.current;
    const flyout = submenuRef.current;
    if (!trigger || !menu || !flyout) return;
    const scale = readRootAppScale();
    const menuRect = menu.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const width = flyout.offsetWidth * scale;
    const height = flyout.offsetHeight * scale;
    const gap = SUBMENU_GAP * scale;
    const right = menuRect.right + gap;
    const left = right + width <= window.innerWidth - MENU_EDGE_PADDING ? right : menuRect.left - gap - width;
    const top = Math.max(
      MENU_EDGE_PADDING,
      Math.min(window.innerHeight - height - MENU_EDGE_PADDING, triggerRect.top - 6 * scale),
    );
    setSubmenuPosition(appScaledOverlayStyle({ top, left: Math.max(MENU_EDGE_PADDING, left), scale }));
  }, [submenu]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || submenuRef.current?.contains(target)) return;
      actions.closeMenu();
    };
    const close = () => actions.closeMenu();
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('wheel', close, { capture: true, passive: true });
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('wheel', close, { capture: true });
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [actions]);

  useEffect(() => () => {
    if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
    if (intentTimerRef.current != null) window.clearTimeout(intentTimerRef.current);
  }, []);

  const clearIntent = () => {
    if (intentTimerRef.current != null) window.clearTimeout(intentTimerRef.current);
    intentTimerRef.current = null;
  };
  const switchSubmenu = (next: SubmenuId | null, immediate: boolean) => {
    clearIntent();
    if (immediate) setSubmenu(next);
    else intentTimerRef.current = window.setTimeout(() => setSubmenu(next), SUBMENU_INTENT_MS);
  };

  const coordinates = formatCoordinates(pick.lon, pick.lat, format, model.crs);

  const cycleFormat = useCallback(() => {
    setFormat((current) => {
      const next = COORDINATE_FORMATS[(COORDINATE_FORMATS.indexOf(current) + 1) % COORDINATE_FORMATS.length]!;
      storeFormat(next);
      return next;
    });
  }, []);

  const copyCoordinates = useCallback(async () => {
    try {
      await copyTextToClipboard(coordinates.clipboard);
      setCopied(true);
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      actions.notify(t('Copie impossible'));
    }
  }, [actions, coordinates.clipboard]);

  const run = (action: ContextMenuAction) => actions.onMenuAction(action);
  const heightAboveGround = pick.source === 'points' && pick.groundAltitudeM != null
    ? pick.altitudeM - pick.groundAltitudeM
    : null;
  const title = pick.source === 'points' && pick.classification != null
    ? t(classificationLabel(pick.classification))
    : t('Sol (modèle de terrain)');
  /** Les lignes simples ferment un sous-menu ouvert après le délai d'intention. */
  const plainRowHover = () => {
    if (submenu) switchSubmenu(null, false);
  };

  return (
    <>
      <div ref={menuRef} role="menu" aria-label={t('Menu contextuel du viewer')} className="rv-lidar-ctx" style={position}>
        <MapCanvasGlassBackdrop blur={60} saturate={1.6} tint="rgba(15, 15, 15, 0.74)" />

        <div className="rv-lidar-ctx__header">
          <span className="rv-lidar-ctx__icon-box" aria-hidden>
            {pick.source === 'points' ? <PointsGlyph /> : <TerrainGlyph />}
          </span>
          <span className="rv-lidar-ctx__title">{title}</span>
          <button
            type="button"
            role="menuitem"
            className="rv-lidar-ctx__icon-button"
            onClick={() => window.open(buildTopoMapUrl(pick.lon, pick.lat, model.crs), '_blank', 'noopener,noreferrer')}
            aria-label={t('Ouvrir la carte topographique')}
            title={t('Ouvrir la carte topographique')}
          >
            <GlobeGlyph />
          </button>
        </div>

        <div className="rv-lidar-ctx__meta">
          <div className="rv-lidar-ctx__meta-row">
            <button
              type="button"
              role="menuitem"
              className="rv-lidar-ctx__system"
              onClick={cycleFormat}
              title={t('Changer de système de coordonnées')}
            >
              {coordinates.system}
            </button>
            <span className="rv-lidar-ctx__coords" title={coordinates.clipboard}>{coordinates.value}</span>
            <button
              type="button"
              role="menuitem"
              className="rv-lidar-ctx__icon-button rv-lidar-ctx__icon-button--small"
              onClick={() => void copyCoordinates()}
              aria-label={t('Copier les coordonnées')}
              title={t('Copier les coordonnées')}
            >
              <CopyButtonIcon copied={copied} />
            </button>
          </div>
          <div className="rv-lidar-ctx__meta-row">
            {slope ? (
              <span className="rv-lidar-ctx__fact" title={t('Pente sur 6 m et orientation')}>
                <SlopeGlyph />
                <span className="rv-lidar-ctx__band" style={{ background: slopeBandOf(slope.slopeDeg).color }} aria-hidden />
                {formatAngle(slope.slopeDeg)} {formatAspect(slope.aspectDeg)}
              </span>
            ) : null}
            <span className="rv-lidar-ctx__fact">
              <ElevationGlyph />
              {formatAltitude(pick.altitudeM)}
            </span>
            {heightAboveGround != null && heightAboveGround >= MIN_SHOWN_HEIGHT_M ? (
              <span className="rv-lidar-ctx__fact" title={t('Hauteur au-dessus du sol')}>
                ↕ {formatDistance(heightAboveGround)} {t('/ sol')}
              </span>
            ) : null}
          </div>
        </div>

        <div className="rv-lidar-ctx__separator" role="separator" />

        <div className="rv-lidar-ctx__rows">
          <SubmenuTrigger
            id="measure"
            icon={<MeasureGlyph />}
            label={t('Mesurer')}
            open={submenu === 'measure'}
            buttonRef={(el) => { triggerRefs.current.measure = el; }}
            onHover={() => switchSubmenu('measure', submenu == null)}
            onOpen={() => switchSubmenu(submenu === 'measure' ? null : 'measure', true)}
          />
          <SubmenuTrigger
            id="terrain"
            icon={<TerrainAnalysisGlyph />}
            label={t('Analyser le terrain')}
            open={submenu === 'terrain'}
            buttonRef={(el) => { triggerRefs.current.terrain = el; }}
            onHover={() => switchSubmenu('terrain', submenu == null)}
            onOpen={() => switchSubmenu(submenu === 'terrain' ? null : 'terrain', true)}
          />
          <MenuRow
            icon={<LookAroundGlyph />}
            label={t('Vue 360° d’ici')}
            title={t('Se placer ici à hauteur d’œil et regarder autour (champ humain, jumelles)')}
            shortcut={LOOK_AROUND_SHORTCUT}
            onHover={plainRowHover}
            onClick={() => run({ type: 'lookAround' })}
          />
          <MenuRow icon={<CenterGlyph />} label={t('Centrer ici')} onHover={plainRowHover} onClick={() => run({ type: 'center' })} />
          <MenuRow
            icon={<FaceSlopeGlyph />}
            label={t('Face à la pente')}
            title={t('Regarder la pente de face : ni écrasée ni exagérée par la perspective')}
            disabled={!slope}
            onHover={plainRowHover}
            onClick={() => run({ type: 'faceSlope' })}
          />
        </div>

        <div className="rv-lidar-ctx__separator" aria-hidden />

        <div className="rv-lidar-ctx__rows">
          <MenuRow icon={<StartGlyph />} label={t('Démarrer ici')} onHover={plainRowHover} onClick={() => run({ type: 'route', position: 'start' })} />
          {model.routeHasStart ? (
            <>
              <MenuRow
                icon={<WaypointGlyph />}
                label={t('Ajouter une étape')}
                onHover={plainRowHover}
                onClick={() => run({ type: 'route', position: 'waypoint' })}
              />
              <MenuRow icon={<FinishGlyph />} label={t('Finir ici')} onHover={plainRowHover} onClick={() => run({ type: 'route', position: 'end' })} />
            </>
          ) : null}
        </div>

        {model.commentsEnabled ? (
          <>
            <div className="rv-lidar-ctx__separator" aria-hidden />
            <div className="rv-lidar-ctx__rows">
              <MenuRow icon={<CommentGlyph />} label={t('Commenter ici')} onHover={plainRowHover} onClick={() => run({ type: 'comment' })} />
              <MenuRow
                icon={<AreaGlyph />}
                label={t('Commenter une zone')}
                title={t('Cliquez les sommets de la zone, clic droit pour fermer')}
                onHover={plainRowHover}
                onClick={() => run({ type: 'commentZone' })}
              />
            </div>
          </>
        ) : null}

        {model.measurementId || model.measurementCount > 0 ? (
          <>
            <div className="rv-lidar-ctx__separator" aria-hidden />
            <div className="rv-lidar-ctx__rows">
              {model.measurementId ? (
                <MenuRow
                  icon={<TrashGlyph />}
                  label={t('Supprimer cette mesure')}
                  onHover={plainRowHover}
                  onClick={() => run({ type: 'deleteMeasurement', id: model.measurementId! })}
                />
              ) : null}
              {model.measurementCount > 0 ? (
                <MenuRow
                  icon={<TrashGlyph />}
                  label={t('Effacer les mesures ({{count}})', { count: model.measurementCount })}
                  onHover={plainRowHover}
                  onClick={() => run({ type: 'clearMeasurements' })}
                />
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      {submenu ? (
        <div
          ref={submenuRef}
          role="menu"
          aria-label={submenu === 'measure' ? t('Mesurer') : t('Analyser le terrain')}
          className="rv-lidar-ctx rv-lidar-ctx--submenu"
          style={submenuPosition}
          onMouseEnter={clearIntent}
        >
          <MapCanvasGlassBackdrop blur={60} saturate={1.6} tint="rgba(15, 15, 15, 0.8)" />
          <div className="rv-lidar-ctx__rows">
            {submenuItems(submenu).map((item) => (
              <MenuRow
                key={item.tool}
                icon={item.icon}
                label={item.label}
                note={item.note}
                title={item.title}
                shortcut={TOOL_SHORTCUTS[item.tool]?.toUpperCase()}
                onClick={() => run({ type: 'tool', tool: item.tool })}
              />
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

function MenuRow({
  icon,
  label,
  note,
  title,
  shortcut,
  disabled,
  onHover,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  note?: string;
  title?: string;
  shortcut?: string;
  disabled?: boolean;
  onHover?: () => void;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="rv-lidar-ctx__row"
      title={title}
      disabled={disabled}
      onMouseEnter={onHover}
      onClick={onClick}
    >
      <span className="rv-lidar-ctx__icon-box" aria-hidden>{icon}</span>
      {note ? (
        <span className="rv-lidar-ctx__row-text">
          <span className="rv-lidar-ctx__row-label">{label}</span>
          <span className="rv-lidar-ctx__row-note">{note}</span>
        </span>
      ) : (
        <span className="rv-lidar-ctx__row-label">{label}</span>
      )}
      {shortcut ? <kbd className="rv-lidar-ctx__kbd">{shortcut}</kbd> : null}
    </button>
  );
}

function SubmenuTrigger({
  id,
  icon,
  label,
  open,
  buttonRef,
  onHover,
  onOpen,
}: {
  id: SubmenuId;
  icon: ReactNode;
  label: string;
  open: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onHover: () => void;
  onOpen: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={open}
      data-submenu={id}
      className="rv-lidar-ctx__row"
      data-open={open || undefined}
      onMouseEnter={onHover}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') onOpen();
      }}
    >
      <span className="rv-lidar-ctx__icon-box" aria-hidden>{icon}</span>
      <span className="rv-lidar-ctx__row-label">{label}</span>
      <span className="rv-lidar-ctx__chevron" aria-hidden><ChevronGlyph /></span>
    </button>
  );
}
