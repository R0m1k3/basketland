import type { Metadata } from 'next';
import SettingsPage from '@/components/pages/SettingsPage';

export const metadata: Metadata = { title: 'Paramètres' };

export default function Page() {
  return <SettingsPage />;
}
