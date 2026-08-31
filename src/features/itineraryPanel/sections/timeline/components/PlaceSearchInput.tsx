/**
 * Compact place-search combobox used by Départ / Fin (and any other
 * location-bound timeline rows).
 *
 * - Debounced calls to the Mapbox geocoder.
 * - Keyboard-friendly dropdown (↑/↓/Enter/Esc).
 * - Renders inline inside a TimelineRow — visually replaces the
 *   "Rechercher un lieu" placeholder text without breaking row layout.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import {
  geocodePlaces,
  type GeocodeSuggestion,
} from '../../../lib/geocoding';
import { useAppI18n } from '@/shared/i18n';

interface PlaceSearchInputProps {
  value: string;
  /** Called when the user picks a suggestion. */
  onPick: (suggestion: GeocodeSuggestion) => void;
  /** Called whenever the visible text changes (incl. while typing). */
  onChangeText?: (text: string) => void;
  placeholder?: string;
  /** Bias geocoding around this lon/lat (typically map.getCenter()). */
  proximity?: { lon: number; lat: number };
  /** ISO-3166 codes, comma-separated. Defaults to 'fr'. */
  countries?: string;
  /** Debounce delay in ms. Defaults to 250. */
  debounceMs?: number;
  autoFocus?: boolean;
  className?: string;
}

export function PlaceSearchInput({
  value,
  onPick,
  onChangeText,
  placeholder,
  proximity,
  countries = 'fr',
  debounceMs = 250,
  autoFocus,
  className,
}: PlaceSearchInputProps) {
  const { t } = useAppI18n();
  const resolvedPlaceholder = placeholder ?? t('Rechercher un lieu');
  const [text, setText] = useState(value);
  const [suggestions, setSuggestions] = useState<GeocodeSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listId = useId();
  const blurTimerRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [menuRect, setMenuRect] = useState<{
    anchorTop: number;
    left: number;
    width: number;
    maxHeight: number;
    placeAbove: boolean;
    scale: number;
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
  } | null>(null);

  // Keep local text in sync if the parent resets the value (e.g. itinerary switch).
  useEffect(() => {
    setText(value);
  }, [value]);

  // Debounced search whenever `text` changes.
  useEffect(() => {
    if (!open) return;
    const trimmed = text.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      setError(null);
      setLoading(false);
      return;
    }
    const handle = window.setTimeout(() => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      setError(null);
      geocodePlaces(trimmed, {
        proximity,
        countries,
        signal: ctrl.signal,
        limit: 6,
      })
        .then((res) => {
          setSuggestions(res);
          setActiveIdx(res.length > 0 ? 0 : -1);
        })
        .catch((e: unknown) => {
          if ((e as { name?: string }).name === 'AbortError') return;
          setSuggestions([]);
          setError(
            e instanceof Error ? t(e.message) : t('Erreur de recherche'),
          );
        })
        .finally(() => setLoading(false));
    }, debounceMs);
    return () => window.clearTimeout(handle);
  }, [text, open, proximity, countries, debounceMs]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Track the input position so the (portaled, fixed) dropdown follows it.
  useLayoutEffect(() => {
    if (!open) return;

    const update = () => {
      const el = inputRef.current;
      if (!el) return;

      const r = el.getBoundingClientRect();
      const computed = window.getComputedStyle(el);
      const rawScale = Number.parseFloat(computed.getPropertyValue('--app-scale'));
      const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const viewportRight = viewportLeft + viewportWidth;
      const viewportBottom = viewportTop + viewportHeight;
      const gutter = 8;
      const offset = 4 * scale;
      const maxWidth = Math.max(180, viewportWidth - gutter * 2);
      const desiredWidth = Math.max(r.width, 220 * scale);
      const width = Math.min(desiredWidth, maxWidth);
      const left = Math.min(
        Math.max(viewportLeft + gutter, r.right - width),
        viewportRight - gutter - width,
      );

      const spaceBelow = Math.max(96 * scale, viewportBottom - (r.bottom + offset) - gutter);
      const spaceAbove = Math.max(96 * scale, r.top - viewportTop - offset - gutter);
      const placeAbove = spaceBelow < 180 * scale && spaceAbove > spaceBelow;
      const availableHeight = placeAbove ? spaceAbove : spaceBelow;
      const maxHeight = Math.min(availableHeight, 320 * scale);

      setMenuRect({
        anchorTop: placeAbove ? r.top - offset : r.bottom + offset,
        left,
        width,
        maxHeight,
        placeAbove,
        scale,
        fontFamily: computed.fontFamily,
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        lineHeight: computed.lineHeight,
      });
    };

    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => update())
        : null;
    if (resizeObserver && inputRef.current) {
      resizeObserver.observe(inputRef.current);
    }

    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      resizeObserver?.disconnect();
    };
  }, [open]);

  const commit = useCallback(
    (s: GeocodeSuggestion) => {
      setText(s.name);
      setOpen(false);
      setSuggestions([]);
      setActiveIdx(-1);
      onChangeText?.(s.name);
      onPick(s);
    },
    [onPick, onChangeText],
  );

  const handleKeyDown = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setOpen(true);
      setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (ev.key === 'Enter') {
      if (open && activeIdx >= 0 && suggestions[activeIdx]) {
        ev.preventDefault();
        commit(suggestions[activeIdx]);
      }
    } else if (ev.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className={`rvi-place-search${className ? ` ${className}` : ''}`}>
      <input
        ref={inputRef}
        type="text"
        className="rvi-place-search__input"
        value={text}
          placeholder={resolvedPlaceholder}
        autoFocus={autoFocus}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          onChangeText?.(e.target.value);
        }}
        onFocus={() => {
          if (blurTimerRef.current) {
            window.clearTimeout(blurTimerRef.current);
            blurTimerRef.current = null;
          }
          setOpen(true);
        }}
        onBlur={() => {
          // Defer close so a click on a suggestion still fires.
          blurTimerRef.current = window.setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={handleKeyDown}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          activeIdx >= 0 ? `${listId}-opt-${activeIdx}` : undefined
        }
      />

      {open && menuRect && (text.trim().length >= 2 || loading || error) &&
        createPortal(
          <div
            className="rvi-place-search__menu-anchor"
            style={{
              position: 'fixed',
              left: menuRect.left,
              top: menuRect.anchorTop,
              zIndex: 9999,
              transform: menuRect.placeAbove ? 'translateY(-100%)' : undefined,
            }}
          >
            <div
              className="rvi-place-search__menu-shell"
              style={{
                width: menuRect.width / menuRect.scale,
                transform: `scale(${menuRect.scale})`,
                transformOrigin: menuRect.placeAbove ? 'bottom left' : 'top left',
                fontFamily: menuRect.fontFamily,
                fontSize: menuRect.fontSize,
                fontWeight: menuRect.fontWeight,
                lineHeight: menuRect.lineHeight,
              }}
              onMouseDown={(e) => e.preventDefault() /* keep input focused */}
            >
              <MapCanvasGlassBackdrop blur={24} saturate={1.2} tint="rgba(14, 14, 18, 0.94)" />
              <div
                id={listId}
                role="listbox"
                className="rvi-place-search__list"
                style={{ maxHeight: menuRect.maxHeight / menuRect.scale }}
              >
                {loading && (
                  <div className="rvi-place-search__hint" role="presentation">
                    {t('Recherche…')}
                  </div>
                )}
                {!loading && error && (
                  <div className="rvi-place-search__hint rvi-place-search__hint--error">
                    {error}
                  </div>
                )}
                {!loading && !error && suggestions.length === 0 && (
                  <div className="rvi-place-search__hint">{t('Aucun résultat')}</div>
                )}
                {!loading &&
                  suggestions.map((s, i) => (
                    <div
                      key={s.id}
                      id={`${listId}-opt-${i}`}
                      role="option"
                      aria-selected={i === activeIdx}
                      className={`rvi-place-search__option${
                        i === activeIdx ? ' is-active' : ''
                      }`}
                      onMouseEnter={() => setActiveIdx(i)}
                      onClick={() => commit(s)}
                      title={s.fullName}
                    >
                      <span className="rvi-place-search__name">{s.fullName}</span>
                    </div>
                  ))}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
