import { useEffect, useRef, useState } from 'react';
import { useAppI18n } from '@/shared/i18n';
import type { SurfaceType } from '../../lib/project/syncTracageParams';
import { SURFACES } from './activity';

interface SurfaceRangeSliderProps {
  /** Index (dans SURFACES) de la surface minimale acceptée. */
  safeMinIdx: number;
  /** Index (dans SURFACES) de la surface maximale acceptée (≥ safeMinIdx). */
  safeMaxIdx: number;
  onSelectRange: (surfaceMin: SurfaceType, surfaceMax: SurfaceType) => void;
}

/**
 * Curseur double « Surfaces » (Tarmac → Other) : glisser fluide des deux
 * poignées (superposées comprises), clic sur les graduations, clavier.
 */
export function SurfaceRangeSlider({ safeMinIdx, safeMaxIdx, onSelectRange }: SurfaceRangeSliderProps) {
  const { t } = useAppI18n();
  const sliderWrapRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [activeDraggingKnob, setActiveDraggingKnob] = useState<'min' | 'max' | 'superposed' | null>(null);
  const [dragMinPct, setDragMinPct] = useState<number | null>(null);
  const [dragMaxPct, setDragMaxPct] = useState<number | null>(null);
  const dragMinIdxRef = useRef<number>(safeMinIdx);
  const dragMaxIdxRef = useRef<number>(safeMaxIdx);
  const startClientXRef = useRef<number>(0);

  useEffect(() => {
    dragMinIdxRef.current = safeMinIdx;
    dragMaxIdxRef.current = safeMaxIdx;
  }, [safeMinIdx, safeMaxIdx]);

  const activeMinPct = SURFACES[safeMinIdx].pct;
  const activeMaxPct = SURFACES[safeMaxIdx].pct;

  const getRatioFromPointerEvent = (clientX: number): number => {
    if (!sliderWrapRef.current) return 0;
    const rect = sliderWrapRef.current.getBoundingClientRect();
    const usableWidth = rect.width - 38;
    if (usableWidth <= 0) return 0;
    const clickX = clientX - rect.left - 19;
    return Math.max(0, Math.min(1, clickX / usableWidth));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);

    const ratio = getRatioFromPointerEvent(e.clientX);
    const clickPct = ratio * 100;
    const minPct = SURFACES[safeMinIdx].pct;
    const maxPct = SURFACES[safeMaxIdx].pct;

    startClientXRef.current = e.clientX;

    // Les deux boutons superposés sur la même surface
    if (safeMinIdx === safeMaxIdx) {
      const distToKnob = Math.abs(clickPct - minPct);
      if (distToKnob < 15) {
        setActiveDraggingKnob('superposed');
        setDragMinPct(minPct);
        setDragMaxPct(maxPct);
        return;
      } else if (clickPct < minPct) {
        setActiveDraggingKnob('min');
        const nearestIndex = Math.min(safeMaxIdx, Math.max(0, Math.round(ratio * (SURFACES.length - 1))));
        dragMinIdxRef.current = nearestIndex;
        setDragMinPct(clickPct);
        onSelectRange(SURFACES[nearestIndex].id, SURFACES[safeMaxIdx].id);
        return;
      } else {
        setActiveDraggingKnob('max');
        const nearestIndex = Math.max(safeMinIdx, Math.min(SURFACES.length - 1, Math.round(ratio * (SURFACES.length - 1))));
        dragMaxIdxRef.current = nearestIndex;
        setDragMaxPct(clickPct);
        onSelectRange(SURFACES[safeMinIdx].id, SURFACES[nearestIndex].id);
        return;
      }
    }

    // Boutons séparés : prendre le plus proche
    if (clickPct <= minPct) {
      setActiveDraggingKnob('min');
      const nearestIndex = Math.min(safeMaxIdx, Math.max(0, Math.round(ratio * (SURFACES.length - 1))));
      dragMinIdxRef.current = nearestIndex;
      setDragMinPct(clickPct);
      onSelectRange(SURFACES[nearestIndex].id, SURFACES[safeMaxIdx].id);
    } else if (clickPct >= maxPct) {
      setActiveDraggingKnob('max');
      const nearestIndex = Math.max(safeMinIdx, Math.min(SURFACES.length - 1, Math.round(ratio * (SURFACES.length - 1))));
      dragMaxIdxRef.current = nearestIndex;
      setDragMaxPct(clickPct);
      onSelectRange(SURFACES[safeMinIdx].id, SURFACES[nearestIndex].id);
    } else {
      const distMin = Math.abs(clickPct - minPct);
      const distMax = Math.abs(clickPct - maxPct);
      if (distMin <= distMax) {
        setActiveDraggingKnob('min');
        const nearestIndex = Math.min(safeMaxIdx, Math.max(0, Math.round(ratio * (SURFACES.length - 1))));
        dragMinIdxRef.current = nearestIndex;
        setDragMinPct(clickPct);
        onSelectRange(SURFACES[nearestIndex].id, SURFACES[safeMaxIdx].id);
      } else {
        setActiveDraggingKnob('max');
        const nearestIndex = Math.max(safeMinIdx, Math.min(SURFACES.length - 1, Math.round(ratio * (SURFACES.length - 1))));
        dragMaxIdxRef.current = nearestIndex;
        setDragMaxPct(clickPct);
        onSelectRange(SURFACES[safeMinIdx].id, SURFACES[nearestIndex].id);
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    e.preventDefault();

    const ratio = getRatioFromPointerEvent(e.clientX);
    const clickPct = ratio * 100;

    let targetKnob = activeDraggingKnob;
    if (targetKnob === 'superposed') {
      const dx = e.clientX - startClientXRef.current;
      if (Math.abs(dx) > 3) {
        targetKnob = dx > 0 ? 'max' : 'min';
        setActiveDraggingKnob(targetKnob);
      } else {
        return;
      }
    }

    if (targetKnob === 'min') {
      const maxBoundPct = SURFACES[safeMaxIdx].pct;
      const clampedPct = Math.max(0, Math.min(maxBoundPct, clickPct));
      setDragMinPct(clampedPct);

      const nearestIndex = Math.min(safeMaxIdx, Math.max(0, Math.round(ratio * (SURFACES.length - 1))));
      if (nearestIndex !== dragMinIdxRef.current) {
        dragMinIdxRef.current = nearestIndex;
        onSelectRange(SURFACES[nearestIndex].id, SURFACES[safeMaxIdx].id);
      }
    } else if (targetKnob === 'max') {
      const minBoundPct = SURFACES[safeMinIdx].pct;
      const clampedPct = Math.max(minBoundPct, Math.min(100, clickPct));
      setDragMaxPct(clampedPct);

      const nearestIndex = Math.max(safeMinIdx, Math.min(SURFACES.length - 1, Math.round(ratio * (SURFACES.length - 1))));
      if (nearestIndex !== dragMaxIdxRef.current) {
        dragMaxIdxRef.current = nearestIndex;
        onSelectRange(SURFACES[safeMinIdx].id, SURFACES[nearestIndex].id);
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    setIsDragging(false);
    setActiveDraggingKnob(null);
    setDragMinPct(null);
    setDragMaxPct(null);
  };

  const handleTickLabelClick = (index: number) => {
    if (index < safeMinIdx) {
      onSelectRange(SURFACES[index].id, SURFACES[safeMaxIdx].id);
    } else if (index > safeMaxIdx) {
      onSelectRange(SURFACES[safeMinIdx].id, SURFACES[index].id);
    } else if (index === safeMinIdx && safeMinIdx < safeMaxIdx) {
      onSelectRange(SURFACES[index].id, SURFACES[index].id);
    } else if (index === safeMaxIdx && safeMinIdx < safeMaxIdx) {
      onSelectRange(SURFACES[index].id, SURFACES[index].id);
    } else if (safeMinIdx < index && index < safeMaxIdx) {
      const distToMin = index - safeMinIdx;
      const distToMax = safeMaxIdx - index;
      if (distToMin <= distToMax) {
        onSelectRange(SURFACES[index].id, SURFACES[safeMaxIdx].id);
      } else {
        onSelectRange(SURFACES[safeMinIdx].id, SURFACES[index].id);
      }
    }
  };

  // Positions interpolées des boutons et plage de remplissage
  const effectiveMinPct =
    isDragging && dragMinPct !== null ? dragMinPct : activeMinPct;
  const effectiveMaxPct =
    isDragging && dragMaxPct !== null ? dragMaxPct : activeMaxPct;

  const knobMinLeftStyle = `calc(19px + (100% - 38px) * ${effectiveMinPct / 100})`;
  const knobMaxLeftStyle = `calc(19px + (100% - 38px) * ${effectiveMaxPct / 100})`;
  const fillLeftStyle = `calc(19px + (100% - 38px) * ${effectiveMinPct / 100})`;
  const fillWidthStyle = `calc((100% - 38px) * ${(effectiveMaxPct - effectiveMinPct) / 100})`;

  return (
    <div className="rvi-tracage__slider-box">
      <div className="rvi-tracage__slider-frame">
        <div
          ref={sliderWrapRef}
          className="rvi-tracage__slider-track-wrap"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {/* Ligne de piste de fond */}
          <div className="rvi-tracage__slider-track" />

          {/* Ligne ROUGE active reliant min et max */}
          <div
            className={`rvi-tracage__slider-fill${isDragging ? ' is-dragging' : ''}`}
            style={{ left: fillLeftStyle, width: fillWidthStyle }}
          />

          {/* 4 graduations discrètes alignées sur les centres des boutons */}
          {SURFACES.map((s, idx) => {
            const tickLeft =
              idx === 0
                ? '19px'
                : idx === SURFACES.length - 1
                  ? 'calc(100% - 19px)'
                  : `calc(19px + (100% - 38px) * ${s.pct / 100})`;
            const isInRange = idx >= safeMinIdx && idx <= safeMaxIdx;
            return (
              <div
                key={s.id}
                className="rvi-tracage__slider-tick"
                style={{
                  left: tickLeft,
                  background: isInRange
                    ? '#ffffff'
                    : 'rgb(var(--rv-ink) / 0.28)',
                }}
              />
            );
          })}

          {/* Pastille du bouton min (38px x 24px) */}
          <div
            className={`rvi-tracage__slider-knob rvi-tracage__slider-knob--min${activeDraggingKnob === 'min' ? ' is-dragging' : ''}`}
            style={{ left: knobMinLeftStyle }}
            role="slider"
            aria-label={t('Surface minimale')}
            aria-valuemin={0}
            aria-valuemax={safeMaxIdx}
            aria-valuenow={safeMinIdx}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                e.preventDefault();
                const next = Math.min(safeMaxIdx, safeMinIdx + 1);
                onSelectRange(SURFACES[next].id, SURFACES[safeMaxIdx].id);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                e.preventDefault();
                const prev = Math.max(0, safeMinIdx - 1);
                onSelectRange(SURFACES[prev].id, SURFACES[safeMaxIdx].id);
              }
            }}
          />

          {/* Pastille du bouton max (38px x 24px) */}
          <div
            className={`rvi-tracage__slider-knob rvi-tracage__slider-knob--max${activeDraggingKnob === 'max' ? ' is-dragging' : ''}`}
            style={{ left: knobMaxLeftStyle }}
            role="slider"
            aria-label={t('Surface maximale')}
            aria-valuemin={safeMinIdx}
            aria-valuemax={SURFACES.length - 1}
            aria-valuenow={safeMaxIdx}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                e.preventDefault();
                const next = Math.min(SURFACES.length - 1, safeMaxIdx + 1);
                onSelectRange(SURFACES[safeMinIdx].id, SURFACES[next].id);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                e.preventDefault();
                const prev = Math.max(safeMinIdx, safeMaxIdx - 1);
                onSelectRange(SURFACES[safeMinIdx].id, SURFACES[prev].id);
              }
            }}
          />
        </div>
      </div>

      {/* Ligne des libellés de graduation */}
      <div className="rvi-tracage__ticks-labels">
        {SURFACES.map((s, idx) => {
          const isActive = idx >= safeMinIdx && idx <= safeMaxIdx;
          return (
              <span
                key={s.id}
                className={`rvi-tracage__tick-label${isActive ? ' is-active' : ''}`}
                onClick={() => handleTickLabelClick(idx)}
                onDoubleClick={() => onSelectRange(s.id, s.id)}
                title={t(s.label)}
              >
                {s.label}
              </span>
            );
          })}
        </div>
      </div>
  );
}
