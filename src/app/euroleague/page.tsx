import type { Metadata } from 'next';
import EuroleaguePage from '@/components/pages/EuroleaguePage';

export const metadata: Metadata = { title: 'Euroleague' };

export default function Page() {
  return <EuroleaguePage />;
}
