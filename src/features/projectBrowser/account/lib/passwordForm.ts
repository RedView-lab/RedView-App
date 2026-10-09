/** Saisie du changement de mot de passe (AccountPanel). */
export type AccountPasswordValue = {
  current: string;
  next: string;
  confirm: string;
};

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;

/** Raison de refuser la saisie avant tout appel, `null` si elle peut partir. */
export function passwordFormProblem(value: AccountPasswordValue, hasPassword: boolean): string | null {
  if (hasPassword && !value.current) return 'Saisissez votre mot de passe actuel.';
  if (value.next.length < MIN_PASSWORD_LENGTH) return 'Le mot de passe doit comporter au moins 8 caractères.';
  if (value.next.length > MAX_PASSWORD_LENGTH) return 'Le mot de passe ne doit pas dépasser 256 caractères.';
  if (value.next !== value.confirm) return 'Les mots de passe ne correspondent pas.';
  if (hasPassword && value.next === value.current) return 'Le nouveau mot de passe doit être différent de l’actuel.';
  return null;
}
