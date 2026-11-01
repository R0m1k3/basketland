import type { Metadata } from 'next';
import CupPage from '@/components/pages/CupPage';

export const metadata: Metadata = { title: 'NBA Cup' };

export default function Page() {
  return <CupPage />;
}
