import Link from 'next/link';
import type { DayCount } from '@/lib/queries';
import { shiftKey } from '@/lib/dayKeys';
import { IconChevronLeft, IconChevronRight } from '@/components/ui/Icons';
import ScrollToSelected from './ScrollToSelected';
import { dayNumber, monthShort, monthYear, weekdayShort } from './dates';

const SPAN = 7;

/**
 * Bande de dates façon calendrier sportif : 15 jours centrés sur le jour
 * choisi, nombre de matchs par jour, aujourd'hui repéré, sauts de ±7 jours.
 */
export default function DayStrip({
  selected,
  today,
  counts,
  hrefFor,
}: {
  selected: string;
  today: string;
  counts: Map<string, DayCount>;
  hrefFor: (key: string) => string;
}) {
  const days = Array.from({ length: SPAN * 2 + 1 }, (_, i) => shiftKey(selected, i - SPAN));
  const first = days[0];
  const last = days[days.length - 1];
  const oneMonth = monthYear(first) === monthYear(last);
  const range = oneMonth ? monthYear(selected) : `${monthYear(first).split(' ')[0]} – ${monthYear(last)}`;
  const rangeShort = oneMonth
    ? monthYear(selected)
    : `${monthShort(first).replace('.', '')} – ${monthShort(last).replace('.', '')} ${last.slice(0, 4)}`;

  return (
    <nav aria-label="Choisir un jour" className="panel overflow-hidden">
      <div className="flex items-center gap-2 border-b border-ink-700/70 px-2 py-2 sm:px-3">
        <Link href={hrefFor(shiftKey(selected, -SPAN))} className="btn-ghost px-2" aria-label="Reculer d'une semaine">
          <IconChevronLeft />
          <span className="hidden sm:inline">7 jours</span>
        </Link>
        <span className="min-w-0 flex-1 truncate text-center font-display text-[15px] font-semibold uppercase tracking-[0.16em] text-paper-dim">
          <span className="hidden sm:inline">{range}</span>
          <span className="sm:hidden">{rangeShort}</span>
        </span>
        {selected !== today && (
          <Link href={hrefFor(today)} className="btn px-3 py-1 text-xs">
            Aujourd&apos;hui
          </Link>
        )}
        <Link href={hrefFor(shiftKey(selected, SPAN))} className="btn-ghost px-2" aria-label="Avancer d'une semaine">
          <span className="hidden sm:inline">7 jours</span>
          <IconChevronRight />
        </Link>
      </div>

      <ScrollToSelected watch={selected} className="scroll-row relative overflow-x-auto">
        <ol className="flex min-w-max gap-1 p-2 sm:gap-1.5 lg:min-w-0 lg:justify-between">
          {days.map((k) => {
            const c = counts.get(k);
            const n = c?.total ?? 0;
            const isSel = k === selected;
            const isToday = k === today;
            const past = k < today;
            return (
              <li key={k} className="lg:flex-1">
                <Link
                  href={hrefFor(k)}
                  data-selected={isSel ? '' : undefined}
                  aria-current={isSel ? 'date' : undefined}
                  aria-label={`${weekdayShort(k)} ${dayNumber(k)} ${monthShort(k)}, ${n ? `${n} match${n > 1 ? 's' : ''}` : 'aucun match'}${isToday ? ", aujourd'hui" : ''}`}
                  className={`relative flex w-[58px] flex-col items-center rounded-xl px-1 pb-2 pt-2.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame lg:w-full ${
                    isSel
                      ? 'bg-paper text-ink-950 shadow-[0_8px_24px_-12px_rgba(242,239,233,.6)]'
                      : n
                        ? 'text-paper hover:bg-ink-800'
                        : 'text-paper-faint hover:bg-ink-800/60'
                  }`}
                >
                  {isToday && (
                    <span
                      className={`absolute left-1/2 top-1 h-1 w-1 -translate-x-1/2 rounded-full ${isSel ? 'bg-flame-deep' : 'bg-flame'}`}
                      aria-hidden="true"
                    />
                  )}
                  <span
                    className={`text-[11px] font-semibold uppercase tracking-wider ${
                      isSel ? 'text-ink-700' : isToday ? 'text-flame-hot' : 'text-paper-mute'
                    }`}
                  >
                    {isToday ? 'Auj.' : weekdayShort(k).replace('.', '')}
                  </span>
                  <span className={`num text-[26px] font-bold leading-tight ${!isSel && past && n ? 'text-paper-dim' : ''}`}>
                    {dayNumber(k)}
                  </span>
                  <span
                    className={`mt-0.5 flex h-4 items-center gap-1 whitespace-nowrap text-[10px] font-medium ${
                      isSel ? 'text-ink-700' : 'text-paper-mute'
                    }`}
                  >
                    {c?.live ? <span className="h-1.5 w-1.5 animate-pulse-live rounded-full bg-live" aria-hidden="true" /> : null}
                    {n ? `${n} match${n > 1 ? 's' : ''}` : '—'}
                  </span>
                  {dayNumber(k) === 1 && !isSel && (
                    <span className="absolute -top-0.5 right-1 text-[9px] font-bold uppercase text-flame-hot">{monthShort(k)}</span>
                  )}
                </Link>
              </li>
            );
          })}
        </ol>
      </ScrollToSelected>
    </nav>
  );
}
