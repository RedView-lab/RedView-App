/**
 * Commentaires sur la carte 3D, façon Figma : bulles d'info posées sur le
 * relief (point ou zone), fils de discussion (réponses, réactions, mentions,
 * résolu), lu / non lu par utilisateur, liste en panneau droit en mode
 * commentaire. Données : `ItineraryProject.comments` (document partagé, temps
 * réel) et `commentsView` (vue de chaque utilisateur).
 */

export { CommentToolProvider } from './context/CommentToolContext';
export { useCommentToolOptional } from './context/commentTool';
export type { CommentToolValue } from './context/commentTool';
export { MapCommentsLayer } from './components/MapCommentsLayer';
export { CommentsPanel } from './components/CommentsPanel';
export { CommentToolbarButton } from './components/CommentToolbarButton';
export { CommentShortcuts } from './components/CommentShortcuts';
export { readCommentAuthor } from './lib/identity';
