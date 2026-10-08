# Facturation (Stripe)

Un seul abonnement « RedView », toutes les fonctionnalités. Seule la durée change le prix :

| Durée | Prix TTC | Prix mensuel équivalent | Réduction | `lookup_key` |
|---|---|---|---|---|
| 1 mois | 14,90 € | — | sans engagement | `redview_monthly` |
| 6 mois | 70 € | 11,67 € | −22 % | `redview_semiannual` |
| 1 an | 119 € | 9,92 € | −33 % | `redview_annual` |

Chaque formule commence par **7 jours d'essai gratuit** à la première souscription d'un client. L'essai n'est jamais accordé deux fois au même client Stripe.

Pendant la bêta ouverte, l'accès à l'app ne dépend pas encore de l'abonnement (`App.tsx`). Fermer la bêta est une décision produit à part.

## Où est quoi

| Rôle | Fichier |
|---|---|
| Grille de référence (montants, durées, essai) | `api/_lib/billing/plans.ts` |
| Copie affichée par l'app (test de parité `plans.test.ts`) | `src/features/projectBrowser/lib/billing/plans.ts` |
| Prix Stripe par `lookup_key`, refus d'un prix qui ne correspond pas à la grille | `api/_lib/billing/prices.ts` |
| Cycle de vie : souscrire, essai, synchroniser, résilier / reprendre | `api/_lib/billing/subscriptions.ts` |
| Moyens de paiement proposés (configuration « RedView abonnements » : carte, PayPal, SEPA) | `api/_lib/billing/paymentMethodConfig.ts` |
| Portail client (factures, moyens de paiement, changement de durée) | `api/_lib/billing/portal.ts` |
| Vue d'ensemble (abonnement lu chez Stripe, moyens de paiement, essai disponible) | `api/_lib/billing/overview.ts` |
| Routes | `api/billing/{subscription,portal,payment-method,contact,overview}.ts` |
| Webhook et ses évènements | `api/stripe/webhook.ts`, `api/_lib/billing/webhookEvents.ts` |
| E-mails d'abonnement | `api/_lib/mailer.ts` (fin du fichier) |
| Interface | `projectBrowser/components/subscription/` (onglet Abonnement, cartes, pop-in de résiliation), `projectBrowser/billing/components/BillingActionModal/` (page de paiement, Payment Element) |
| Configuration du compte Stripe | `scripts/billing/setup-stripe.ts` (`npm run billing:setup`) |

## Parcours

**Moyens de paiement.** Un SetupIntent n'a pas de devise : sans configuration dédiée, Stripe proposerait tout ce que le compte a activé (le bac à sable ouvrait le formulaire sur BLIK, puis Pix ou Klarna). La configuration « RedView abonnements » ne garde que la carte, PayPal et SEPA (pas Link : son encart d'inscription se déplie à la fin de la saisie de la carte et décalait le bouton de validation sous le curseur), dès que le compte les a activés. Elle est passée aux SetupIntents ; la première facture d'un abonnement payé sans essai reçoit les mêmes types de moyens. Le Payment Element ne masque aucun champ : un champ masqué devrait être fourni à la confirmation, sinon Stripe la refuse. Le pays est seulement prérempli (FR).

**Première souscription (essai).** `start` crée un SetupIntent. L'app le confirme avec le Payment Element (carte, PayPal ou autre moyen activé dans le Dashboard ; 3-D Secure compris), sans rien prélever. Puis `activate` crée l'abonnement avec ce moyen par défaut, `trial_period_days: 7` et `trial_settings.end_behavior.missing_payment_method: cancel`. La création utilise une clé d'idempotence par SetupIntent. Le webhook `setup_intent.succeeded` fait la même activation en secours, par exemple si l'onglet a été fermé pendant une redirection PayPal. Il n'existe donc toujours qu'un seul abonnement, et jamais d'essai sans moyen de paiement enregistré.

**Souscriptions suivantes (essai déjà consommé).** L'abonnement est créé `default_incomplete`. L'app paie sa première facture : `latest_invoice.confirmation_secret` est passé au Payment Element, puis `sync` relit l'abonnement. Une tentative abandonnée est annulée à la souscription suivante.

**Changer de durée.** L'app ouvre le portail client sur `flow_data.subscription_update_confirm` : Stripe montre le prorata, encaisse la différence (`always_invoice`) et gère le 3-D Secure. Pendant l'essai, `trial_update_behavior: continue_trial` garde les jours restants. On n'utilise jamais `schedule_at_period_end` : il attacherait un échéancier à l'abonnement, que la résiliation dans l'app ne pourrait plus modifier.

**Résilier.** Le bouton « Résilier votre contrat » est dans l'onglet Abonnement (art. L.215-1-1 du Code de la consommation). Il ouvre un récapitulatif : compte, formule, référence `sub_…`, date de fin. La confirmation pose `cancel_at_period_end: true` ; la reprise pose `cancel_at_period_end: false`, qui lève aussi un `cancel_at` posé par le portail. Stripe refuse les deux paramètres ensemble. Le webhook envoie ensuite la confirmation par e-mail (support durable).

**Retour d'une redirection.** Stripe ramène sur `/?tab=subscription&billing_return=<trial|subscription|payment-method>`. L'app finit le parcours, puis retire ces paramètres de l'URL.

## Webhook

Chaque évènement relit son objet chez Stripe au lieu de croire la charge reçue : l'ordre de livraison n'est pas garanti. Un échec répond 500 et Stripe relivre. Un refus attendu (`PublicError` < 500) est acquitté. Les évènements déjà traités sont gardés en mémoire du processus, pour ne pas renvoyer un e-mail sur une relivraison.

E-mails envoyés (Resend) :

| Évènement | E-mail |
|---|---|
| `customer.subscription.updated` qui passe en résiliation | Confirmation de résiliation et date de fin |
| `customer.subscription.trial_will_end` (3 jours avant) | Fin de l'essai : montant et date du premier prélèvement |
| `invoice.upcoming` sur une formule 6 mois ou 1 an | Information avant reconduction tacite (art. L.215-1 : entre 3 mois et 1 mois avant) |

Reçus et factures sont envoyés par Stripe : activer les e-mails clients dans le Dashboard (Paramètres → E-mails clients : paiements réussis, factures, remboursements).

## Mise en place d'un compte Stripe

1. Mettre `VITE_STRIPE_PUBLISHABLE_KEY` et `STRIPE_SECRET_KEY` dans l'environnement (bac à sable : `pk_test_` / `sk_test_`).
2. Lancer `npm run billing:setup`. Il crée le produit, les trois prix TTC (`tax_behavior: inclusive`), la configuration des moyens de paiement et celle du portail. Il est idempotent ; un montant changé donne un nouveau prix qui reprend la `lookup_key`, et l'ancien prix est archivé.
3. Créer le webhook :
   - en production : `npm run billing:setup -- --webhook-url=https://app.redview.tech/api/stripe/webhook`, puis mettre le secret affiché dans `STRIPE_WEBHOOK_SECRET` de Coolify ;
   - en local : `stripe listen --forward-to localhost:5173/api/stripe/webhook` (CLI : `npm install -g @stripe/cli`, puis `stripe login`).
4. Dans le Dashboard Stripe :
   - Billing → Paramètres → évènements de renouvellement à venir (« Upcoming renewal events ») : **30 jours ou plus** — réglage du Dashboard seulement, pas d'API. La valeur par défaut, 7 jours, est trop tardive pour l'art. L.215-1 (entre 3 mois et 1 mois avant l'échéance) ; `e2e:billing:live` échoue si l'évènement n'est pas parti à J−29. Réglé à 30 jours dans le bac à sable le 08/10/2026, à refaire en production ;
   - activer les moyens de paiement voulus (PayPal en zone euro), puis relancer `npm run billing:setup` ;
   - activer les e-mails clients ;
   - régler les relances des paiements échoués (Smart Retries).
5. Production : relancer l'étape 2 avec `--live` et les clés `sk_live_`.

## Tests

- `api/_lib/__tests__/billingRules.test.ts` : règles pures (abonnement montré, essai unique, prix acceptés, erreurs Stripe publiques).
- `src/features/projectBrowser/lib/billing/plans.test.ts` : parité de la grille, réductions, formats.
- `src/features/projectBrowser/components/subscription/SubscriptionPanel.test.tsx` : onglet Abonnement (grille, essai, état en cours, résiliation, reprise).
- `npm run e2e:billing:live` : le même parcours plus `stripe listen` (vrais webhooks relayés), une horloge de test Stripe (rappel de fin d'essai, passage en payant à la fin de l'essai, rappel de reconduction) et de vrais e-mails Resend vers `delivered@resend.dev`. Environ 5 min. Il n'est pas dans `check:full` : il exige les clés du bac à sable et envoie de vrais e-mails.
- `npm run e2e:billing` (`script-test-bench/billing-e2e/`) : le parcours dans un vrai navigateur (Edge sans interface) sur le build de prod, faux Appwrite côté serveur, vraies clés du bac à sable. Il couvre la grille, l'essai avec le Payment Element (carte 4242), le statut, les vrais webhooks signés, la résiliation et sa pop-in, la reprise, le portail, et le refus 3-D Secure. Il échoue sur une violation de CSP, une erreur de page ou un défaut axe ; `--skip-build` réutilise le build.
- `STRIPE_SANDBOX_E2E=1 npx vitest run api/_lib/__tests__/billing.sandbox.test.ts` : le parcours réel contre le bac à sable Stripe, avec un faux Appwrite et des e-mails simulés. Il couvre l'essai, l'idempotence de l'activation, les vrais évènements rejoués et signés vers le webhook, la résiliation et son e-mail, la reprise, la fin d'essai, la souscription sans essai, le portail et le 3-D Secure. Les clients Stripe créés sont supprimés à la fin. Sans la variable, le test est sauté (CI sans clé).

## À la charge de l'éditeur (hors code)

- CGV : prix, durée, reconduction, résiliation, rétractation de 14 jours et son formulaire, médiateur. Voir `docs/audits/2026-10-08-conformite-fr-ue.md` §9.
- Faire valider les libellés de la page de paiement (case de demande d'accès immédiat / rétractation au prorata) par un juriste.
