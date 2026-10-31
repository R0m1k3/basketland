import type { Metadata } from 'next';
import TeamsPage from '@/components/pages/TeamsPage';

export const metadata: Metadata = { title: 'Équipes' };

export default function Page() {
  return <TeamsPage />;
}
