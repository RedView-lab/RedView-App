/** `#rgb` / `#rrggbb` → `rgba(…, alpha)` ; toute autre chaîne de couleur est renvoyée telle quelle. */
export function withAlpha(color: string, alpha: number): string {
  const normalizedAlpha = Math.max(0, Math.min(1, alpha));
  const hex = color.trim();
  const match = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex);
  if (!match) return color;

  const raw = match[1];
  const expanded = raw.length === 3
    ? raw.split('').map((channel) => channel + channel).join('')
    : raw;
  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${normalizedAlpha})`;
}
