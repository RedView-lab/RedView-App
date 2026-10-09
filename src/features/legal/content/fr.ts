/**
 * Pages légales en français : textes établis à partir de l'audit de conformité
 * du 2026-10-08 (docs/audits/2026-10-08-conformite-fr-ue.md : inventaire des
 * traitements § 3, traceurs § 4, durées § 5) et du code. Tout changement de
 * traitement (nouvelle donnée, nouveau prestataire, nouvelle durée) se reporte
 * ici ET dans en.ts, et avance LEGAL_UPDATED_ON (publisher.ts).
 * Brouillons à faire relire par un juriste avant publication.
 */
import type { LegalPublisher } from '../lib/publisher';
import type { LegalChrome, LegalDocuments } from '../lib/types';

const MISSING = '[à compléter]';

export const FRENCH_CHROME: LegalChrome = {
  updatedOn: 'Dernière mise à jour : {{date}}',
  backToApp: 'Retour à RedView',
  navLabel: 'Informations légales',
  missing: MISSING,
  pageLabels: {
    'legal-notice': 'Mentions légales',
    privacy: 'Confidentialité',
    terms: 'Conditions d’utilisation',
    accessibility: 'Accessibilité',
  },
};

export function frenchLegalDocuments(publisher: LegalPublisher): LegalDocuments {
  const v = (value: string | null) => value ?? MISSING;
  const editor = v(publisher.name);
  const contact = publisher.contactEmail ? `[${publisher.contactEmail}](mailto:${publisher.contactEmail})` : MISSING;
  const host = publisher.host;
  const region = v(host.region);

  return {
    'legal-notice': {
      title: 'Mentions légales',
      lead: 'Informations sur l’éditeur et l’hébergeur du service RedView (app.redview.tech), conformément à l’article 1-1 de la loi n° 2004-575 du 21 juin 2004 pour la confiance dans l’économie numérique.',
      sections: [
        {
          heading: 'Éditeur',
          blocks: [
            { p: `RedView est édité par ${editor}, ${v(publisher.legalForm)}, immatriculé sous le numéro ${v(publisher.registration)}, dont le siège est situé ${v(publisher.address)}.` },
            { ul: [`Téléphone : ${v(publisher.phone)}`, `E-mail : ${contact}`, `Numéro de TVA intracommunautaire : ${v(publisher.vatNumber)}`] },
          ],
        },
        {
          heading: 'Directeur de la publication',
          blocks: [{ p: v(publisher.publicationDirector) }],
        },
        {
          heading: 'Hébergement',
          blocks: [
            { p: `Le service est hébergé sur l’infrastructure Oracle Cloud par ${v(host.name)}, ${v(host.address)}, téléphone ${v(host.phone)}, sur des serveurs situés : ${region}.` },
            { p: 'Les comptes, les projets, les fichiers, la mesure d’audience et le suivi des erreurs sont hébergés sur ces mêmes serveurs, sans recours à un prestataire d’hébergement tiers.' },
          ],
        },
        {
          heading: 'Contact et signalement',
          blocks: [
            { p: `Pour toute question, pour exercer vos droits sur vos données ou pour signaler un contenu illicite : ${contact}. Nous répondons en français et en anglais.` },
          ],
        },
        {
          heading: 'Propriété intellectuelle',
          blocks: [
            { p: `Le service RedView, son code, ses moteurs de calcul, ses textes, sa marque et ses éléments graphiques sont la propriété exclusive de ${editor}. Toute reproduction ou réutilisation sans autorisation écrite est interdite.` },
            { p: 'Les données cartographiques, d’altitude, météorologiques et de points d’intérêt proviennent de sources tierces sous leur propre licence : la liste et les attributions figurent dans Réglages → Sources des données.' },
          ],
        },
      ],
    },

    privacy: {
      title: 'Politique de confidentialité',
      lead: 'Cette politique explique quelles données RedView traite, pourquoi, combien de temps, avec qui, et comment exercer vos droits (règlement (UE) 2016/679, « RGPD », et loi Informatique et Libertés).',
      sections: [
        {
          heading: '1. Responsable du traitement',
          blocks: [
            { p: `Le responsable du traitement est ${editor}, ${v(publisher.address)}. Pour toute question ou demande relative à vos données : ${contact}.` },
          ],
        },
        {
          heading: '2. Données traitées, finalités et bases légales',
          blocks: [
            {
              ul: [
                'Compte et connexion : nom, adresse e-mail, mot de passe (stocké haché, jamais en clair), identifiant Google si vous vous connectez avec Google, sessions. Finalité : fournir le service. Base : exécution du contrat.',
                'E-mails de service : adresse e-mail, codes de vérification à usage unique (valables 10 minutes), avis liés à votre compte et à votre abonnement. Base : exécution du contrat.',
                'Projets : itinéraires, points de départ et d’étape (données de localisation), réglages, commentaires, vignettes, fichiers importés. Base : exécution du contrat.',
                'Fichiers d’activité FIT : traces GPS horodatées, vitesse, puissance, cadence et fréquence cardiaque, qui peuvent révéler des informations sur votre santé. Finalité : calibrer la prédiction de votre temps de parcours. Base : votre consentement explicite, demandé avant tout import et retirable à tout moment dans Compte → Vos données (le retrait efface les fichiers FIT de votre compte).',
                'Co-édition d’un projet partagé : identifiant de compte, nom, modifications ; la position du curseur et la vue de la carte des autres éditeurs sont transmises en direct mais jamais enregistrées. Base : exécution du contrat.',
                'Abonnement et paiement : identifiant client et abonnement chez notre prestataire de paiement, factures. Vos coordonnées bancaires sont saisies et conservées par le prestataire, jamais par RedView. Bases : exécution du contrat et obligations comptables.',
                'Mesure d’audience : événements anonymes (écrans consultés, actions en catégories et valeurs arrondies), sans cookie, sans identifiant de compte ni adresse e-mail, avec un outil hébergé par RedView. Base : intérêt légitime, dans les conditions d’exemption de consentement de la CNIL ; vous pouvez vous y opposer dans Réglages → Mesure d’audience.',
                'Suivi des erreurs : message d’erreur, page concernée sans paramètres, navigateur et version de l’application, avec un outil hébergé par RedView. Base : intérêt légitime (fiabilité du service).',
                'Journaux techniques : méthode, route, statut et durée des requêtes, sans adresse IP ni URL complète dans les journaux de l’application ; les journaux du serveur web frontal peuvent contenir l’adresse IP. Base : intérêt légitime (sécurité) et obligations légales de conservation.',
                'Sauvegardes : copie chiffrée de l’ensemble des données, pour pouvoir restaurer le service. Base : intérêt légitime (continuité du service).',
              ],
            },
          ],
        },
        {
          heading: '3. La carte et les sources de données',
          blocks: [
            { p: 'Pour afficher la carte, le relief, l’imagerie, la météo et les nuages de points LiDAR, votre navigateur contacte directement des fournisseurs de tuiles et de données : Mapbox, l’IGN, swisstopo, Amazon Web Services (relief mondial) et, selon la zone consultée, d’autres instituts géographiques nationaux. Ils reçoivent votre adresse IP et la zone affichée, comme pour tout site qui les utilise. Le radar de précipitations (composites EUMETNET OPERA) est lu et dessiné par nos serveurs : votre navigateur ne contacte pas son fournisseur.' },
            { p: 'Mapbox enregistre en outre dans le stockage de votre navigateur un identifiant aléatoire, transmis avec ses statistiques de chargement de carte. Ces statistiques servent à Mapbox (facturation et fonctionnement de son service) et ne contiennent ni votre nom ni votre adresse e-mail.' },
          ],
        },
        {
          heading: '4. Destinataires et sous-traitants',
          blocks: [
            { p: 'Vos données ne sont ni vendues ni louées. Elles sont accessibles aux seules personnes qui en ont besoin pour faire fonctionner le service, et à nos sous-traitants :' },
            {
              ul: [
                `Oracle (hébergement de tous les serveurs de RedView) — serveurs situés : ${region}.`,
                'Resend (envoi des e-mails de service) — États-Unis.',
                'Stripe (paiement des abonnements) — Union européenne et États-Unis.',
                'Google (connexion avec Google, si vous la choisissez ; stockage de nos sauvegardes, chiffrées avant envoi : Google n’a pas accès à leur contenu) — États-Unis.',
                'Mapbox (affichage de la carte, voir § 3) — États-Unis.',
              ],
            },
            { p: 'Les personnes que vous invitez sur un projet partagé voient ce projet, ses commentaires et votre nom.' },
          ],
        },
        {
          heading: '5. Transferts hors de l’Union européenne',
          blocks: [
            { p: 'Certains prestataires sont établis aux États-Unis. Ces transferts reposent sur la décision d’adéquation de la Commission européenne du 10 juillet 2023 (EU-U.S. Data Privacy Framework) pour les sociétés certifiées, ou à défaut sur les clauses contractuelles types de la Commission européenne.' },
          ],
        },
        {
          heading: '6. Durées de conservation',
          blocks: [
            {
              ul: [
                'Compte, projets et fichiers : jusqu’à la suppression de votre compte ou du projet.',
                'Après une suppression : les données disparaissent tout de suite du service, puis des sauvegardes au plus tard 12 mois après (rotation des sauvegardes).',
                'Codes de vérification : 10 minutes.',
                'Mesure d’audience : 25 mois.',
                'Journaux techniques : 30 jours ; journal des calculs d’itinéraire : 48 heures.',
                'Factures et pièces comptables : 10 ans (article L.123-22 du Code de commerce), chez notre prestataire de paiement.',
                'Registre des suppressions de compte : identifiant et dates seulement, pour garantir qu’une restauration de sauvegarde ne fasse pas réapparaître un compte supprimé.',
              ],
            },
          ],
        },
        {
          heading: '7. Vos droits',
          blocks: [
            { p: 'Vous disposez d’un droit d’accès, de rectification, d’effacement, de limitation, d’opposition et de portabilité de vos données, et du droit de retirer votre consentement à tout moment. La plupart s’exercent directement dans l’application :' },
            {
              ul: [
                'Accès et portabilité : Compte → Vos données → télécharger toutes vos données (archive ZIP).',
                'Effacement : Compte → Vos données → supprimer mon compte (confirmé par un code envoyé par e-mail).',
                'Rectification : Compte → Coordonnées.',
                'Retrait du consentement aux fichiers FIT : Compte → Vos données.',
                'Opposition à la mesure d’audience : Réglages → Mesure d’audience.',
              ],
            },
            { p: `Pour toute autre demande : ${contact}. Nous répondons dans un délai d’un mois. Vous pouvez aussi introduire une réclamation auprès de la CNIL ([www.cnil.fr](https://www.cnil.fr), 3 place de Fontenoy, TSA 80715, 75334 Paris Cedex 07).` },
          ],
        },
        {
          heading: '8. Sécurité',
          blocks: [
            { p: 'Les échanges sont chiffrés (HTTPS), les mots de passe sont stockés hachés, les sauvegardes sont chiffrées avant de quitter nos serveurs, l’accès aux projets est contrôlé à chaque requête, et les tentatives répétées sont limitées. En cas de violation de données présentant un risque pour vous, nous la notifions à la CNIL dans les 72 heures et vous en informons si le risque est élevé.' },
          ],
        },
        {
          heading: '9. Cookies et stockage dans votre navigateur',
          blocks: [
            { p: 'RedView ne dépose aucun cookie publicitaire ni de mesure. Le service de comptes peut déposer un cookie de session, strictement nécessaire à la connexion. Le stockage de votre navigateur conserve votre session, vos préférences d’affichage, une copie locale de vos projets (travail hors ligne), les tuiles de carte déjà chargées et les nuages de points LiDAR que vous téléchargez : ces éléments sont nécessaires au service que vous demandez et ne servent pas à vous suivre. L’identifiant de Mapbox est décrit au § 3.' },
          ],
        },
        {
          heading: '10. Mineurs',
          blocks: [
            { p: 'RedView est destiné aux personnes de 15 ans et plus. La souscription d’un abonnement payant est réservée aux personnes majeures.' },
          ],
        },
        {
          heading: '11. Modifications',
          blocks: [
            { p: 'Cette politique peut évoluer avec le service. La date de dernière mise à jour figure en tête de page ; en cas de changement important, nous vous en informons dans l’application ou par e-mail.' },
          ],
        },
      ],
    },

    terms: {
      title: 'Conditions générales d’utilisation et de vente',
      lead: `Les présentes conditions régissent l’utilisation du service RedView, édité par ${editor}. Créer un compte vaut acceptation de ces conditions et de la [politique de confidentialité](/confidentialite).`,
      sections: [
        {
          heading: '1. Le service',
          blocks: [
            { p: 'RedView est une application web de préparation et d’analyse d’itinéraires en relief (ultra-cyclisme, bikepacking, trail) : calcul d’itinéraires, prédiction du temps de parcours, analyse du terrain, de la météo et de la neige, visualisation de nuages de points LiDAR, co-édition de projets.' },
            { p: 'Le service est actuellement en version bêta : des fonctions peuvent évoluer, être ajoutées ou retirées.' },
          ],
        },
        {
          heading: '2. Accès et compte',
          blocks: [
            { p: 'Le service est réservé aux personnes de 15 ans et plus. Vous vous engagez à fournir une adresse e-mail valide, à garder votre mot de passe secret et à nous signaler toute utilisation non autorisée de votre compte. Vous êtes responsable de l’activité de votre compte.' },
          ],
        },
        {
          heading: '3. Informations fournies par le service : à titre indicatif',
          blocks: [
            { p: 'Les itinéraires, temps de parcours, profils, prévisions météorologiques, hauteurs de neige, expositions au terrain avalancheux et autres analyses sont des estimations calculées à partir de données tierces et de modèles. Ils peuvent être inexacts, incomplets ou périmés et ne remplacent ni la consultation des sources officielles (bulletins Météo-France, bulletins d’estimation du risque d’avalanche, arrêtés de circulation), ni votre jugement sur le terrain. Vous restez seul responsable de vos sorties, de votre sécurité et du respect du code de la route et des règles d’accès aux espaces naturels.' },
          ],
        },
        {
          heading: '4. Vos contenus',
          blocks: [
            { p: 'Vous restez propriétaire des projets, commentaires et fichiers que vous créez ou importez. Vous nous accordez le seul droit de les héberger, de les traiter et de les afficher, à vous et aux personnes avec qui vous partagez un projet, pour faire fonctionner le service.' },
            { p: 'Vous vous engagez à ne pas publier de contenu illicite, injurieux, portant atteinte aux droits d’autrui, ni de données personnelles de tiers sans droit. Il est interdit de perturber le service, de le surcharger, de contourner ses limites ou ses mesures de sécurité, ou d’en extraire massivement les données.' },
          ],
        },
        {
          heading: '5. Signalement et modération',
          blocks: [
            { p: `Tout contenu que vous estimez illicite (dans un projet partagé ou un commentaire) peut être signalé à ${contact}, en indiquant le projet ou le commentaire concerné et la raison du signalement. Nous examinons chaque signalement avec diligence, vous informons de la suite donnée, et motivons toute décision de retrait ou de restriction auprès de l’auteur du contenu, qui peut la contester par le même moyen (règlement (UE) 2022/2065 sur les services numériques, articles 14, 16 et 17).` },
          ],
        },
        {
          heading: '6. Projets partagés',
          blocks: [
            { p: 'Le propriétaire d’un projet peut inviter d’autres comptes RedView à le modifier, et retirer leur accès à tout moment. Les personnes invitées voient le projet, ses commentaires et le nom des autres éditeurs. Le propriétaire reste responsable du projet et peut le supprimer.' },
          ],
        },
        {
          heading: '7. Abonnement payant',
          blocks: [
            {
              ul: [
                'Formules, prix TTC : 1 mois à 14,90 €, 6 mois à 70 €, 1 an à 119 €. Le prix applicable est celui affiché au moment de la souscription.',
                'Essai gratuit de 7 jours lors de la première souscription d’un compte, une seule fois ; un moyen de paiement est demandé au départ et le premier prélèvement a lieu à la fin de l’essai, sauf résiliation avant.',
                'L’abonnement se renouvelle automatiquement pour la même durée. Pour les formules de 6 mois et d’un an, nous vous prévenons par e-mail avant chaque renouvellement (article L.215-1 du Code de la consommation).',
                'Résiliation à tout moment dans l’application (Abonnement → Résilier votre contrat) : elle prend effet à la fin de la période en cours, sans autre prélèvement.',
                'Le paiement est traité par Stripe ; RedView n’a jamais accès à vos coordonnées bancaires.',
              ],
            },
          ],
        },
        {
          heading: '8. Droit de rétractation',
          blocks: [
            { p: 'Si vous êtes un consommateur, vous disposez de 14 jours à compter de la souscription pour vous rétracter, sans motif, en nous écrivant à l’adresse de contact. Si vous avez demandé à utiliser le service avant la fin de ce délai, le montant correspondant au service fourni jusqu’à votre rétractation reste dû (articles L.221-18 et L.221-25 du Code de la consommation) ; le reste vous est remboursé sous 14 jours.' },
          ],
        },
        {
          heading: '9. Disponibilité et responsabilité',
          blocks: [
            { p: 'Nous faisons notre possible pour que le service soit disponible et fiable, sans pouvoir garantir une disponibilité continue, notamment pendant les opérations de maintenance. Les données importées sont sauvegardées chaque nuit ; nous vous conseillons de garder vos propres copies (export GPX, fichier de projet .redview).' },
            { p: 'Notre responsabilité ne peut être engagée pour les conséquences de l’utilisation des informations fournies par le service (§ 3), ni pour les interruptions dues à des tiers (fournisseurs de données, réseau). Rien dans ces conditions ne limite les droits que vous tenez de la loi en tant que consommateur.' },
          ],
        },
        {
          heading: '10. Propriété intellectuelle et données tierces',
          blocks: [
            { p: `Le service et ses composants sont la propriété de ${editor}. Les données cartographiques et géographiques proviennent de tiers (OpenStreetMap, IGN, Météo-France, swisstopo…) sous leur propre licence, dont les attributions figurent dans Réglages → Sources des données.` },
          ],
        },
        {
          heading: '11. Suspension et fin du compte',
          blocks: [
            { p: 'Vous pouvez supprimer votre compte à tout moment (Compte → Vos données). Nous pouvons suspendre ou fermer un compte qui enfreint gravement ces conditions, après vous avoir informé du motif, sauf urgence ou obligation légale.' },
          ],
        },
        {
          heading: '12. Modification des conditions',
          blocks: [
            { p: 'Nous pouvons faire évoluer ces conditions. Vous serez informé de toute modification importante au moins 30 jours avant son entrée en vigueur ; si vous la refusez, vous pouvez résilier votre abonnement et supprimer votre compte.' },
          ],
        },
        {
          heading: '13. Droit applicable et litiges',
          blocks: [
            { p: `Les présentes conditions sont soumises au droit français. En cas de litige, contactez-nous d’abord à ${contact}. Si vous êtes un consommateur, vous pouvez recourir gratuitement au médiateur de la consommation : ${v(publisher.consumerMediator)}, ou à la plateforme européenne de règlement en ligne des litiges. À défaut d’accord, les tribunaux français sont compétents, sous réserve des règles protectrices du consommateur.` },
          ],
        },
      ],
    },

    accessibility: {
      title: 'Déclaration d’accessibilité',
      lead: `${editor} s’engage à rendre le service RedView accessible. Cette déclaration s’applique à app.redview.tech.`,
      sections: [
        {
          heading: 'État de conformité',
          blocks: [
            { p: 'RedView est partiellement conforme aux critères WCAG 2.2 de niveau A et AA. Aucun audit externe n’a encore été réalisé.' },
          ],
        },
        {
          heading: 'Vérifications réalisées',
          blocks: [
            { p: 'À chaque version, un test automatique (axe-core, critères WCAG 2.0 à 2.2 A et AA) parcourt les principaux écrans — connexion, projets, éditeur, exports, outils de carte, commentaires, réglages, partage, compte, suppression du compte — ainsi que le visualiseur LiDAR et son menu : aucun défaut détecté. Les outils de carte principaux s’atteignent et s’activent au clavier, avec un contour de focus visible.' },
          ],
        },
        {
          heading: 'Contenus non accessibles',
          blocks: [
            { p: 'La carte 3D et le visualiseur LiDAR sont des rendus graphiques (WebGL, WebGPU) sans alternative textuelle complète ; le profil d’altitude et l’horaire du parcours en donnent une partie sous forme de valeurs. Le dessin d’un itinéraire à la souris n’a pas d’équivalent complet au clavier ; un fichier GPX peut être importé à la place.' },
          ],
        },
        {
          heading: 'Retour d’information et contact',
          blocks: [
            { p: `Si vous n’arrivez pas à accéder à un contenu ou à une fonction, écrivez-nous à ${contact} : nous vous proposerons une solution ou le contenu sous une autre forme.` },
          ],
        },
        {
          heading: 'Voies de recours',
          blocks: [
            { p: 'Si votre demande reste sans réponse satisfaisante, vous pouvez saisir le Défenseur des droits ([www.defenseurdesdroits.fr](https://www.defenseurdesdroits.fr)).' },
          ],
        },
      ],
    },
  };
}
