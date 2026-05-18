export type AppLocale = 'fr' | 'en';

export type AppTranslationBundle = {
  locale: AppLocale;
  entries: Record<string, string>;
};

export const PROJECT_BROWSER_SETTINGS_STORAGE_KEY = 'redview:project-browser-settings:v1';

export const APP_LOCALE_OPTIONS = [
  {
    value: 'en',
    label: 'English (US)',
    flag: '/landing/svg/US.svg',
    flagCode: 'US',
  },
  {
    value: 'fr',
    label: 'Français',
    flag: '/landing/svg/FR.svg',
    flagCode: 'FR',
  },
] as const;

const LEGACY_LANGUAGE_TO_LOCALE: Record<string, AppLocale> = {
  en: 'en',
  fr: 'fr',
  'English (US)': 'en',
  Français: 'fr',
};

const TRANSLATION_PAIRS = [
  { fr: 'Loading...', en: 'Loading...' },
  { fr: 'Redirecting...', en: 'Redirecting...' },
  { fr: 'Loading dashboard...', en: 'Loading dashboard...' },
  { fr: 'Réglages globaux', en: 'Global settings' },
  { fr: 'Langue', en: 'Language' },
  { fr: 'Unité de mesure', en: 'Unit system' },
  { fr: 'Paramètre de carte', en: 'Map preset' },
  { fr: 'Préférence d’affichage', en: 'Display preference' },
  { fr: 'Réglage', en: 'Setting' },
  { fr: 'Activer le réglage', en: 'Enable setting' },
  { fr: 'Mètre', en: 'Meters' },
  { fr: 'Pieds', en: 'Feet' },
  { fr: 'Jour (nuit couché de soleil)', en: 'Day (sunset night)' },
  { fr: 'Nuit', en: 'Night' },
  { fr: 'System preference', en: 'System preference' },
  { fr: 'Light mode', en: 'Light mode' },
  { fr: 'Dark mode', en: 'Dark mode' },
  { fr: 'Construit avec et pour la communauté', en: 'Built with and for the community' },
  {
    fr: "RedView s'appuie sur de nombreuses rencontres, discussions et observations réalisées avec la communauté cycliste. Si vous voulez contribuer au développement de l'outil, vous pouvez utiliser notre questionnaire de feedback ci-dessous.",
    en: 'RedView is shaped by many conversations, field observations, and exchanges with the cycling community. If you want to contribute to the product, you can use our feedback questionnaire below.',
  },
  { fr: 'Notre questionnaire de feedback', en: 'Our feedback questionnaire' },
  { fr: 'Coordonnees', en: 'Contact details' },
  { fr: 'First name *', en: 'First name *' },
  { fr: 'Last name *', en: 'Last name *' },
  { fr: 'Email address *', en: 'Email address *' },
  { fr: 'Annuler', en: 'Cancel' },
  { fr: 'Enregistrement...', en: 'Saving...' },
  { fr: 'Enregistrer', en: 'Save' },
  { fr: 'Pratique', en: 'Practice' },
  { fr: 'Pays', en: 'Country' },
  { fr: 'Sport', en: 'Sport' },
  { fr: 'Level', en: 'Level' },
  { fr: 'Moyenne annuelle', en: 'Yearly average' },
  { fr: 'Ajouter un sport', en: 'Add a sport' },
  { fr: 'Velo de route', en: 'Road cycling' },
  { fr: 'Gravel', en: 'Gravel' },
  { fr: 'VTT', en: 'MTB' },
  { fr: 'Trail', en: 'Trail running' },
  { fr: 'Randonnee', en: 'Hiking' },
  { fr: 'Debutant', en: 'Beginner' },
  { fr: 'Intermediaire', en: 'Intermediate' },
  { fr: 'Avance', en: 'Advanced' },
  { fr: 'Expert', en: 'Expert' },
  { fr: 'Mot de passe', en: 'Password' },
  { fr: 'Current password *', en: 'Current password *' },
  { fr: 'Current password', en: 'Current password' },
  { fr: 'Mise a jour...', en: 'Updating...' },
  { fr: 'Changer le mot de passe', en: 'Change password' },
  { fr: 'Coordonnees enregistrees.', en: 'Contact details saved.' },
  { fr: 'Impossible d’enregistrer le compte.', en: 'Unable to save the account.' },
  { fr: 'Impossible d’enregistrer les informations de pratique.', en: 'Unable to save practice details.' },
  { fr: 'Mot de passe mis a jour.', en: 'Password updated.' },
  { fr: 'Impossible de mettre a jour le mot de passe.', en: 'Unable to update the password.' },
  { fr: 'Chargement du compte...', en: 'Loading account...' },
  { fr: 'Aucune information de compte disponible.', en: 'No account information available.' },
  { fr: 'Compte', en: 'Account' },
  { fr: 'Enregistrement de votre e-mail de facturation…', en: 'Saving your billing email...' },
  { fr: 'E-mail de facturation enregistré.', en: 'Billing email saved.' },
  { fr: 'Impossible d’enregistrer l’e-mail de facturation.', en: 'Unable to save the billing email.' },
  { fr: 'Impossible de charger les informations d’abonnement.', en: 'Unable to load subscription details.' },
  { fr: 'Gestion de l’abonnement', en: 'Subscription management' },
  { fr: 'Découvrir les offres payantes', en: 'Explore paid plans' },
  { fr: 'Reprendre', en: 'Resume' },
  { fr: 'Interrompre', en: 'Pause' },
  { fr: 'Basculer sur cette offre', en: 'Switch to this plan' },
  { fr: 'Choisir cette offre', en: 'Choose this plan' },
  { fr: 'Choisir une offre payante', en: 'Choose a paid plan' },
  { fr: 'Remplacer mon moyen de paiement', en: 'Replace my payment method' },
  { fr: 'Ajouter un moyen de paiement', en: 'Add a payment method' },
  { fr: 'Passer à une offre payante', en: 'Upgrade to a paid plan' },
  { fr: 'Remplacer le moyen de paiement', en: 'Replace payment method' },
  { fr: 'Adresse indisponible', en: 'Address unavailable' },
  { fr: 'billing@votre-domaine.com', en: 'billing@your-domain.com' },
  { fr: 'Aucun moyen de paiement par défaut', en: 'No default payment method' },
  { fr: 'Plan Demo sans paiement', en: 'Demo plan without payment' },
  { fr: 'Ajoutez ou remplacez votre carte directement dans RedView App.', en: 'Add or replace your card directly in RedView App.' },
  {
    fr: 'Le plan Demo ne requiert aucun paiement. Ajoutez un moyen de paiement uniquement lorsque vous passez à une offre payante.',
    en: 'The Demo plan does not require payment. Add a payment method only when you switch to a paid plan.',
  },
  { fr: 'Carte Bancaire', en: 'Bank card' },
  { fr: 'Amazon Pay', en: 'Amazon Pay' },
  { fr: 'Numéro de carte *', en: 'Card number *' },
  { fr: 'CVV *', en: 'CVV *' },
  { fr: 'Name on card *', en: 'Name on card *' },
  { fr: 'Expiry *', en: 'Expiry *' },
  { fr: 'Country *', en: 'Country *' },
  { fr: 'Aucun abonnement Stripe à synchroniser après confirmation.', en: 'No Stripe subscription to sync after confirmation.' },
  { fr: 'Saisissez le nom du titulaire de la carte.', en: 'Enter the cardholder name.' },
  { fr: 'Le champ de carte Stripe est introuvable.', en: 'The Stripe card field could not be found.' },
  { fr: 'Stripe n’a pas renvoyé de SetupIntent exploitable.', en: 'Stripe did not return a usable SetupIntent.' },
  { fr: 'La confirmation Stripe a échoué.', en: 'Stripe confirmation failed.' },
] as const;

export function isAppLocale(value: unknown): value is AppLocale {
  return value === 'fr' || value === 'en';
}

export function resolveAppLocale(value: unknown): AppLocale {
  if (Array.isArray(value)) {
    return resolveAppLocale(value[0]);
  }

  if (typeof value !== 'string') {
    return 'fr';
  }

  return LEGACY_LANGUAGE_TO_LOCALE[value] ?? (value.toLowerCase().startsWith('en') ? 'en' : 'fr');
}

export function detectNavigatorAppLocale(): AppLocale {
  if (typeof navigator === 'undefined') {
    return 'fr';
  }

  return resolveAppLocale(navigator.language);
}

export function readStoredAppLocale(): AppLocale {
  if (typeof window === 'undefined') {
    return 'fr';
  }

  try {
    const raw = window.localStorage.getItem(PROJECT_BROWSER_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return detectNavigatorAppLocale();
    }

    const parsed = JSON.parse(raw) as { language?: unknown };
    return resolveAppLocale(parsed.language);
  } catch {
    return detectNavigatorAppLocale();
  }
}

export function writeStoredAppLocale(locale: AppLocale): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const raw = window.localStorage.getItem(PROJECT_BROWSER_SETTINGS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    window.localStorage.setItem(
      PROJECT_BROWSER_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...parsed,
        language: locale,
      }),
    );
  } catch {
    // Best effort only.
  }
}

export function createAppTranslationBundle(locale: AppLocale): AppTranslationBundle {
  const entries: Record<string, string> = {};

  for (const pair of TRANSLATION_PAIRS) {
    const target = locale === 'fr' ? pair.fr : pair.en;
    entries[pair.fr] = target;
    entries[pair.en] = target;
  }

  return {
    locale,
    entries,
  };
}