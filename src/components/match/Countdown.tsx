'use client';

import { useEffect, useState } from 'react';

/**
 * Compte à rebours jusqu'au coup d'envoi (heure de Paris affichée par la
 * page) + ajout à l'agenda (.ics généré localement, sans dépendance).
 */
export default function Countdown({
  dateUtc,
  title,
  location,
}: {
  dateUtc: string;
  title: string;
  location: string;
}) {
  const target = Date.parse(dateUtc);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const left = now === null ? null : Math.max(0, target - now);
  const parts =
    left === null
      ? null
      : {
          j: Math.floor(left / 86_400_000),
          h: Math.floor((left % 86_400_000) / 3_600_000),
          m: Math.floor((left % 3_600_000) / 60_000),
          s: Math.floor((left % 60_000) / 1000),
        };

  const addToCalendar = () => {
    const d = new Date(target);
    const end = new Date(target + 150 * 60_000);
    const stamp = (x: Date) => x.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const esc = (s: string) => s.replace(/[\\,;]/g, (c) => `\\${c}`);
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//BasketLand//FR',
      'BEGIN:VEVENT',
      `UID:${stamp(d)}-${title.replace(/\W+/g, '')}@basketland`,
      `DTSTAMP:${stamp(new Date())}`,
      `DTSTART:${stamp(d)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:${esc(title)}`,
      location ? `LOCATION:${esc(location)}` : '',
      `URL:${window.location.href}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ]
      .filter(Boolean)
      .join('\r\n');
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'match-basketland.ics';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="flex items-start gap-2 sm:gap-4" role="timer" aria-live="off" aria-label="Temps restant avant le coup d'envoi">
        {(['j', 'h', 'm', 's'] as const).map((k, i) => (
          <div key={k} className="flex items-start gap-2 sm:gap-4">
            {i > 0 && <span className="num pt-2 text-3xl text-ink-500 sm:text-5xl">:</span>}
            <div className="flex flex-col items-center">
              <span className="countdown-cell num text-4xl font-bold text-paper sm:text-6xl">
                {parts ? String(parts[k]).padStart(2, '0') : '––'}
              </span>
              <span className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-paper-faint">
                {{ j: 'jours', h: 'heures', m: 'min', s: 's' }[k]}
              </span>
            </div>
          </div>
        ))}
      </div>
      {left === 0 && <p className="chip-live">Coup d’envoi imminent</p>}
      <button type="button" onClick={addToCalendar} className="btn">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 3v4M16 3v4M12 13v5M9.5 15.5h5" />
        </svg>
        Ajouter à mon agenda
      </button>
    </div>
  );
}
