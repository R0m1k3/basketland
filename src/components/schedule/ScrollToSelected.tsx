'use client';

import { useEffect, useRef } from 'react';

/**
 * Rangée défilante qui centre son élément `[data-selected]` au montage
 * (sans faire défiler la page verticalement).
 */
export default function ScrollToSelected({ children, className = '', watch }: { children: React.ReactNode; className?: string; watch?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = ref.current;
    const el = box?.querySelector<HTMLElement>('[data-selected]');
    if (!box || !el) return;
    box.scrollLeft = el.offsetLeft - box.clientWidth / 2 + el.clientWidth / 2;
  }, [watch]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
