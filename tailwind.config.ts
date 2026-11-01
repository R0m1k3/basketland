import type { Config } from 'tailwindcss';

/**
 * Design « Night Court » : fond encre, texte papier chaud, un seul accent
 * (flamme). Les couleurs d'équipe (src/lib/teams.ts) apportent le reste,
 * passées en variables CSS (--team, --team-a, --team-b) au niveau des cartes.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#0B0B0E',
          900: '#111116',
          850: '#16161C',
          800: '#1C1C24',
          700: '#26262F',
          600: '#34343F',
          500: '#4A4955',
        },
        paper: {
          DEFAULT: '#F2EFE9',
          dim: '#C9C6BF',
          mute: '#9A98A3',
          faint: '#6B6975',
        },
        flame: {
          DEFAULT: '#FF5A1F',
          hot: '#FF7A45',
          deep: '#D9430E',
        },
        live: '#FF3B4E',
        win: '#3DDC97',
        loss: '#FF6B6B',
        warn: '#FFC24B',
        // NBA Cup : or pâle du trophée (fond et repères des matchs de la Cup).
        cup: {
          DEFAULT: '#D9B864',
          hot: '#F0D48A',
          deep: '#8A6A22',
        },
        // Diffuseurs en France.
        bein: '#7B3FE4',
        prime: '#1A98FF',
      },
      fontFamily: {
        display: ['var(--font-display)', 'Impact', 'sans-serif'],
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        xl2: '1.25rem',
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(255,90,31,.35), 0 10px 40px -10px rgba(255,90,31,.45)',
        card: '0 1px 0 rgba(255,255,255,.04) inset, 0 20px 40px -24px rgba(0,0,0,.8)',
      },
      keyframes: {
        'pulse-live': { '0%,100%': { opacity: '1' }, '50%': { opacity: '.35' } },
        'fade-up': { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: {
        'pulse-live': 'pulse-live 1.6s ease-in-out infinite',
        'fade-up': 'fade-up .35s ease-out both',
      },
    },
  },
  plugins: [],
};

export default config;
