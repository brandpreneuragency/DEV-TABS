import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { environment: 'node', include: ['opencode-plugin/**/*.test.js'] } });
