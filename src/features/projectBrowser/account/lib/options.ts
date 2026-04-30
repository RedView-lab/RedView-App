export const ACCOUNT_COUNTRY_OPTIONS = [
  { value: 'FR', label: 'France', flag: 'linear-gradient(90deg, #1d4ed8 0 33.33%, #ffffff 33.33% 66.66%, #dc2626 66.66% 100%)' },
  { value: 'CH', label: 'Suisse', flag: 'linear-gradient(90deg, #dc2626 0%, #dc2626 100%)' },
  { value: 'BE', label: 'Belgique', flag: 'linear-gradient(90deg, #111827 0 33.33%, #facc15 33.33% 66.66%, #dc2626 66.66% 100%)' },
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