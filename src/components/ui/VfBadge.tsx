import type { VfState } from '@/lib/queries';
import { IconSubtitles } from '@/components/ui/Icons';

/**
 * État de la VF d'un replay : prête, en cours de traduction (pastille qui
 * pulse), ou en partie traduite (part du match). Rien si la traduction n'a
 * pas commencé.
 */
export default function VfBadge({ vf, size = 'md' }: { vf: VfState; size?: 'sm' | 'md' }) {
  if (vf.state === 'none') return null;
  const pad = size === 'sm' ? 'px-2 py-[3px] text-[10px]' : 'px-2.5 py-1 text-[11px]';
  const base = `inline-flex items-center gap-1 whitespace-nowrap rounded-full font-bold uppercase tracking-wider ${pad}`;
  if (vf.state === 'ready') {
    return (
      <span className={`${base} border border-flame/40 text-flame-hot`} title="Commentaires traduits en français : prêts">
        <IconSubtitles size={12} />
        VF
      </span>
    );
  }
  if (vf.state === 'running') {
    return (
      <span className={`${base} border border-flame/30 bg-flame/10 text-flame-hot`} title="Traduction des commentaires en cours">
        <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-flame opacity-70" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-flame" />
        </span>
        VF en cours{vf.pct > 0 ? ` · ${vf.pct} %` : ''}
      </span>
    );
  }
  return (
    <span className={`${base} border border-ink-600 text-paper-dim`} title={`Commentaires traduits sur ${vf.pct} % du match ; la suite se traduit à l’ouverture du match ou la nuit`}>
      <IconSubtitles size={12} />
      VF {vf.pct} %
    </span>
  );
}
