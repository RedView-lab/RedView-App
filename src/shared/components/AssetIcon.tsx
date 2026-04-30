import type { CSSProperties, HTMLAttributes } from 'react';

type AssetIconOwnProps = {
  src: string;
};

export type AssetIconProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  size?: number;
};

export function AssetIcon({
  src,
  size = 16,
  className,
  style,
  'aria-label': ariaLabel,
  'aria-hidden': ariaHidden,
  ...rest
}: AssetIconProps & AssetIconOwnProps) {
  const mergedStyle: CSSProperties = {
    width: size,
    height: size,
    display: 'block',
    flex: '0 0 auto',
    backgroundColor: 'currentColor',
    WebkitMaskImage: `url(${src})`,
    WebkitMaskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
    WebkitMaskSize: 'contain',
    maskImage: `url(${src})`,
    maskRepeat: 'no-repeat',
    maskPosition: 'center',
    maskSize: 'contain',
    ...style,
  };

  return (
    <span
      {...rest}
      role={ariaLabel ? 'img' : undefined}
      aria-hidden={ariaLabel ? undefined : (ariaHidden ?? true)}
      aria-label={ariaLabel}
      className={className}
      style={mergedStyle}
    />
  );
}