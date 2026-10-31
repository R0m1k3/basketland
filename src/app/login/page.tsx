import type { Metadata } from 'next';
import { Suspense } from 'react';
import LoginPage from '@/components/pages/LoginPage';

export const metadata: Metadata = { title: 'Connexion', robots: { index: false } };

export default function Page() {
  // `useSearchParams` (destination `next`) : exigé par l'export statique.
  return (
    <Suspense>
      <LoginPage />
    </Suspense>
  );
}
