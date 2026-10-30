import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Les tâches de fond ne tournent que la nuit (2 h-6 h) en production ;
    // en test, la fenêtre est toujours ouverte (les tests dédiés la règlent).
    env: { COMMENTARY_NIGHT_WINDOW: 'always' },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});
