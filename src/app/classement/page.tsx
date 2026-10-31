import type { Metadata } from 'next';
import StandingsPage from '@/components/pages/StandingsPage';

export const metadata: Metadata = { title: 'Classement' };

export default function Page() {
  return <StandingsPage />;
}
