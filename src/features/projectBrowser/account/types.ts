export type AccountSportEntry = {
  id: string;
  sport: string;
  level: string;
  annualDistanceKm: string;
};

export type AccountProfile = {
  firstName: string;
  lastName: string;
  email: string;
  country: string;
  sports: AccountSportEntry[];
  lastSignInAt: string | null;
};

export type AccountIdentityForm = Pick<AccountProfile, 'firstName' | 'lastName' | 'email'>;

export type AccountPracticeForm = Pick<AccountProfile, 'country' | 'sports'>;