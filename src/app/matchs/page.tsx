import type { Metadata } from 'next';
import { Suspense } from 'react';
import CalendarPage from '@/components/pages/CalendarPage';

export const metadata: Metadata = { title: 'Calendrier' };

export default function Page() {
  // `useSearchParams` (jour, équipe) : exigé par l'export statique.
  return (
    <Suspense>
      <CalendarPage />
    </Suspense>
  );
}
