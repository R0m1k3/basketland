import type { CupInfo, TvFr } from '@/lib/present';

type Size = 'sm' | 'md';

function pad(size: Size): string {
  return size === 'sm' ? 'px-2 py-[3px] text-[10px]' : 'px-2.5 py-1 text-[11px]';
}

/** Petit écran stylisé (diffusion télé). */
function IconTv({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="m8 2 4 4 4-4" />
    </svg>
  );
}

/**
 * Diffusion en France : « beIN SPORTS 1 » (avec la chaîne, ou « différé »)
 * et/ou « Prime Video ». `short` : seulement le diffuseur (« beIN SPORTS »),
 * pour les matchs passés et les listes compactes.
 */
export function TvBadges({ tv, size = 'md', short = false }: { tv?: TvFr[]; size?: Size; short?: boolean }) {
  if (!tv?.length) return null;
  // Un même diffuseur n'apparaît qu'une fois en version courte.
  const list = short ? tv.filter((t, i) => tv.findIndex((x) => x.kind === t.kind) === i) : tv;
  return (
    <>
      {list.map((t) => {
        const label = short ? (t.kind === 'prime' ? 'Prime Video' : 'beIN SPORTS') : t.name;
        const title = `Diffusé en France sur ${t.name}${t.live ? '' : ' (en différé)'}`;
        return (
          <span
            key={t.name}
            title={title}
            aria-label={title}
            className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full font-bold uppercase tracking-wider text-white ${pad(size)} ${
              t.kind === 'prime' ? 'bg-prime' : 'bg-bein'
            }`}
          >
            <IconTv size={size === 'sm' ? 10 : 11} />
            {label}
            {!t.live && !short && <span className="font-semibold normal-case tracking-normal opacity-80">· différé</span>}
          </span>
        );
      })}
    </>
  );
}

/** Repère « NBA Cup » d'un match du tournoi (avec la phase hors groupes). */
export function CupBadge({ cup, size = 'md' }: { cup?: CupInfo; size?: Size }) {
  if (!cup) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-cup/60 bg-cup/15 font-bold uppercase tracking-wider text-cup-hot ${pad(size)}`}
      title={`NBA Cup · ${cup.label}`}
    >
      <IconCup size={size === 'sm' ? 10 : 11} />
      NBA Cup{cup.round !== 'group' ? ` · ${cup.label}` : ''}
    </span>
  );
}

/** Trophée. */
export function IconCup({ size = 12, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" />
      <path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4" />
      <path d="M12 13v4M8.5 20h7M10 17h4" />
    </svg>
  );
}

/** Abrégé d'une chaîne pour les listes denses : « beIN 1 », « beIN MAX 4 », « Prime ». */
export function tvShort(t: TvFr): string {
  return t.kind === 'prime' ? 'Prime' : t.name.replace('beIN SPORTS', 'beIN');
}

/** Diffusion en France en texte coloré, pour les listes denses. */
export function TvMini({ tv }: { tv?: TvFr[] }) {
  if (!tv?.length) return null;
  const label = tv.map((t) => `${t.name}${t.live ? '' : ' (différé)'}`).join(', ');
  return (
    <span className="inline-flex items-center gap-1" title={`Diffusé en France sur ${label}`} aria-label={`Diffusé en France sur ${label}`}>
      {tv.map((t) => (
        <span
          key={t.name}
          className={`whitespace-nowrap rounded px-1 py-px text-[9px] font-bold uppercase tracking-wide text-white ${
            t.kind === 'prime' ? 'bg-prime' : 'bg-bein'
          }`}
        >
          {tvShort(t)}
        </span>
      ))}
    </span>
  );
}
