import type { Metadata } from 'next';
import SetupPage from '@/components/pages/SetupPage';

export const metadata: Metadata = { title: 'Premier démarrage', robots: { index: false } };

export default function Page() {
  return <SetupPage />;
}
