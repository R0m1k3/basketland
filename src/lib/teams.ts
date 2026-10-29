/**
 * Référentiel statique des 30 franchises NBA (abréviations ESPN).
 *
 * Sert à l'habillage : couleurs d'équipe, conférence/division, nom court.
 * `accent` est la couleur lisible sur fond sombre (la couleur principale de
 * certaines équipes — Nets, Wolves… — est trop foncée pour ressortir).
 */
export interface TeamInfo {
  abbr: string;
  city: string;
  nick: string;
  conference: 'Est' | 'Ouest';
  division: string;
  primary: string;
  accent: string;
}

const T = (
  abbr: string,
  city: string,
  nick: string,
  conference: TeamInfo['conference'],
  division: string,
  primary: string,
  accent: string,
): TeamInfo => ({ abbr, city, nick, conference, division, primary, accent });

export const TEAMS: TeamInfo[] = [
  T('ATL', 'Atlanta', 'Hawks', 'Est', 'Sud-Est', '#C8102E', '#FF4D5A'),
  T('BOS', 'Boston', 'Celtics', 'Est', 'Atlantique', '#007A33', '#2FBF6B'),
  T('BKN', 'Brooklyn', 'Nets', 'Est', 'Atlantique', '#111111', '#E8E8E8'),
  T('CHA', 'Charlotte', 'Hornets', 'Est', 'Sud-Est', '#1D1160', '#21B3C6'),
  T('CHI', 'Chicago', 'Bulls', 'Est', 'Centrale', '#CE1141', '#FF3D63'),
  T('CLE', 'Cleveland', 'Cavaliers', 'Est', 'Centrale', '#860038', '#FDBB30'),
  T('DET', 'Detroit', 'Pistons', 'Est', 'Centrale', '#C8102E', '#4F8CFF'),
  T('IND', 'Indiana', 'Pacers', 'Est', 'Centrale', '#002D62', '#FDBB30'),
  T('MIA', 'Miami', 'Heat', 'Est', 'Sud-Est', '#98002E', '#F9A01B'),
  T('MIL', 'Milwaukee', 'Bucks', 'Est', 'Centrale', '#00471B', '#5FBF5A'),
  T('NY', 'New York', 'Knicks', 'Est', 'Atlantique', '#006BB6', '#F58426'),
  T('ORL', 'Orlando', 'Magic', 'Est', 'Sud-Est', '#0077C0', '#3DA9FF'),
  T('PHI', 'Philadelphie', '76ers', 'Est', 'Atlantique', '#006BB6', '#ED174C'),
  T('TOR', 'Toronto', 'Raptors', 'Est', 'Atlantique', '#CE1141', '#FF3D63'),
  T('WSH', 'Washington', 'Wizards', 'Est', 'Sud-Est', '#002B5C', '#E31837'),
  T('DAL', 'Dallas', 'Mavericks', 'Ouest', 'Sud-Ouest', '#00538C', '#2E9BFF'),
  T('DEN', 'Denver', 'Nuggets', 'Ouest', 'Nord-Ouest', '#0E2240', '#FEC524'),
  T('GS', 'Golden State', 'Warriors', 'Ouest', 'Pacifique', '#1D428A', '#FFC72C'),
  T('HOU', 'Houston', 'Rockets', 'Ouest', 'Sud-Ouest', '#CE1141', '#FF3D63'),
  T('LAC', 'Los Angeles', 'Clippers', 'Ouest', 'Pacifique', '#C8102E', '#3D8BFF'),
  T('LAL', 'Los Angeles', 'Lakers', 'Ouest', 'Pacifique', '#552583', '#FDB927'),
  T('MEM', 'Memphis', 'Grizzlies', 'Ouest', 'Sud-Ouest', '#12173F', '#7D9BD6'),
  T('MIN', 'Minnesota', 'Timberwolves', 'Ouest', 'Nord-Ouest', '#0C2340', '#78BE20'),
  T('NO', 'La Nouvelle-Orléans', 'Pelicans', 'Ouest', 'Sud-Ouest', '#0C2340', '#C8A86B'),
  T('OKC', 'Oklahoma City', 'Thunder', 'Ouest', 'Nord-Ouest', '#007AC1', '#EF5B3A'),
  T('PHX', 'Phoenix', 'Suns', 'Ouest', 'Pacifique', '#1D1160', '#E56020'),
  T('POR', 'Portland', 'Trail Blazers', 'Ouest', 'Nord-Ouest', '#E03A3E', '#FF5A5E'),
  T('SA', 'San Antonio', 'Spurs', 'Ouest', 'Sud-Ouest', '#000000', '#C4CED4'),
  T('SAC', 'Sacramento', 'Kings', 'Ouest', 'Pacifique', '#5A2D81', '#A974E6'),
  T('UTAH', 'Utah', 'Jazz', 'Ouest', 'Nord-Ouest', '#3E2680', '#9B7BFF'),
];

const BY_ABBR = new Map(TEAMS.map((t) => [t.abbr, t]));

/** Équipe par abréviation ESPN ; repli neutre pour une équipe inconnue (All-Star…). */
export function teamInfo(abbr: string): TeamInfo {
  return (
    BY_ABBR.get(abbr.toUpperCase()) ?? {
      abbr: abbr.toUpperCase(),
      city: '',
      nick: abbr.toUpperCase(),
      conference: 'Est',
      division: '',
      primary: '#3A3A44',
      accent: '#B8B8C4',
    }
  );
}

export function isNbaTeam(abbr: string): boolean {
  return BY_ABBR.has(abbr.toUpperCase());
}

export function teamLogoUrl(abbr: string): string {
  return `https://a.espncdn.com/i/teamlogos/nba/500/${abbr.toLowerCase()}.png`;
}
