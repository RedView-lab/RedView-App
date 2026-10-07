/**
 * Pages vues virtuelles : l'URL réelle porte le nom et l'id du projet
 * (`/project/<nom>--<id>`) et `/` sert à la fois la connexion et le gestionnaire
 * de projets. La mesure ne voit que ces écrans, au titre fixe — les rapports
 * Parcours et Entonnoir restent lisibles sans un nom de projet. Chemins en
 * français : c'est ce que lit l'équipe dans la liste des pages d'Umami.
 */

export const ANALYTICS_SCREENS = {
  login: '/connexion',
  signup: '/inscription',
  reset_password: '/mot-de-passe-oublie',
  unreachable: '/serveur-injoignable',
  projects: '/projets',
  projects_account: '/projets/compte',
  projects_subscription: '/projets/abonnement',
  projects_settings: '/projets/reglages',
  editor: '/editeur-3d',
  viewer: '/viewer-lidar',
  blocked_mobile: '/bloque/telephone',
  blocked_small_window: '/bloque/fenetre-trop-petite',
} as const;

export type AnalyticsScreen = keyof typeof ANALYTICS_SCREENS;

export const ANALYTICS_SCREEN_TITLES: Record<AnalyticsScreen, string> = {
  login: 'Connexion',
  signup: 'Inscription',
  reset_password: 'Mot de passe oublié',
  unreachable: 'Serveur injoignable',
  projects: 'Mes projets',
  projects_account: 'Mon compte',
  projects_subscription: 'Abonnement',
  projects_settings: 'Réglages',
  editor: 'Éditeur 3D',
  viewer: 'Viewer LiDAR',
  blocked_mobile: 'Bloqué : téléphone',
  blocked_small_window: 'Bloqué : fenêtre trop petite',
};

const SCREEN_BY_PATH = new Map<string, AnalyticsScreen>(
  (Object.entries(ANALYTICS_SCREENS) as Array<[AnalyticsScreen, string]>).map(([screen, path]) => [path, screen]),
);

export function screenForPath(pathname: string): AnalyticsScreen | undefined {
  return SCREEN_BY_PATH.get(pathname);
}
