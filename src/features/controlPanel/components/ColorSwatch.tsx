interface ColorSwatchProps {
  /** Hex color (with or without leading #). */
  color: string;
  size?: number;
}

export function ColorSwatch({ color, size = 12 }: ColorSwatchProps) {
  const value = color.startsWith('#') ? color : `#${color}`;
  return (
    <span
      className="rvc-swatch"
      style={{ backgroundColor: value, width: size, height: size }}
    />
  );
}
