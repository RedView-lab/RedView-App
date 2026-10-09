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
  /**
   * Le compte a un mot de passe (inscription par e-mail) : Appwrite exige
   * alors l'ancien pour en poser un nouveau. Faux pour un compte Google.
   */
  hasPassword: boolean;
};

export type AccountIdentityForm = Pick<AccountProfile, 'firstName' | 'lastName' | 'email'>;

export type AccountPracticeForm = Pick<AccountProfile, 'country' | 'sports'>;