/**
 * Étiquettes Appwrite des comptes (alphanumériques seulement). Module sans
 * dépendance : la suppression de compte et le webhook Stripe les lisent tous
 * deux, sans cycle d'import.
 */

/** Compte bloqué en attente de purge (api/_lib/accountDeletion.ts). */
export const DELETION_PENDING_LABEL = 'deletionpending';
