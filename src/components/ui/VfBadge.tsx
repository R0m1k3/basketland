import type { VfState } from '@/lib/queries';
import { IconSubtitles } from '@/components/ui/Icons';

/**
 * État de la VF d'un replay : prête, en cours de traduction (pastille
 * orange), ou en partie traduite (part du match). Rien si la traduction n'a
 * pas commencé.
 */
export default function VfBadge({ vf, size = 'md' }: { vf: VfState; size?: 'sm' | 'md' }) {
  if (vf.state === 'none') return null;
  const pad = size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs';
  const base = `inline-flex items-center gap-1 whitespace-nowrap rounded-full font-semibold ${pad}`;
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
        <span className="h-1.5 w-1.5 rounded-full bg-flame" aria-hidden="true" />
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
