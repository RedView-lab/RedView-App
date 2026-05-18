const ACCOUNT_COUNTRY_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR',
  'BS', 'BT', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CH', 'CK', 'CL', 'CM', 'CN', 'CO',
  'CR', 'CU', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE', 'EG',
  'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GG',
  'GH', 'GI', 'GL', 'GM', 'GN', 'GQ', 'GR', 'GT', 'GU', 'GW', 'GY', 'HK', 'HN', 'HR', 'HT',
  'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM', 'JO', 'JP',
  'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI',
  'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MG', 'MH', 'MK', 'ML',
  'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
  'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG',
  'PH', 'PK', 'PL', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RO', 'RS', 'RU', 'RW', 'SA',
  'SB', 'SC', 'SE', 'SG', 'SI', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX',
  'SY', 'SZ', 'TC', 'TD', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV',
  'TW', 'TZ', 'UA', 'UG', 'US', 'UY', 'UZ', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU', 'WS', 'YE',
  'ZA', 'ZM', 'ZW',
] as const;

function buildRegionDisplayNames(locale: string) {
  if (typeof Intl === 'undefined' || typeof Intl.DisplayNames !== 'function') {
    return null;
  }

  try {
    return new Intl.DisplayNames([locale], { type: 'region' });
  } catch {
    return null;
  }
}

export function buildAccountCountryOptions(locale = 'fr') {
  const displayNames = buildRegionDisplayNames(locale);

  return ACCOUNT_COUNTRY_CODES
    .map((countryCode) => ({
      value: countryCode,
      label: displayNames?.of(countryCode) ?? countryCode,
      flagCode: countryCode,
    }))
    .filter((option) => option.label && option.label !== option.value)
    .sort((left, right) => left.label.localeCompare(right.label, locale, { sensitivity: 'base' }));
}

export const ACCOUNT_COUNTRY_OPTIONS = buildAccountCountryOptions('fr');

export const ACCOUNT_SPORT_OPTIONS = [
  'Velo de route',
  'Gravel',
  'VTT',
  'Trail',
  'Randonnee',
] as const;

export const ACCOUNT_LEVEL_OPTIONS = ['Debutant', 'Intermediaire', 'Avance', 'Expert'] as const;

export const DEFAULT_COUNTRY = 'FR';
export const DEFAULT_SPORT = ACCOUNT_SPORT_OPTIONS[0];
export const DEFAULT_LEVEL = ACCOUNT_LEVEL_OPTIONS[0];