import { test as base, expect } from '@playwright/test';

// Every browser test blocks requests to any host except the local server, and fails if the page tried one.
// This keeps the tests away from TMDB, image hosts, and every other service.
export const test = base.extend<{ guard: void }>({
  guard: [
    async ({ context }, use) => {
      const blocked: string[] = [];
      await context.route(
        (url) => url.hostname !== '127.0.0.1',
        (route) => {
          blocked.push(route.request().url());
          return route.abort();
        },
      );
      await use();
      expect(blocked, 'requests to hosts outside the test stack').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
