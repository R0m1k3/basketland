/**
 * Générateur de VF française **déterministe** (règles + gabarits), sans LLM.
 * Entrée : actions ESPN (texte anglais + contexte). Sortie : lignes courtes en français.
 */
import type { PlayRow, SubtitleKind } from './types';

export type PlayCategory =
  | 'jumpball'
  | 'made_fg'
  | 'missed_fg'
  | 'blocked_fg'
  | 'ft_made'
  | 'ft_missed'
  | 'rebound_off'
  | 'rebound_def'
  | 'turnover'
  | 'foul_personal'
  | 'foul_shooting'
  | 'foul_offensive'
  | 'foul_technical'
  | 'foul_flagrant'
  | 'timeout'
  | 'substitution'
  | 'period_start'
  | 'period_end'
  | 'game_end'
  | 'challenge'
  | 'review'
  | 'violation'
  | 'ejection'
  | 'other';

export function classifyPlay(eventType: string, text: string, scoring: boolean): PlayCategory {
  const t = `${eventType} ${text}`.toLowerCase();
  if (/end (of )?game/.test(t)) return 'game_end';
  if (/^end period|end of the \d|end of (the )?(\d+(st|nd|rd|th) )?(quarter|half|overtime|ot)/.test(t)) return 'period_end';
  if (/^start period|start of the \d|start of (the )?(\d+(st|nd|rd|th) )?(quarter|half|overtime|ot)/.test(t)) return 'period_start';
  if (/jump ?ball/.test(t)) return 'jumpball';
  if (/ejected|ejection/.test(t)) return 'ejection';
  if (/review/.test(t)) return 'review';
  if (/challenge/.test(t)) return 'challenge';
  if (/timeout/.test(t)) return 'timeout';
  if (/substitution|enters the game/.test(t)) return 'substitution';
  if (/free throw/.test(t)) {
    if (/\bmisses\b/.test(t)) return 'ft_missed';
    return scoring || /\bmakes\b/.test(t) ? 'ft_made' : 'ft_missed';
  }
  if (/rebound/.test(t)) return /offensive/.test(t) ? 'rebound_off' : 'rebound_def';
  if (/turnover|traveling|bad pass|lost ball|steps out|out of bounds|shot clock|backcourt|double dribble|palming|discontinue/.test(t))
    return 'turnover';
  if (/flagrant/.test(t)) return 'foul_flagrant';
  if (/technical|3-seconds|three seconds|flopping|delay of game/.test(t) && !/offensive 3/.test(t)) return 'foul_technical';
  if (/offensive charge|offensive foul|charge\b/.test(t)) return 'foul_offensive';
  if (/shooting foul|shooting block foul/.test(t)) return 'foul_shooting';
  if (/foul/.test(t)) return 'foul_personal';
  if (/goaltending|kicked ball|violation|lane|jump ball violation/.test(t)) return 'violation';
  if (/\bblocks\b/.test(t)) return 'blocked_fg';
  if (scoring || /\bmakes\b/.test(t)) return 'made_fg';
  if (/\bmisses\b/.test(t)) return 'missed_fg';
  return 'other';
}

/** « Action clé » au sens de la spec : panier, temps mort, changement de quart, fin de match. */
export function isKeyCategory(c: PlayCategory): boolean {
  return ['made_fg', 'ft_made', 'timeout', 'period_start', 'period_end', 'game_end', 'jumpball'].includes(c);
}

// ------------------------------------------------------------------ lexique

export function ordinalFr(n: number, feminine = false): string {
  if (n === 1) return feminine ? '1re' : '1er';
  return `${n}e`;
}

/** Libellé de période : 1-4 → « 1er quart », 5+ → « 1re prolongation ». */
export function periodLabel(period: number): string {
  if (period <= 4) return `${ordinalFr(period)} quart`;
  return `${ordinalFr(period - 4, true)} prolongation`;
}

/** « du 1er quart » / « de la 1re prolongation ». */
export function withArticle(period: number): string {
  return period <= 4 ? `du ${periodLabel(period)}` : `de la ${periodLabel(period)}`;
}

function feetToMeters(ft: number): number {
  return Math.round(ft * 0.3048);
}

interface ShotInfo {
  kind: 'dunk' | 'layup' | 'hook' | 'tip' | 'floater' | 'jumper' | 'generic';
  three: boolean;
  alleyOop: boolean;
  stepBack: boolean;
  bank: boolean;
  meters: number | null;
}

export function parseShot(phrase: string, scoreValue = 0): ShotInfo {
  const p = phrase.toLowerCase();
  const ft = p.match(/(\d+)-foot/);
  const meters = ft ? feetToMeters(Number(ft[1])) : null;
  let kind: ShotInfo['kind'] = 'generic';
  if (/dunk/.test(p)) kind = 'dunk';
  else if (/tip/.test(p)) kind = 'tip';
  else if (/layup|lay-up|finger roll/.test(p)) kind = 'layup';
  else if (/hook/.test(p)) kind = 'hook';
  else if (/float/.test(p)) kind = 'floater';
  else if (/jump|jumper|pullup|fade|shot/.test(p) && !/two point shot/.test(p)) kind = 'jumper';
  return {
    kind,
    three: /three point|3-pt|three-point/.test(p) || scoreValue === 3,
    alleyOop: /alley oop/.test(p),
    stepBack: /step ?back/.test(p),
    bank: /bank/.test(p),
    meters: meters !== null && meters >= 2 ? meters : null,
  };
}

function madeShotFr(actor: string, s: ShotInfo, assist?: string): string {
  const servi = assist ? `, passe décisive de ${assist}` : '';
  if (s.kind === 'dunk') return `Dunk de ${actor}${s.alleyOop ? ' sur alley-oop' : ''}${assist ? `, servi par ${assist}` : ''} !`;
  if (s.three) return `${actor} marque à trois points${s.meters ? ` (${s.meters} m)` : ''}${servi} !`;
  switch (s.kind) {
    case 'layup':
      return `${actor} marque en lay-up${servi}`;
    case 'tip':
      return `${actor} marque en claquette${servi}`;
    case 'hook':
      return `${actor} marque en bras roulé${servi}`;
    case 'floater':
      return `${actor} marque en floater${s.meters ? ` à ${s.meters} m` : ''}${servi}`;
    case 'jumper':
      return `${actor} marque sur un shoot${s.stepBack ? ' en step-back' : ''}${s.meters ? ` à ${s.meters} m` : ''}${s.bank ? ' avec la planche' : ''}${servi}`;
    default:
      return `${actor} marque à deux points${s.meters ? ` (${s.meters} m)` : ''}${servi}`;
  }
}

function shotNounFr(s: ShotInfo): string {
  if (s.kind === 'dunk') return 'dunk';
  if (s.three) return 'shoot à trois points';
  switch (s.kind) {
    case 'layup':
      return 'lay-up';
    case 'tip':
      return 'claquette';
    case 'hook':
      return 'bras roulé';
    case 'floater':
      return 'floater';
    case 'jumper':
      return s.stepBack ? 'shoot en step-back' : 'shoot';
    default:
      return 'tir à deux points';
  }
}

function missedShotFr(actor: string, s: ShotInfo): string {
  return `${actor} rate son ${shotNounFr(s)}`;
}

const TURNOVER_KINDS: [RegExp, string][] = [
  [/bad pass/, 'mauvaise passe'],
  [/lost ball/, 'ballon perdu'],
  [/traveling/, 'marcher'],
  [/offensive foul/, 'faute offensive'],
  [/steps out|step turnover/, 'sortie de terrain'],
  [/out of bounds/, 'sortie de balle'],
  [/shot clock/, '24 secondes'],
  [/backcourt/, 'retour en zone'],
  [/double dribble|discontinue/, 'reprise de dribble'],
  [/palming/, 'ballon porté'],
  [/3 second|3-second/, '3 secondes'],
  [/8 second/, '8 secondes'],
];

/** Dictionnaire de repli (mot à mot) pour les libellés inconnus. */
const FALLBACK_LEXICON: [RegExp, string][] = [
  [/\bmakes\b/g, 'marque'],
  [/\bmisses\b/g, 'rate'],
  [/\boffensive rebound\b/g, 'rebond offensif'],
  [/\bdefensive rebound\b/g, 'rebond défensif'],
  [/\brebound\b/g, 'rebond'],
  [/\bassists\b/g, 'passe décisive'],
  [/\bsteals\b/g, 'interception'],
  [/\bblocks\b/g, 'contre'],
  [/\bturnover\b/g, 'perte de balle'],
  [/\bthree point\b/g, 'à trois points'],
  [/\bfree throw\b/g, 'lancer franc'],
  [/\btechnical foul\b/g, 'faute technique'],
  [/\bpersonal foul\b/g, 'faute personnelle'],
  [/\bfoul\b/g, 'faute'],
  [/\btimeout\b/g, 'temps mort'],
  [/\bjump shot\b|\bjumper\b|\bjumpshot\b/g, 'shoot'],
  [/\blayup\b/g, 'lay-up'],
  [/\bdunk\b/g, 'dunk'],
  [/\bviolation\b/g, 'violation'],
  [/\bof\b/g, 'sur'],
];

export function fallbackTranslate(text: string): string {
  let s = text;
  for (const [re, fr] of FALLBACK_LEXICON) s = s.replace(re, fr);
  return s;
}

export interface TranslateContext {
  teamNames?: Record<string, string>; // abbr → nom court (ex. 'Lakers')
}

/**
 * Traduit une action ESPN en une ligne française. Renvoie toujours une chaîne
 * (repli lexical pour les cas inconnus) ; la sélection se fait ailleurs.
 */
export function translatePlay(play: Pick<PlayRow, 'event_type' | 'text_en' | 'scoring' | 'period' | 'score_value'>): string {
  const text = play.text_en.trim();
  const cat = classifyPlay(play.event_type, text, !!play.scoring);
  const lower = text.toLowerCase();
  let m: RegExpMatchArray | null;

  switch (cat) {
    case 'game_end':
      return 'Fin du match';
    case 'period_end':
      return `Fin ${withArticle(play.period)}`;
    case 'period_start':
      return `Début ${withArticle(play.period)}`;
    case 'jumpball': {
      m = text.match(/^(.+?) vs\.? (.+?)(?: \((.+?) gains possession\))?$/i);
      if (m) return `Entre-deux : ${m[1]} contre ${m[2]}${m[3] ? `, ballon pour ${m[3]}` : ''}`;
      return 'Entre-deux';
    }
    case 'timeout': {
      if (/official/i.test(text)) return 'Temps mort officiel';
      m = text.match(/^(.+?)\s+(full|20 sec\.?|short|mandatory)?\s*timeout/i);
      const team = m?.[1]?.trim();
      return team ? `Temps mort ${team}` : 'Temps mort';
    }
    case 'substitution': {
      m = text.match(/^(.+?) enters the game for (.+)$/i);
      return m ? `${m[1]} remplace ${m[2]}` : 'Changement';
    }
    case 'ft_made':
    case 'ft_missed': {
      m = text.match(/^(.+?) (makes|misses)\s+(technical |flagrant )?free throw\s*(technical |flagrant |clear path )?(\d) of (\d)/i);
      if (m) {
        const verb = m[2].toLowerCase() === 'makes' ? 'marque' : 'rate';
        const tech = (m[3] || m[4] || '').trim().toLowerCase();
        const qual = tech === 'technical' ? ' (technique)' : tech === 'flagrant' ? ' (faute flagrante)' : '';
        return `${m[1]} ${verb} le lancer franc${qual} ${m[5]} sur ${m[6]}`;
      }
      m = text.match(/^(.+?) (makes|misses)\s+(technical )?free throw/i);
      if (m) return `${m[1]} ${m[2].toLowerCase() === 'makes' ? 'marque' : 'rate'} le lancer franc${m[3] ? ' technique' : ''}`;
      return fallbackTranslate(text);
    }
    case 'made_fg': {
      m = text.match(/^(.+?) makes (.+?)(?: \((.+?) assists\))?$/i);
      if (m) return madeShotFr(m[1], parseShot(m[2], play.score_value), m[3]);
      return fallbackTranslate(text);
    }
    case 'missed_fg': {
      m = text.match(/^(.+?) misses (.+)$/i);
      if (m) return missedShotFr(m[1], parseShot(m[2], play.score_value));
      return fallbackTranslate(text);
    }
    case 'blocked_fg': {
      m = text.match(/^(.+?) blocks (.+?)'s? (.+)$/i);
      if (m) return `Contre de ${m[1]} sur le ${shotNounFr(parseShot(m[3]))} de ${m[2]} !`;
      m = text.match(/^(.+?) blocks (.+)$/i);
      return m ? `Contre de ${m[1]} sur ${m[2]} !` : fallbackTranslate(text);
    }
    case 'rebound_off':
    case 'rebound_def': {
      const kind = cat === 'rebound_off' ? 'offensif' : 'défensif';
      m = text.match(/^(.+?) (offensive|defensive) team rebound/i);
      if (m) return `Rebond ${kind} pour les ${m[1]}`;
      m = text.match(/^(.+?) (offensive|defensive)? ?rebound/i);
      return m ? `Rebond ${kind} de ${m[1]}` : `Rebond ${kind}`;
    }
    case 'turnover': {
      const steal = text.match(/\((.+?) steals\)/i)?.[1];
      const who = text.match(/^(.+?) (bad pass|lost ball|traveling|offensive foul|steps out|out of bounds|shot clock|backcourt|double dribble|palming|discontinue|3 second|8 second|turnover)/i)?.[1];
      const kind = TURNOVER_KINDS.find(([re]) => re.test(lower))?.[1];
      if (/shot clock/.test(lower) && !who) return 'Violation des 24 secondes';
      if (steal && who) return `Interception de ${steal} sur ${kind === 'mauvaise passe' ? 'une mauvaise passe' : 'un ballon perdu'} de ${who} !`;
      if (kind === 'marcher' && who) return `Marcher de ${who}`;
      if (who) return `Perte de balle de ${who}${kind ? ` (${kind})` : ''}`;
      return `Perte de balle${kind ? ` (${kind})` : ''}`;
    }
    case 'foul_flagrant': {
      m = text.match(/^(.+?) flagrant foul type (\d)/i);
      return m ? `Faute flagrante ${m[2]} de ${m[1]}` : 'Faute flagrante';
    }
    case 'foul_technical': {
      const who = text.match(/^(.+?) (defensive 3-seconds|technical|flopping|delay)/i)?.[1];
      if (/3-seconds|three seconds/.test(lower)) return who ? `Faute technique de ${who} (3 secondes défensives)` : 'Faute technique (3 secondes défensives)';
      if (/flopping/.test(lower)) return who ? `Faute technique de ${who} (simulation)` : 'Faute technique (simulation)';
      if (/delay/.test(lower)) return who ? `Retard de jeu : ${who}` : 'Retard de jeu';
      return who ? `Faute technique de ${who}` : 'Faute technique';
    }
    case 'foul_offensive': {
      const who = text.match(/^(.+?) offensive (charge|foul)/i);
      if (who) return who[2].toLowerCase() === 'charge' ? `Passage en force de ${who[1]}` : `Faute offensive de ${who[1]}`;
      return 'Faute offensive';
    }
    case 'foul_shooting': {
      const who = text.match(/^(.+?) shooting( block)? foul/i)?.[1];
      return who ? `Faute de ${who} sur un tir` : 'Faute sur un tir';
    }
    case 'foul_personal': {
      const who = text.match(/^(.+?) (personal take foul|personal foul|loose ball foul|take foul|away from play foul|transition take foul|clear path foul|foul)/i);
      if (!who) return 'Faute personnelle';
      const k = who[2].toLowerCase();
      if (k.includes('take')) return `Faute volontaire de ${who[1]}`;
      if (k.includes('loose ball')) return `Faute de ${who[1]} sur ballon libre`;
      if (k.includes('clear path')) return `Faute « clear path » de ${who[1]}`;
      return `Faute personnelle de ${who[1]}`;
    }
    case 'challenge': {
      if (/overturned/i.test(text)) return 'Challenge : décision annulée';
      if (/support|stands/i.test(text)) return 'Challenge : décision confirmée';
      m = text.match(/^(.+?) coach'?s challenge/i);
      return m ? `Challenge demandé par les ${m[1]}` : 'Challenge vidéo';
    }
    case 'review':
      if (/overturned/i.test(text)) return 'Arbitrage vidéo : décision annulée';
      if (/support|stands/i.test(text)) return 'Arbitrage vidéo : décision confirmée';
      return 'Arbitrage vidéo';
    case 'violation': {
      const who = text.match(/^(.+?) (defensive goaltending|offensive goaltending|goaltending|kicked ball|lane|jump ball|delay)/i);
      if (who) {
        const k = who[2].toLowerCase();
        if (k.includes('goaltending')) return `Goaltending ${k.includes('offensive') ? 'offensif' : 'défensif'} de ${who[1]}`;
        if (k.includes('kicked')) return `Ballon touché du pied par ${who[1]}`;
        if (k.includes('lane')) return `Violation de zone : ${who[1]}`;
        return `Violation : ${who[1]}`;
      }
      return 'Violation';
    }
    case 'ejection': {
      m = text.match(/^(.+?) (ejected|ejection)/i);
      return m ? `${m[1]} est expulsé !` : 'Expulsion';
    }
    default:
      return fallbackTranslate(text);
  }
}

// ------------------------------------------------------------------ sélection

export interface CommentaryLine {
  seq: number;
  period: number;
  clock_sec: number;
  wallclock: string;
  text_fr: string;
  kind: SubtitleKind;
  speaker: string;
  priority: number;
  /** Durée suggérée d'affichage (s). */
  hold: number;
}

export interface CommentaryOptions {
  minLines?: number;
  maxLines?: number;
  homeAbbr?: string;
  awayAbbr?: string;
}

function holdFor(text: string): number {
  return Math.min(6, Math.max(2.5, 1.5 + text.length / 18));
}

function scoreLine(p: PlayRow, o: CommentaryOptions): string {
  if (p.home_score === null || p.away_score === null) return '';
  return ` · ${o.awayAbbr ?? 'EXT'} ${p.away_score} – ${p.home_score} ${o.homeAbbr ?? 'DOM'}`;
}

/**
 * Sélectionne et traduit les actions notables (cible 120-180 lignes).
 * Les séries de lancers francs sont regroupées en une seule ligne.
 */
export function buildCommentary(plays: PlayRow[], opts: CommentaryOptions = {}): CommentaryLine[] {
  const minLines = opts.minLines ?? 120;
  const maxLines = opts.maxLines ?? 180;
  const sorted = [...plays].sort((a, b) => a.seq - b.seq);
  const primary: CommentaryLine[] = [];
  const extras: CommentaryLine[] = [];
  let firstPlayDone = false;
  // Préfixe de bannière « Coup d'envoi » : appliqué à la première ligne
  // réellement commentée, pour ne pas créer de ligne supplémentaire (et donc
  // pas de doublon de `seq`, qui est la clé primaire en base).
  let startBanner = '';

  const push = (list: CommentaryLine[], p: PlayRow, text: string, priority: number, kind: SubtitleKind = 'action') => {
    // La bannière de coup d'envoi préfixe la première ligne commentée plutôt
    // que d'en créer une supplémentaire : deux lignes de même `seq`
    // violeraient la contrainte UNIQUE (match_id, seq).
    let finalText = text;
    let finalKind = kind;
    if (startBanner) {
      finalText = `${startBanner} ${text}`;
      finalKind = 'banniere';
      startBanner = '';
    }
    list.push({
      seq: p.seq,
      period: p.period,
      clock_sec: p.clock_sec,
      wallclock: p.wallclock,
      text_fr: finalText,
      kind: finalKind,
      speaker: p.team_abbr,
      priority,
      hold: holdFor(finalText),
    });
  };

  // Actions déjà commentées (dans une série de lancers francs par exemple) :
  // sans ce suivi, elles seraient commentées une seconde fois.
  const consumed = new Set<number>();

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    // Une action déjà consommée par une série précédente ne doit pas être
    // commentée une seconde fois (une série de lancers francs peut être
    // interrompue par un remplacement : le 2e lancer serait alors rejoué).
    if (consumed.has(p.seq)) continue;
    const cat = classifyPlay(p.event_type, p.text_en, !!p.scoring);

    if (!firstPlayDone && p.period === 1) {
      firstPlayDone = true;
      // La bannière de coup d'envoi ne doit pas voler l'action à la VF :
      // si l'action est déjà commentable (tir, lancer franc…), on la laisse
      // au traitement normal et la bannière n'est qu'un préfixe.
      const commented = !['jumpball', 'other', 'substitution', 'timeout'].includes(cat);
      const head = cat === 'jumpball' ? `Coup d'envoi ! ${translatePlay(p)}` : 'Coup d\'envoi du match !';
      if (!commented) {
        // La bannière porte le `seq` de l'action : si l'action génère aussi
        // sa propre ligne juste après, les deux porteraient le même `seq` et
        // l'insertion violerait la contrainte UNIQUE (match_id, seq).
        push(primary, p, head, 100, 'banniere');
        consumed.add(p.seq);
        continue;
      }
      // L'action reste commentée normalement ; on note seulement le début.
      startBanner = head;
    }

    switch (cat) {
      case 'game_end':
        push(primary, p, `Fin du match${scoreLine(p, opts)}`, 100, 'score');
        break;
      case 'period_end':
        push(primary, p, `${translatePlay(p)}${scoreLine(p, opts)}`, 100, 'score');
        break;
      case 'period_start':
        push(primary, p, translatePlay(p), 95, 'banniere');
        break;
      case 'jumpball':
        push(primary, p, translatePlay(p), 60);
        break;
      case 'timeout':
        push(primary, p, translatePlay(p), 90);
        break;
      case 'ejection':
        push(primary, p, translatePlay(p), 100);
        break;
      case 'foul_flagrant':
        push(primary, p, translatePlay(p), 88);
        break;
      case 'foul_technical':
        push(/3-seconds|flopping|delay/i.test(p.text_en) ? extras : primary, p, translatePlay(p), /3-seconds|flopping|delay/i.test(p.text_en) ? 35 : 80);
        break;
      case 'made_fg': {
        const shot = parseShot(p.text_en, p.score_value);
        push(primary, p, translatePlay(p), shot.three || shot.kind === 'dunk' ? 85 : 70);
        break;
      }
      case 'ft_made':
      case 'ft_missed': {
        // Regroupe la série de lancers francs.
        //
        // Le même tireur, la même période, et un chrono qui avance de peu :
        // entre deux lancers d'une même série, le chrono de jeu descend
        // normalement de quelques secondes (un lancer prend ~1 s, l'arrêt
        // de jeu peut en prendre davantage). Exiger un chrono identique
        // ne regroupait donc jamais les séries réelles.
        const MAX_GAP_SEC = 30;
        const series: PlayRow[] = [p];
        let j = i + 1;
        while (j < sorted.length) {
          const q = sorted[j];
          const qc = classifyPlay(q.event_type, q.text_en, !!q.scoring);
          if (qc === 'ft_made' || qc === 'ft_missed') {
            const gap = p.clock_sec - q.clock_sec;
            if (q.actor === p.actor && q.period === p.period && gap >= 0 && gap <= MAX_GAP_SEC) {
              series.push(q);
              j++;
              continue;
            }
            break;
          }
          // Les remplacements/temps morts s'intercalent souvent entre deux lancers.
          if ((qc === 'substitution' || qc === 'timeout') && q.period === p.period) {
            j++;
            continue;
          }
          break;
        }
        const made = series.filter((s) => classifyPlay(s.event_type, s.text_en, !!s.scoring) === 'ft_made').length;
        const who = p.actor || p.text_en.match(/^(.+?) (makes|misses)/i)?.[1] || '';
        const text =
          series.length === 1
            ? translatePlay(p)
            : `${who} : ${made}/${series.length} aux lancers francs`;
        push(made > 0 ? primary : extras, p, text, made > 0 ? 60 : 30);
        // Toute la série est consommée : le 2e lancer ne doit pas être
        // re-commenté quand un remplacement l'a séparée du 1er dans le flux.
        for (const s of series) consumed.add(s.seq);
        // On avance l'index jusqu'au dernier élément de la série, en sautant
        // les actions intercalées (remplacement, temps mort) : sans cela, la
        // boucle principale les retraite et le 2e lancer est re-commenté.
        let last = i;
        while (last + 1 < sorted.length && consumed.has(sorted[last + 1].seq)) last++;
        i = last;
        break;
      }
      case 'turnover':
        if (/steals\)/i.test(p.text_en)) push(primary, p, translatePlay(p), 50);
        else extras.push({ ...lineFrom(p, translatePlay(p), 15) });
        break;
      case 'blocked_fg':
        push(primary, p, translatePlay(p), 50);
        break;
      case 'challenge':
      case 'review':
        push(primary, p, translatePlay(p), 55);
        break;
      case 'foul_offensive':
        push(primary, p, translatePlay(p), 40);
        break;
      case 'missed_fg': {
        const shot = parseShot(p.text_en, p.score_value);
        push(extras, p, translatePlay(p), shot.three ? 28 : 12);
        break;
      }
      case 'rebound_off':
        push(extras, p, translatePlay(p), 25);
        break;
      case 'foul_shooting':
        push(extras, p, translatePlay(p), 20);
        break;
      case 'violation':
        push(extras, p, translatePlay(p), 22);
        break;
      default:
        break;
    }
  }

  let lines = primary;
  if (lines.length > maxLines) {
    // Retire d'abord les lignes de plus faible priorité (les plus récentes en dernier recours).
    const keep = [...lines].sort((a, b) => b.priority - a.priority || a.seq - b.seq).slice(0, maxLines);
    // On garde les objets retenus (pas leurs `seq`) : deux lignes peuvent
    // partager le même `seq` sans être la même ligne.
    const keepSet = new Set(keep);
    lines = lines.filter((l) => keepSet.has(l));
  } else if (lines.length < minLines && extras.length) {
    const need = minLines - lines.length;
    const add = [...extras].sort((a, b) => b.priority - a.priority || a.seq - b.seq).slice(0, need);
    lines = [...lines, ...add];
  }

  // `seq` est la clé primaire (match_id, seq) : on garantit des valeurs
  // uniques et croissantes, quelle que soit la façon dont les lignes ont
  // été produites. Sans cela, une insertion peut échouer sur une contrainte
  // UNIQUE et laisser le match sans VF.
  const sortedLines = lines.sort((a, b) => a.seq - b.seq);
  const seen = new Set<number>();
  let next = 0;
  for (const l of sortedLines) {
    while (seen.has(l.seq)) l.seq = ++next;
    seen.add(l.seq);
    next = Math.max(next, l.seq);
  }
  return sortedLines.sort((a, b) => a.seq - b.seq);
}

function lineFrom(p: PlayRow, text: string, priority: number): CommentaryLine {
  return {
    seq: p.seq,
    period: p.period,
    clock_sec: p.clock_sec,
    wallclock: p.wallclock,
    text_fr: text,
    kind: 'action',
    speaker: p.team_abbr,
    priority,
    hold: holdFor(text),
  };
}
