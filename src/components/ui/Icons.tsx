/** Icônes linéaires minimalistes (SVG inline, héritent de la couleur du texte). */
type P = { className?: string; size?: number };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export function IconPlay({ className, size = 16 }: P) {
  return (
    <svg {...base(size)} className={className} fill="currentColor" stroke="none">
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" />
    </svg>
  );
}
export function IconChevronLeft({ className, size = 18 }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}
export function IconChevronRight({ className, size = 18 }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}
export function IconArrowRight({ className, size = 16 }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
export function IconEye({ className, size = 16 }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
export function IconEyeOff({ className, size = 16 }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-2.9 3.8M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20" />
    </svg>
  );
}
export function IconCalendar({ className, size = 16 }: P) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="3" y="4.5" width="18" height="16" rx="2.5" />
      <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
    </svg>
  );
}
export function IconClose({ className, size = 16 }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
export function IconSubtitles({ className, size = 14 }: P) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M7 12.5h3M13 12.5h4M7 15.5h6M15.5 15.5H17" />
    </svg>
  );
}
export function IconChart({ className, size = 14 }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  );
}
