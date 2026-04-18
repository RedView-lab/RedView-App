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
import {
  geocodePlaces,
  type GeocodeSuggestion,
} from '../lib/geocoder';

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
  placeholder = 'Rechercher un lieu',
  proximity,
  countries = 'fr',
  debounceMs = 250,
  autoFocus,
  className,
}: PlaceSearchInputProps) {
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
    left: number;
    top: number;
    width: number;
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
            e instanceof Error ? e.message : 'Erreur de recherche',
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
      setMenuRect({ left: r.left, top: r.bottom + 4, width: r.width });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
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
        placeholder={placeholder}
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
          <ul
            id={listId}
            role="listbox"
            className="rvi-place-search__list"
            style={{
              position: 'fixed',
              left: menuRect.left,
              top: menuRect.top,
              width: menuRect.width,
            }}
            onMouseDown={(e) => e.preventDefault() /* keep input focused */}
          >
            {loading && (
              <li className="rvi-place-search__hint" role="presentation">
                Recherche…
              </li>
            )}
            {!loading && error && (
              <li className="rvi-place-search__hint rvi-place-search__hint--error">
                {error}
              </li>
            )}
            {!loading && !error && suggestions.length === 0 && (
              <li className="rvi-place-search__hint">Aucun résultat</li>
            )}
            {!loading &&
              suggestions.map((s, i) => (
                <li
                  key={s.id}
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={i === activeIdx}
                  className={`rvi-place-search__option${
                    i === activeIdx ? ' is-active' : ''
                  }`}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => commit(s)}
                >
                  <span className="rvi-place-search__name">{s.name}</span>
                  <span className="rvi-place-search__sub">
                    {s.fullName.replace(`${s.name}, `, '')}
                  </span>
                </li>
              ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
