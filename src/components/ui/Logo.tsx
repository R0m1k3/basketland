/** Marque BasketLand : ballon stylisé + logotype condensé. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="28" fill="#FF5A1F" />
      <g fill="none" stroke="#0B0B0E" strokeWidth="4" strokeLinecap="round">
        <path d="M32 4v56" />
        <path d="M4 32h56" />
        <path d="M13 13c8 6.5 12 12.5 12 19s-4 12.5-12 19" />
        <path d="M51 13c-8 6.5-12 12.5-12 19s4 12.5 12 19" />
      </g>
    </svg>
  );
}

export default function Logo() {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark />
      <span className="font-display text-[22px] font-extrabold uppercase leading-none tracking-tight">
        Basket<span className="text-flame">Land</span>
      </span>
    </span>
  );
}
