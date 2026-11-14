import type { Metadata } from 'next';
import { Suspense } from 'react';
import DevicePage from '@/components/pages/DevicePage';

export const metadata: Metadata = { title: 'Connecter une TV', robots: { index: false } };

export default function Page() {
  // `useSearchParams` (code passé dans l'URL) : exigé par l'export statique.
  return (
    <Suspense>
      <DevicePage />
    </Suspense>
  );
}
