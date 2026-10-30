import { LogoMark } from '@/components/ui/Logo';

/** Mise en page des écrans hors session (connexion, premier démarrage) : carte centrée. */
export default function AuthShell({
  kicker,
  title,
  intro,
  children,
}: {
  kicker: string;
  title: string;
  intro?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[calc(100dvh-14rem)] items-center justify-center py-6">
      <section className="panel relative w-full max-w-md overflow-hidden" aria-labelledby="auth-title">
        <div className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-flame-deep via-flame to-flame-hot" />
        <div className="upcoming-glow pointer-events-none absolute inset-x-0 top-0 h-40" aria-hidden="true" />
        <div className="relative space-y-6 px-5 py-7 sm:px-8 sm:py-9">
          <header className="space-y-3">
            <LogoMark size={40} />
            <div className="space-y-1.5">
              <p className="kicker">{kicker}</p>
              <h1 id="auth-title" className="title-lg">
                {title}
              </h1>
            </div>
            {intro && <p className="text-sm leading-relaxed text-paper-dim">{intro}</p>}
          </header>
          {children}
        </div>
      </section>
    </div>
  );
}
