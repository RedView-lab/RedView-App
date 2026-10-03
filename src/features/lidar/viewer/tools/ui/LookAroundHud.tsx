// ============================================
// LiDAR viewer — first-person view HUD
// ============================================
//
// Compass tape (true heading), centre reticle with what it aims at
// (distance, altitude, angle above the horizon) and a bottom bar with the
// field-of-view presets. Everything but the bar lets the pointer through.

import { translateAppText as t } from '@/shared/i18n/config';
import { formatAltitude, formatAngle, formatAspect, formatDistance } from '../format';
import { FOV_PRESETS, type FovPresetId } from '../lookAround/lookAround';
import { CloseGlyph, LookAroundGlyph } from './glyphs';
import type { LookAroundModel, ToolsUiActions } from './toolsUiStore';

const TAPE_WIDTH = 420;
const TAPE_HEIGHT = 30;
/** Headings shown across the tape, degrees. */
const TAPE_SPAN_DEG = 120;

const PRESET_LABELS: Record<FovPresetId, { label: string; title: string }> = {
  eye: { label: 'Œil', title: 'Champ binoculaire humain ≈ 114° (les deux yeux, avec le relief)' },
  natural: { label: 'Naturel', title: '60° : la perspective de l’écran égale celle de l’œil, rien n’est étiré' },
  binoculars: { label: 'Jumelles ×8', title: 'Champ réel d’une paire 8×42 ≈ 7,5°' },
};

function signedAngle(deg: number): string {
  return `${deg > 0 ? '+' : deg < 0 ? '−' : '±'}${formatAngle(Math.abs(deg), Math.abs(deg) < 10 ? 1 : 0)}`;
}

export function LookCompass({ model }: { model: LookAroundModel }) {
  const heading = model.headingDeg;
  const ticks: Array<{ x: number; deg: number }> = [];
  const first = Math.ceil((heading - TAPE_SPAN_DEG / 2) / 5) * 5;
  for (let deg = first; deg <= heading + TAPE_SPAN_DEG / 2; deg += 5) {
    ticks.push({ x: ((deg - heading) / TAPE_SPAN_DEG) * TAPE_WIDTH + TAPE_WIDTH / 2, deg: ((deg % 360) + 360) % 360 });
  }
  return (
    <div className="rv-lidar-look-compass" role="img" aria-label={t('Cap {{heading}}', { heading: `${heading}°` })}>
      <svg width={TAPE_WIDTH} height={TAPE_HEIGHT} viewBox={`0 0 ${TAPE_WIDTH} ${TAPE_HEIGHT}`} aria-hidden>
        <defs>
          <linearGradient id="rv-look-tape-fade" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.15" stopColor="#fff" stopOpacity="1" />
            <stop offset="0.85" stopColor="#fff" stopOpacity="1" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id="rv-look-tape-mask">
            <rect width={TAPE_WIDTH} height={TAPE_HEIGHT} fill="url(#rv-look-tape-fade)" />
          </mask>
        </defs>
        <g mask="url(#rv-look-tape-mask)">
          {ticks.map(({ x, deg }) => {
            const cardinal = deg % 45 === 0;
            const major = deg % 15 === 0;
            return (
              <g key={`${x.toFixed(1)}-${deg}`}>
                <line x1={x} x2={x} y1={0} y2={cardinal ? 9 : major ? 7 : 4} stroke="rgba(255,255,255,0.8)" strokeWidth={cardinal ? 1.5 : 1} />
                {major ? (
                  <text
                    x={x}
                    y={22}
                    textAnchor="middle"
                    className={cardinal ? 'rv-lidar-look-compass__cardinal' : 'rv-lidar-look-compass__degree'}
                  >
                    {cardinal ? formatAspect(deg) : deg}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
        <path d={`M${TAPE_WIDTH / 2 - 5} 0 L${TAPE_WIDTH / 2 + 5} 0 L${TAPE_WIDTH / 2} 6 Z`} fill="#ff2a1f" />
      </svg>
      <span className="rv-lidar-look-compass__value">
        {heading}° {formatAspect(heading)} · ↕ {signedAngle(model.pitchDeg)}
      </span>
    </div>
  );
}

export function LookReticle({ model }: { model: LookAroundModel }) {
  const target = model.target;
  return (
    <div className="rv-lidar-look-reticle" aria-hidden>
      <svg width="28" height="28" viewBox="0 0 28 28">
        <path d="M14 2V10M14 18V26M2 14H10M18 14H26" stroke="rgba(0,0,0,0.6)" strokeWidth="3" strokeLinecap="round" />
        <path d="M14 2V10M14 18V26M2 14H10M18 14H26" stroke="#ffffff" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span className="rv-lidar-look-reticle__readout">
        {target
          ? `${formatDistance(target.distanceM)} · ${formatAltitude(target.altitudeM)} · ${signedAngle(target.elevationDeg)}`
          : t('Ciel ou hors de la zone chargée')}
      </span>
    </div>
  );
}

export function LookBar({ model, actions }: { model: LookAroundModel; actions: ToolsUiActions }) {
  return (
    <div className="rv-lidar-look-bar" role="toolbar" aria-label={t('Vue 360° d’ici')}>
      <span className="rv-lidar-look-bar__title">
        <LookAroundGlyph />
        {t('Vue 360°')}
      </span>
      <span className="rv-lidar-look-bar__meta">
        {t('{{altitude}} · œil à 1,7 m', { altitude: formatAltitude(model.groundAltitudeM) })}
      </span>
      <span className="rv-lidar-look-bar__divider" aria-hidden />
      <div className="rv-lidar-look-bar__presets" role="group" aria-label={t('Champ de vision')}>
        {FOV_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="rv-lidar-look-bar__preset"
            aria-pressed={Math.abs(model.fovDeg - preset.fovDeg) < 0.5}
            title={t(PRESET_LABELS[preset.id].title)}
            onClick={() => actions.setLookFov(preset.fovDeg)}
          >
            {t(PRESET_LABELS[preset.id].label)}
          </button>
        ))}
      </div>
      <span className="rv-lidar-look-bar__fov" title={t('Molette : élargir ou resserrer le champ')}>
        {t('Champ {{angle}}', { angle: formatAngle(model.fovDeg, model.fovDeg < 10 ? 1 : 0) })}
      </span>
      <span className="rv-lidar-look-bar__divider" aria-hidden />
      <span className="rv-lidar-look-bar__hint">{t('Glisser : regarder · Molette : champ')}</span>
      <button
        type="button"
        className="rv-lidar-look-bar__exit"
        onClick={() => actions.exitLookAround()}
        title={t('Revenir à la vue d’ensemble (Échap)')}
      >
        <CloseGlyph />
        {t('Quitter')}
        <kbd className="rv-lidar-ctx__kbd">{t('Échap')}</kbd>
      </button>
    </div>
  );
}
