// Commentaires du projet (bulles sur la carte 3D, façon Figma).
//
// Les fils font partie du document partagé (co-édition temps réel,
// projects.data, fichier .redview) ; leur état lu / non lu et les réglages
// d'affichage de la liste sont la vue de chaque utilisateur (`commentsView`).
// Modèle de fusion : collab/schema.ts ; règles d'auteur vérifiées par le
// serveur : collab/model/commentRules.ts ; écritures : features/comments.

/** Point d'ancrage d'une bulle : sur le relief (altitude du terrain à la création). */
export interface ProjectCommentAnchor {
  lng: number;
  lat: number;
  /** Altitude du sol au point, m (null si inconnue : le viewer LiDAR lit son MNT). */
  elevationM: number | null;
}

/** Zone commentée : empreinte au sol (anneau fermé implicitement, lng/lat). */
export interface ProjectCommentZone {
  ring: Array<[number, number]>;
}

/** Point de vue de l'auteur à la création : « aller au commentaire » le rétablit. */
export interface ProjectCommentCamera {
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface ProjectCommentMessage {
  id: string;
  authorId: string;
  /** Nom de l'auteur à l'écriture (celui du membre du projet l'emporte à l'affichage). */
  authorName: string;
  /** Texte brut (sauts de ligne gardés, `@Nom` pour une mention). */
  text: string;
  createdAt: string;
  editedAt?: string;
  /** Utilisateurs mentionnés (ids). */
  mentions?: string[];
  /** Une clé par réaction, `${emoji}~${userId}` : deux réactions ne se marchent jamais dessus. */
  reactions?: Record<string, true>;
}

export interface ProjectCommentThread {
  id: string;
  anchor: ProjectCommentAnchor;
  zone?: ProjectCommentZone;
  camera?: ProjectCommentCamera;
  createdBy: string;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  /** Premier message = celui du fil ; le supprimer supprime le fil. */
  messages: ProjectCommentMessage[];
}

/** Dernier message vu d'un fil (`m` : son id, `t` : sa date, au cas où il serait supprimé). */
export interface ProjectCommentReadMark {
  m?: string;
  t?: string;
  /** « Marquer comme non lu ». */
  unread?: true;
}

export type ProjectCommentSort = 'date' | 'unread' | 'route';

/** Vue de l'utilisateur sur les commentaires (couche vue, `project_views`). */
export interface ProjectCommentsView {
  reads?: Record<string, ProjectCommentReadMark>;
  /** Bulles masquées hors mode commentaire (Maj+C). */
  hidden?: boolean;
  showResolved?: boolean;
  onlyMine?: boolean;
  sort?: ProjectCommentSort;
}
