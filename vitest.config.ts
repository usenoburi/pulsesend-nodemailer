import { defineConfig } from 'vitest/config';

// Config locale : sans elle, Vitest remonterait jusqu'au vite.config.ts de l'app.
export default defineConfig({
    test: { include: ['tests/**/*.test.ts'] },
});
