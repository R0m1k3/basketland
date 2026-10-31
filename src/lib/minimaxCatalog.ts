/**
 * Catalogue MiniMax proposé dans la page Paramètres (sans dépendance serveur :
 * importé aussi par le formulaire côté navigateur).
 */

/** Rôles des voix du doublage (dub.ts). */
export const MINIMAX_ROLES = ['A', 'B4', 'B1', 'F'] as const;
export type MinimaxRole = (typeof MINIMAX_ROLES)[number];

export const MINIMAX_ROLE_LABELS: Record<MinimaxRole, string> = {
  A: 'Commentateur',
  B4: 'Consultant',
  B1: 'Troisième voix',
  F: 'Voix féminine',
};

/** Modèles de voix MiniMax proposés. */
export const MINIMAX_MODELS = [
  { id: 'speech-2.8-hd', label: 'Speech 2.8 HD — meilleure qualité' },
  { id: 'speech-2.8-turbo', label: 'Speech 2.8 Turbo — plus rapide, moins de crédits' },
] as const;
export const MINIMAX_DEFAULT_MODEL = 'speech-2.8-hd';

/** Voix françaises du catalogue MiniMax (liste « System Voice ID » de la documentation). */
export const MINIMAX_FRENCH_VOICES = [
  { id: 'French_Male_Speech_New', label: 'Homme posé' },
  { id: 'French_MaleNarrator', label: 'Narrateur' },
  { id: 'French_CasualMan', label: 'Homme décontracté' },
  { id: 'French_FemaleAnchor', label: 'Présentatrice' },
  { id: 'French_Female_News Anchor', label: 'Présentatrice patiente' },
  { id: 'French_MovieLeadFemale', label: 'Héroïne de cinéma' },
] as const;

/** Voix par défaut de chaque rôle. */
export const MINIMAX_DEFAULT_VOICES: Readonly<Record<MinimaxRole, string>> = {
  A: 'French_Male_Speech_New',
  B4: 'French_MaleNarrator',
  B1: 'French_CasualMan',
  F: 'French_FemaleAnchor',
};
