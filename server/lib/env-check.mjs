// ---------------------------------------------------------------------------
// Configuration du serveur de prod vérifiée au démarrage. Chaque variable
// ci-dessous manquante coupe une fonction sans aucun bruit jusqu'au premier
// utilisateur qui l'essaie : un code d'inscription qui ne part pas (Resend),
// un webhook Stripe refusé, des itinéraires envoyés vers localhost… La
// surveillance du VPS (server/vps/watch) ne teste ni l'envoi d'e-mails ni
// Stripe. Le serveur démarre quand même (le reste de l'app fonctionne) ; le
// manque est journalisé et signalé à GlitchTip par server.mjs.
// Les variables facultatives (METEOFRANCE_API_KEY, MULTIPLAYER_INTERNAL_SECRET…)
// n'y sont pas : leur absence a un repli documenté dans .env.example.
// ---------------------------------------------------------------------------

/** @type {ReadonlyArray<{ name: string, feature: string }>} */
export const PRODUCTION_ENV = [
  { name: 'APPWRITE_API_KEY', feature: 'inscription, partage, facturation, suppression du compte' },
  { name: 'RESEND_API_KEY', feature: 'e-mails (codes d\'inscription et de suppression, abonnement)' },
  { name: 'STRIPE_SECRET_KEY', feature: 'facturation' },
  { name: 'STRIPE_WEBHOOK_SECRET', feature: 'webhook Stripe' },
  { name: 'BROUTER_UPSTREAM', feature: 'calcul d\'itinéraires' },
  { name: 'POI_UPSTREAM', feature: 'points d\'intérêt' },
  { name: 'WEATHER_UPSTREAM', feature: 'tuiles météo' },
  { name: 'OPENMETEO_UPSTREAM', feature: 'prévisions et modèle neige' },
];

/**
 * Variables de PRODUCTION_ENV absentes ou vides.
 * @param {Record<string, string | undefined>} [env]
 */
export function missingProductionEnv(env = process.env) {
  return PRODUCTION_ENV.filter(({ name }) => !(env[name] ?? '').trim());
}
