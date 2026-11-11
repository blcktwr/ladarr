import { writeFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { configure, SERIES_PACK, startStack, URL_BASE, type Stack } from './stack.ts';
import { hashOf } from '../packages/server/tests/helpers/test-pipeline.ts';

// One server for all checks. The series is in the library, and its pack is at 40%. The last test completes the pack.
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

let stack: Stack;
let cookie: { name: string; value: string };
test.beforeAll(async () => {
  stack = await startStack();
});
test.afterAll(() => stack.stop());
test.afterEach(async ({}, info) => {
  if (info.status === info.expectedStatus) return;
  writeFileSync(info.outputPath('server.log'), stack.logs());
  await info.attach('server-log', { path: info.outputPath('server.log') });
});

// --- Pages -------------------------------------------------------------------------------------

type Opener = (page: Page) => Promise<void>;

const open = (path: string, ready: (page: Page) => Promise<unknown>): Opener => async (page) => {
  await page.goto(`${URL_BASE}${path}`);
  await ready(page);
};

const seriesPage = open('/catalog/tv/1', (page) => expect(page.getByRole('heading', { name: 'Show Name (2020)' })).toBeVisible());
// The name of a result link starts with the name of its add button.
const resultLink = (page: Page) => page.getByRole('link', { name: /Movie Name 2019 Movies$/ });
const searchPage = open('/search?q=Movie', (page) => expect(resultLink(page)).toBeVisible());
const activityPage = open('/activity', (page) => expect(page.getByRole('table', { name: 'Queue' })).toBeVisible());
// A category of Settings. Each one has its own page for the checks.
const settingsTab = (tab: string, ready: (page: Page) => Promise<unknown>): Opener => async (page) => {
  await page.goto(`${URL_BASE}/settings`);
  await page.getByRole('tab', { name: tab }).click();
  await ready(page);
};
// The row of the series in the master list of the queue.
const groupRow = (page: Page) => page.locator('[data-row="group:tv:1:1"]');

// Pages that need a signed-in owner. The name tells what the user sees.
const PAGES: [string, Opener][] = [
  ['catalog', open('/catalog', (page) => expect(page.getByRole('link', { name: 'Show Name 2020 Series', exact: true })).toBeVisible())],
  [
    'series',
    async (page) => {
      await seriesPage(page);
      // Every season starts closed. The button on the container opens the table of episodes.
      const season = page.getByRole('region', { name: 'Season 1' });
      await expect(season).toBeVisible();
      await expect(page.getByRole('button', { name: 'Show episodes of Season 1' })).toBeVisible();
    },
  ],
  ['search results', searchPage],
  [
    'title not in the catalog',
    async (page) => {
      await searchPage(page);
      await resultLink(page).getByText('Movie Name', { exact: true }).click();
      await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeVisible();
    },
  ],
  [
    'activity queue',
    // The first title is selected, so the inspector shows next to the list on a wide page.
    activityPage,
  ],
  [
    'activity season',
    async (page) => {
      await activityPage(page);
      // The list is alone below 800 px, so the button of the row opens the inspector of the series first.
      await page.getByRole('button', { name: 'Inspect Show Name (2020) Season 1' }).click();
      await page.getByRole('button', { name: 'Show episodes of Season 1' }).click();
      await expect(page.getByRole('table', { name: 'Episodes of season 1' })).toBeVisible();
    },
  ],
  [
    'activity blocklist',
    async (page) => {
      await activityPage(page);
      // The first row of the queue is the series, so the page selects its detail by default.
      await expect(page.getByRole('region', { name: 'Blocklist' })).toBeVisible();
    },
  ],
  ['calendar', open('/calendar', (page) => expect(page.getByText('Nothing is scheduled.')).toBeVisible())],
  ['settings', open('/settings', (page) => expect(page.getByRole('button', { name: 'Rotate key' })).toBeEnabled())],
  [
    'settings media',
    settingsTab('Media', async (page) => {
      await expect(page.getByRole('region', { name: 'Folders' })).toBeVisible();
      await expect(page.getByLabel('Movies folder')).toBeVisible();
      await expect(page.getByLabel('Series folder')).toBeVisible();
    }),
  ],
  ['settings quality', settingsTab('Quality', (page) => expect(page.getByRole('region', { name: 'Qualities' })).toBeVisible())],
  [
    'settings quality profile editor',
    settingsTab('Quality', async (page) => {
      await page.getByRole('button', { name: 'Add profile' }).click();
      await expect(page.getByRole('dialog', { name: 'Add a profile' })).toBeVisible();
    }),
  ],
  [
    'settings connections',
    settingsTab('Connections', async (page) => {
      await expect(page.getByRole('table', { name: 'Indexers' }).getByRole('button', { name: /^Actions for/ })).toBeVisible();
      await expect(page.getByRole('table', { name: 'Download clients' }).getByRole('button', { name: /^Actions for/ })).toBeVisible();
    }),
  ],
  [
    'settings connections indexer form',
    settingsTab('Connections', async (page) => {
      await page.getByRole('button', { name: 'Add indexer' }).click();
      await expect(page.getByRole('dialog', { name: 'Add an indexer' })).toBeVisible();
    }),
  ],
  [
    'settings connections webhook form',
    settingsTab('Connections', async (page) => {
      await page.getByRole('button', { name: 'Add webhook' }).click();
      await expect(page.getByRole('dialog', { name: 'Add a webhook' })).toBeVisible();
    }),
  ],
  [
    'settings connections indexer edit',
    settingsTab('Connections', async (page) => {
      await page.getByRole('table', { name: 'Indexers' }).getByRole('button', { name: /^Actions for/ }).click();
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      await expect(page.getByRole('dialog', { name: 'Edit an indexer' })).toBeVisible();
    }),
  ],
  [
    'settings connections client form',
    settingsTab('Connections', async (page) => {
      await page.getByRole('button', { name: 'Add client' }).click();
      await expect(page.getByRole('dialog', { name: 'Add a download client' })).toBeVisible();
    }),
  ],
  [
    'settings connections client edit',
    settingsTab('Connections', async (page) => {
      await page.getByRole('table', { name: 'Download clients' }).getByRole('button', { name: /^Actions for/ }).click();
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      await expect(page.getByRole('dialog', { name: 'Edit a download client' })).toBeVisible();
    }),
  ],
  ['settings system', settingsTab('System', (page) => expect(page.getByRole('button', { name: 'Back up now' })).toBeVisible())],
  ['settings help', settingsTab('Help', (page) => expect(page.getByRole('region', { name: 'Items' })).toBeVisible())],
];

// --- Axe ---------------------------------------------------------------------------------------

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// Open findings of the design system and of the app. Each one is a rule and a part of the HTML of the element.
// A finding that is not here fails the test. Delete an entry when its finding is fixed.
const KNOWN: [rule: string, html: string, why: string][] = [
];

// A dialog fades in. A check must not read a color in the middle of the fade.
// Animations that never end (a spinner) and animations that follow the scroll position are not awaited.
const settle = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.timeline === document.timeline && a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  );

// The dynamic IDs of the design system are not stable, so a message shows the start of the element and not its selector.
async function expectClean(page: Page, name: string) {
  await settle(page);
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  const found = violations.flatMap((v) => v.nodes.map((n) => ({ rule: v.id, html: n.html, text: `${v.id} (${v.impact}): ${n.html.replace(/ (id|aria-controls|aria-labelledby|for)="[^"]*"/g, '').slice(0, 110)} => ${n.any[0]?.message ?? n.failureSummary ?? ''}` })));
  const known = (f: (typeof found)[number]) => KNOWN.find(([rule, html]) => f.rule === rule && f.html.includes(html));
  for (const rule of new Set(found.flatMap((f) => known(f)?.[0] ?? []))) {
    test.info().annotations.push({ type: 'known finding', description: `${name}: ${rule}. ${KNOWN.find(([r]) => r === rule)![2]}` });
  }
  expect(found.filter((f) => !known(f)).map((f) => f.text), `axe violations of ${name}`).toEqual([]);
}

// --- Overflow ----------------------------------------------------------------------------------

// Elements that reach past the right edge of the window and do not sit in a container that scrolls on its own.
const overflowing = (page: Page) =>
  page.evaluate(() => {
    const scrolls = (node: Element | null) => {
      for (; node && node !== document.body; node = node.parentElement) if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(node).overflowX)) return true;
      return false;
    };
    return [...document.body.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(el).position !== 'fixed' && !scrolls(el.parentElement))
      .map((el) => `${el.tagName.toLowerCase()}${el.getAttribute('data-slot') ? `[${el.getAttribute('data-slot')}]` : ''} "${(el.textContent ?? '').trim().slice(0, 30)}" right=${Math.round(el.getBoundingClientRect().right)}`)
      .slice(0, 6);
  });

// The viewport must already be 320 px wide.
async function expectNoOverflow(page: Page, name: string) {
  await settle(page);
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scroll, `scroll width of ${name}. Elements past the edge: ${JSON.stringify(await overflowing(page))}`).toBeLessThanOrEqual(320);
}

// --- Keyboard ----------------------------------------------------------------------------------

// Every stop of the Tab key on the page, and whether the look of the page changes at the stop.
// A ring is a change of outline, shadow, border, or background on the element, on the groups around it, or on its cells,
// between the moment of the focus and the moment after the focus moved on.
async function tabStops(page: Page, max = 120) {
  await page.addStyleTag({ content: 'html{scroll-behavior:auto!important}' });
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    (window as any).__look = (el: Element) =>
      [el, el.parentElement, el.parentElement?.parentElement, ...el.querySelectorAll('td, th')]
        .filter(Boolean)
        .map((node) =>
          [undefined, '::before', '::after']
            .map((pseudo) => {
              const style = getComputedStyle(node!, pseudo);
              return [style.outlineStyle, style.outlineWidth, style.outlineColor, style.boxShadow, style.borderTopColor, style.backgroundColor].join('|');
            })
            .join('/'),
        )
        .join(';');
  });
  const stops: { name: string; ring: boolean; inView: boolean; tabIndex: number }[] = [];
  const seen = new Set<string>();
  let focusedLook = '';
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    await settle(page);
    // The element of the last stop has lost the focus now.
    if (stops.length) stops[stops.length - 1]!.ring = (await page.evaluate(() => (window as any).__look((window as any).__previous))) !== focusedLook;
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      (window as any).__previous = el;
      const box = el.getBoundingClientRect();
      const path = [...(function* (node: Element | null) { while (node) { yield `${node.tagName}${[...(node.parentElement?.children ?? [])].indexOf(node)}`; node = node.parentElement; } })(el)].join('/');
      return { path, look: (window as any).__look(el), name: el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 40), inView: box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight, tabIndex: el.tabIndex };
    });
    // The focus left the page, or it came back to the first stop.
    if (!stop || seen.has(stop.path)) break;
    seen.add(stop.path);
    focusedLook = stop.look;
    stops.push({ name: stop.name, ring: false, inView: stop.inView, tabIndex: stop.tabIndex });
  }
  return stops;
}

// --- Motion ------------------------------------------------------------------------------------

// Records the animations and transitions that run on the clock. Animations that follow the scroll position are not motion.
function recordMotion() {
  const seen = new Set<string>();
  (window as any).__motion = seen;
  const loop = () => {
    for (const a of document.getAnimations()) {
      if (a.timeline !== document.timeline) continue;
      const timing = a.effect?.getComputedTiming();
      seen.add(`${(a as CSSTransition).transitionProperty ?? (a as CSSAnimation).animationName ?? 'script'} ${timing?.duration}ms x${timing?.iterations}`);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// A walk through the parts of the app that move: tabs, the inspector of the queue, a menu, a dialog, and an alert dialog.
async function walk(page: Page) {
  await open('/catalog', (p) => expect(p.getByRole('link', { name: 'Show Name 2020 Series', exact: true })).toBeVisible())(page);
  await page.locator('a[href$="/activity"]').click();
  // A season opens and closes in the inspector, and the menu of the series opens the log of the title.
  await page.getByRole('button', { name: 'Show episodes of Season 1' }).click();
  await expect(page.getByRole('table', { name: 'Episodes of season 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Hide episodes of Season 1' }).click();
  await page.getByRole('button', { name: 'Actions for Show Name (2020)' }).click();
  await page.getByRole('menuitem', { name: 'Logs' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Rotate key' }).click();
  const rotate = page.getByRole('alertdialog', { name: 'Rotate the API key?' });
  await expect(rotate).toBeVisible();
  await rotate.getByRole('button', { name: 'Cancel' }).click();
  await expect(rotate).toBeHidden();
}

// --- Tests: controls ---------------------------------------------------------------------------
// The checks must fail when the page is wrong, so each one runs once on a page that is wrong.

test('control: axe finds a missing alternative text', async ({ page }) => {
  await page.setContent('<main><img></main>');
  await expect(expectClean(page, 'control')).rejects.toThrow(/image-alt/);
});

test('control: the focus check finds a control without a ring', async ({ page }) => {
  await page.setContent('<style>button{outline:none}</style><button>a</button><button>b</button><button>c</button><button>d</button>');
  const stops = await tabStops(page);
  expect(stops.map((s) => s.ring)).toEqual([false, false, false, false]);
  await page.setContent('<button>a</button><button>b</button>');
  expect((await tabStops(page)).map((s) => s.ring)).toEqual([true, true]);
});

// --- Tests: first pages ------------------------------------------------------------------------

test('owner account page', async ({ page }) => {
  await page.goto(URL_BASE);
  await expect(page.getByRole('heading', { name: "Let's start" })).toBeVisible();
  await expectClean(page, 'owner account');
  await page.setViewportSize({ width: 320, height: 640 });
  await expectNoOverflow(page, 'owner account');
});

test('setup page, then the seed for the other pages', async ({ page }) => {
  cookie = await stack.createOwner();
  await page.context().addCookies([{ ...cookie, url: URL_BASE }]);
  await page.goto(URL_BASE);
  await expect(page.getByRole('heading', { name: 'Where is the media?' })).toBeVisible();
  await expectClean(page, 'setup');
  await page.setViewportSize({ width: 320, height: 640 });
  await expectNoOverflow(page, 'setup');

  // The setup, the series, and the first report of its pack.
  await configure(stack);
  await stack.call('POST', '/library', { mediaType: 'tv', tmdbId: 1, add: 'all' });
  await expect.poll(() => stack.qbit.torrents.size, { timeout: 60_000 }).toBe(1);
  stack.qbit.progress(hashOf(SERIES_PACK), 0.4);
  await expect.poll(async () => (await stack.call('GET', '/queue/summary')).body.activeTransfers, { timeout: 70_000, intervals: [500] }).toBe(1);
});

test('sign in page', async ({ page }) => {
  await page.goto(URL_BASE);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expectClean(page, 'sign in');
  await page.setViewportSize({ width: 320, height: 640 });
  await expectNoOverflow(page, 'sign in');
});

// --- Tests: signed in --------------------------------------------------------------------------

test.describe('signed in', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ ...cookie, url: URL_BASE }]);
  });

  for (const [name, openPage] of PAGES) {
    test(`axe finds no new violation: ${name}`, async ({ page }) => {
      await openPage(page);
      await expectClean(page, name);
    });
  }

  for (const [name, openPage] of PAGES) {
    test(`no horizontal overflow at 320 px: ${name}`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await openPage(page);
      await expectNoOverflow(page, name);
    });
  }

  for (const [name, openPage] of PAGES.filter(([name]) => ['catalog', 'series', 'search results', 'activity queue', 'settings'].includes(name))) {
    test(`Tab reaches every control with a visible focus ring: ${name}`, async ({ page }) => {
      await openPage(page);
      const stops = await tabStops(page);
      expect(stops.length, 'stops of the Tab key').toBeGreaterThan(3);
      expect(stops.filter((s) => !s.ring).map((s) => s.name), 'stops without a focus ring').toEqual([]);
      expect(stops.filter((s) => !s.inView).map((s) => s.name), 'stops outside the view').toEqual([]);
      expect(stops.filter((s) => s.tabIndex > 0).map((s) => s.name), 'stops with a positive tabindex').toEqual([]);
    });
  }

  test('the section links open their page with the keyboard', async ({ page }) => {
    await open('/catalog', (p) => expect(p.getByRole('link', { name: 'Catalog', exact: true })).toBeVisible())(page);
    await page.getByRole('link', { name: 'Catalog', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Calendar', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/calendar$/);
  });

  test('reduced motion: no animation and no transition runs', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(recordMotion);
    await walk(page);
    expect(await page.evaluate(() => [...(window as any).__motion])).toEqual([]);
  });

  test('control: the same walk records motion when the user does not ask for less', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.addInitScript(recordMotion);
    await walk(page);
    expect((await page.evaluate(() => [...(window as any).__motion])).length).toBeGreaterThan(0);
  });

  test('focus and the announcements stay calm while the pack completes', async ({ page }) => {
    await activityPage(page);
    const actions = page.getByRole('button', { name: 'Actions for Show Name (2020)' });
    await actions.focus();
    await page.evaluate(() => {
      const region = document.querySelector('[data-slow-note]')!;
      (window as any).__focused = document.activeElement;
      (window as any).__announced = [region.textContent];
      new MutationObserver(() => (window as any).__announced.push(region.textContent)).observe(region, { childList: true, characterData: true, subtree: true });
    });

    stack.complete(SERIES_PACK, { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E02.mkv': 'two', 'Show.Name.S01E03.mkv': 'three' });
    // The row leaves the list when its targets are available, and the button that had the focus leaves with it. The
    // page does not read the removed target again: only the count of the rows changes, as one short summary.
    await expect(groupRow(page)).toHaveCount(0, { timeout: 75_000 });
    expect(await page.evaluate(() => (window as any).__focused.isConnected)).toBe(false);
    await expect(page.locator('[data-slow-note]')).toHaveText(/^\d+ rows? in this view$/);
    const announced: string[] = await page.evaluate(() => (window as any).__announced);
    expect(announced.every((text) => /^(\d+ rows? in this view)?$/.test(text)), announced.join(' | ')).toBe(true);
  });
});
