import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          exclude: [...configDefaults.exclude, 'packages/nebula/**'],
        },
      },
      {
        extends: './packages/nebula/vite.config.js',
        test: {
          name: 'nebula',
          root: './packages/nebula',
        },
      },
    ],
  },
});
