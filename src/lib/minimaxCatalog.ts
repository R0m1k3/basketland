/**
 * Catalogue MiniMax proposé dans la page Paramètres (sans dépendance serveur :
 * importé aussi par le formulaire côté navigateur).
 */

/** Modèles texte MiniMax proposés pour la traduction des commentaires (API compatible OpenAI). */
export const MINIMAX_TEXT_MODELS = [
  { id: 'MiniMax-M3.1-Flash', label: 'MiniMax M3.1 Flash — rapide' },
  { id: 'MiniMax-M3', label: 'MiniMax M3 — plus soigné, plus lent' },
] as const;
export const MINIMAX_DEFAULT_TEXT_MODEL = 'MiniMax-M3.1-Flash';
