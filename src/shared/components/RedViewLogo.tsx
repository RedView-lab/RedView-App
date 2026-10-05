import type { ImgHTMLAttributes } from 'react';

import { useAppTheme } from '@/shared/lib/appTheme';

const LOGO_ON_DARK = '/landing/icons/redview-logo.svg';
const LOGO_ON_LIGHT = '/landing/icons/redview-logo-dark.svg';

/** Logo RedView (blanc en thème sombre, encre en thème clair). */
export function RedViewLogo({ alt = 'RedView', ...rest }: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>) {
  const theme = useAppTheme();
  return <img {...rest} src={theme === 'light' ? LOGO_ON_LIGHT : LOGO_ON_DARK} alt={alt} />;
}
