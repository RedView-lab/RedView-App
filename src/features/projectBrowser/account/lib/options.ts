export const ACCOUNT_COUNTRY_OPTIONS = [
  { value: 'FR', label: 'France', flagCode: 'FR' },
  { value: 'CH', label: 'Suisse', flagCode: 'CH' },
  { value: 'BE', label: 'Belgique', flagCode: 'BE' },
] as const;

export const ACCOUNT_SPORT_OPTIONS = [
  'Velo de route',
  'Gravel',
  'VTT',
  'Trail',
  'Randonnee',
] as const;

export const ACCOUNT_LEVEL_OPTIONS = ['Debutant', 'Intermediaire', 'Avance', 'Expert'] as const;

export const DEFAULT_COUNTRY = ACCOUNT_COUNTRY_OPTIONS[0].value;
export const DEFAULT_SPORT = ACCOUNT_SPORT_OPTIONS[0];
export const DEFAULT_LEVEL = ACCOUNT_LEVEL_OPTIONS[0];