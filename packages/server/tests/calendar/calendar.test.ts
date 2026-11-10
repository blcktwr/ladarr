import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { libraryFilter } from '../../src/library/tools/filters.ts';
import { buildIcal } from '../../src/library/calendar/calendar-feed.ts';
import { addDays, calendarEvents, dayOf, isDay, MAX_EVENTS } from '../../src/library/calendar/calendar.ts';
import { open, type Db } from '../../src/core/db.ts';
import type { Title } from '../../src/library/library.ts';
import { startTestApp } from '../helpers/test-app.ts';
import { episode, movie, title } from '../helpers/test-fixtures.ts';
import type { ReleaseDate } from '../../src/metadata/tmdb.ts';

const NOW = Date.UTC(2024, 5, 15, 12);
const all = { from: '2024-01-01', to: '2024-12-31', monitored: true };

const film = (key: string, releaseDates: ReleaseDate[], extra: Partial<Title> = {}) => {
  const base = movie();
  const id = Number(key.split(':')[1]);
  return movie({ key, tmdbId: id, meta: { ...base.meta, tmdbId: id, title: `Film ${id}`, releaseDates }, ...extra });
};
const digital = (date: string, region = 'US'): ReleaseDate => ({ region, kind: 'digital', date });
const show = (key: string, extra: Partial<Title> = {}) => {
  const base = title();
  const id = Number(key.split(':')[1]);
  return title({ key, tmdbId: id, meta: { ...base.meta, tmdbId: id, title: `Show ${id}` }, ...extra });
};

async function dbWith(...titles: Title[]) {
  const db = await open('unused.json');
  for (const item of titles) db.data.titles[item.key] = item;
  return db;
}

describe('dates', () => {
  it('checks days', () => {
    expect(isDay('2024-02-29')).toBe(true);
    expect(isDay('2023-02-29')).toBe(false);
    expect(isDay('2024-1-1')).toBe(false);
    expect(isDay('2024-13-01')).toBe(false);
    expect(isDay('2024-00-10')).toBe(false);
    expect(isDay(undefined)).toBe(false);
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01');
  });

  it('shows the day of an instant in the time zone', () => {
    const at = Date.UTC(2024, 5, 1, 22);
    expect(dayOf(at, 'Asia/Tokyo')).toBe('2024-06-02');
    expect(dayOf(at, 'America/Los_Angeles')).toBe('2024-06-01');
  });
});

describe('calendar events', () => {
  it('puts episodes on their air date and keeps unknown dates outside', async () => {
    const db = await dbWith(show('tv:1', { episodes: [episode(1, 1, '2024-06-10'), episode(1, 2, '2024-06-17'), episode(1, 3, null), episode(1, 4, null), episode(1, 5, '2025-06-01')] }));
    const { events, undated } = calendarEvents({ from: '2024-06-01', to: '2024-06-30', monitored: true }, NOW);
    expect(events.map((e) => [e.id, e.day, e.at, e.episodeName])).toEqual([
      ['tv:1:1x1', '2024-06-10', null, 'Episode 1'],
      ['tv:1:1x2', '2024-06-17', null, 'Episode 2'],
    ]);
    expect(undated).toEqual([{ titleKey: 'tv:1', mediaType: 'tv', title: 'Show 1', year: 2020, count: 2 }]);
  });

  it('includes both ends of the range and nothing outside it', async () => {
    const db = await dbWith(show('tv:1', { episodes: [episode(1, 1, '2024-05-31'), episode(1, 2, '2024-06-01'), episode(1, 3, '2024-06-30'), episode(1, 4, '2024-07-01')] }));
    const days = calendarEvents({ from: '2024-06-01', to: '2024-06-30', monitored: true }, NOW).events.map((e) => e.day);
    expect(days).toEqual(['2024-06-01', '2024-06-30']);
  });

  it('follows monitoring, and shows a paused title with a flag', async () => {
    const db = await dbWith(
      show('tv:1', { policy: 'future', futureFrom: Date.UTC(2024, 5, 12), episodes: [episode(1, 1, '2024-06-10'), episode(1, 2, '2024-06-20'), episode(1, 3, '2024-06-21', { override: 'unmonitored' }), episode(0, 1, '2024-06-22')] }),
      show('tv:2', { paused: true, episodes: [episode(1, 1, '2024-06-11')] }),
      film('movie:3', [digital('2024-06-12T00:00:00.000Z')], { paused: true }),
    );
    const range = { from: '2024-06-01', to: '2024-06-30' };
    expect(calendarEvents({ ...range, monitored: true }, NOW).events.map((e) => [e.id, e.paused])).toEqual([
      ['tv:2:1x1', true],
      ['movie:3', true],
      ['tv:1:1x2', false],
    ]);
    expect(calendarEvents({ ...range, monitored: false }, NOW).events.map((e) => [e.id, e.monitored])).toEqual([
      ['tv:1:1x1', false],
      ['tv:2:1x1', true],
      ['movie:3', true],
      ['tv:1:1x2', true],
      ['tv:1:1x3', false],
      ['tv:1:0x1', false],
    ]);
  });

  it('filters by media type', async () => {
    const db = await dbWith(show('tv:1', { episodes: [episode(1, 1, '2024-06-10')] }), film('movie:2', [digital('2024-06-10T00:00:00.000Z')]));
    const ids = (type?: 'movie' | 'tv') => calendarEvents({ ...all, type }, NOW).events.map((e) => e.id);
    expect(ids('movie')).toEqual(['movie:2']);
    expect(ids('tv')).toEqual(['tv:1:1x1']);
    expect(ids()).toEqual(['movie:2', 'tv:1:1x1']);
  });

  it('uses the digital or physical date of the region, and leaves other movies without a position', async () => {
    const db = await dbWith(
      film('movie:1', [digital('2024-06-10T00:00:00.000Z'), { region: 'US', kind: 'physical', date: '2024-06-05T00:00:00.000Z' }, { region: 'US', kind: 'theatrical', date: '2024-01-01T00:00:00.000Z' }]),
      film('movie:2', [{ region: 'US', kind: 'theatrical', date: '2024-06-10T00:00:00.000Z' }]),
      film('movie:3', [digital('2024-06-10T00:00:00.000Z', 'FR')]),
      film('movie:4', []),
    );
    const { events, undated } = calendarEvents(all, NOW);
    expect(events.map((e) => [e.id, e.day])).toEqual([['movie:1', '2024-06-05']]);
    expect(undated.map((u) => u.titleKey)).toEqual(['movie:2', 'movie:3', 'movie:4']);
  });

  it('keeps a date without a time on its day in any time zone, and moves a release with a time to the local day', async () => {
    const db = await dbWith(film('movie:1', [digital('2024-06-01T00:00:00.000Z')]), film('movie:2', [digital('2024-06-01T22:00:00.000Z')]));
    for (const [timeZone, expected] of [['UTC', ['2024-06-01', '2024-06-01']], ['Pacific/Auckland', ['2024-06-01', '2024-06-02']], ['America/Los_Angeles', ['2024-06-01', '2024-06-01']]] as const) {
      db.data.settings.timeZone = timeZone;
      const events = calendarEvents(all, NOW).events;
      expect(events.map((e) => e.day)).toEqual(expected);
      expect(events.map((e) => e.at)).toEqual([null, Date.UTC(2024, 5, 1, 22)]);
    }
  });

  it('shows an episode as released at the end of its date in the time zone', async () => {
    const db = await dbWith(show('tv:1', { episodes: [episode(1, 1, '2024-06-15')] }));
    // 2024-06-15 12:00 UTC is the end of the date in Auckland but not in Los Angeles.
    const state = (timeZone: string) => {
      db.data.settings.timeZone = timeZone;
      return calendarEvents(all, NOW).events[0]!.availability;
    };
    expect(state('Pacific/Auckland')).toBe('missing');
    expect(state('America/Los_Angeles')).toBe('waiting');
  });

  it('shows a file as available and a missing file as missing', async () => {
    const db = await dbWith(show('tv:1', { episodes: [episode(1, 1, '2024-01-10', { fileId: 'f1' }), episode(1, 2, '2024-01-17', { fileId: 'gone' }), episode(1, 3, '2024-01-24')] }));
    db.data.files.f1 = { id: 'f1', titleKey: 'tv:1', path: 'a.mkv', sizeBytes: 1, mtimeMs: 1, episodes: [], missing: false, addedAt: 1 };
    db.data.files.gone = { ...db.data.files.f1, id: 'gone', missing: true };
    expect(calendarEvents(all, NOW).events.map((e) => e.availability)).toEqual(['available', 'missing', 'missing']);
  });

  it('agrees with the library filters', async () => {
    const aired = '2024-01-10';
    const db = await dbWith(
      show('tv:1', { episodes: [episode(1, 1, aired), episode(1, 2, '2999-12-01')] }),
      show('tv:2', { episodes: [episode(1, 1, '2999-12-01')] }),
      show('tv:3', { episodes: [episode(1, 1, aired, { fileId: 'f' })] }),
      show('tv:4', { episodes: [episode(1, 1, aired, { override: 'unmonitored' })] }),
      show('tv:5', { episodes: [episode(1, 1, aired)], paused: true }),
      film('movie:6', [digital('2024-01-10T00:00:00.000Z')]),
      film('movie:7', [digital('2999-12-10T00:00:00.000Z')]),
      film('movie:8', [{ region: 'US', kind: 'theatrical', date: '2024-01-10T00:00:00.000Z' }]),
      film('movie:9', [digital('2999-12-10T00:00:00.000Z')], { manualRelease: true }),
      film('movie:10', [digital('2024-01-10T00:00:00.000Z')], { fileId: 'f' }),
    );
    db.data.files.f = { id: 'f', titleKey: 'x', path: 'a.mkv', sizeBytes: 1, mtimeMs: 1, episodes: [], missing: false, addedAt: 1 };
    const now = Date.now();
    const { events } = calendarEvents({ from: '2000-01-01', to: '2999-12-31', monitored: false }, now);
    // The filters use the clock of the server, so the test uses it too.
    const filters = (key: string) => (['missing', 'waiting', 'available'] as const).filter((name) => (libraryFilter(name) as { test: (t: Title) => boolean }).test(db.data.titles[key]!));
    for (const item of Object.values(db.data.titles)) {
      const mine = events.filter((e) => e.titleKey === item.key);
      expect(mine.some((e) => e.availability === 'missing'), `${item.key} missing`).toBe(filters(item.key).includes('missing'));
      if (item.mediaType === 'movie') expect(mine.map((e) => e.availability), item.key).toEqual(mine.length ? filters(item.key) : []);
    }
    // Missing holds no unaired episode and no theatrical-only movie.
    const missing = Object.keys(db.data.titles).filter((key) => filters(key).includes('missing'));
    expect(missing).toEqual(['tv:1', 'tv:5', 'movie:6', 'movie:9']);
  });

  it('cuts the answer at the limit and says so', async () => {
    const episodes = Array.from({ length: MAX_EVENTS + 1 }, (_, n) => episode(1, n + 1, '2024-06-10'));
    const db = await dbWith(show('tv:1', { episodes }));
    const result = calendarEvents(all, NOW);
    expect(result.events).toHaveLength(MAX_EVENTS);
    expect(result.truncated).toBe(true);
    expect(calendarEvents(all, NOW).events[0]!.number).toBe(1);
  });
});

describe('calendar API', () => {
  let app: Awaited<ReturnType<typeof startTestApp>>;
  afterEach(() => app.close());

  it('answers with the month of today in the time zone by default', async () => {
    app = await startTestApp();
    app.db.data.settings.timeZone = 'Asia/Tokyo';
    const today = dayOf(Date.now(), 'Asia/Tokyo');
    app.db.data.titles['tv:1'] = show('tv:1', { episodes: [episode(1, 1, today), episode(1, 2, '1999-01-01')] });
    const { status, body } = await app.get('/calendar');
    expect(status).toBe(200);
    expect(body).toMatchObject({ from: `${today.slice(0, 8)}01`, today, timeZone: 'Asia/Tokyo', truncated: false });
    expect(body.to >= today).toBe(true);
    expect(body.to.slice(0, 7)).toBe(today.slice(0, 7));
    expect(body.events.map((e: { id: string }) => e.id)).toEqual(['tv:1:1x1']);
  });

  it('refuses a range that is not valid or too long', async () => {
    app = await startTestApp();
    for (const query of ['from=2024-06-30&to=2024-06-01', 'from=2024-02-30&to=2024-03-01', 'from=2024-13-01&to=2024-13-02', 'from=2024-06-01', 'from=2024-01-01&to=2024-12-31', 'to=abc']) {
      expect((await app.get(`/calendar?${query}`)).body, query).toEqual({ error: 'invalid_range' });
    }
    expect((await app.get('/calendar?from=2024-01-01&to=2024-04-09')).status).toBe(200);
    expect((await app.get('/calendar?from=2024-01-01&to=2024-04-10')).status).toBe(400);
  });

  it('needs a session', async () => {
    app = await startTestApp();
    expect((await fetch(`${app.base}/calendar`)).status).toBe(401);
  });
});

describe('library filters', () => {
  let app: Awaited<ReturnType<typeof startTestApp>>;
  afterEach(() => app.close());
  const keys = async (query: string) => ((await app.get(`/library?${query}`)).body.items as { key: string }[]).map((item) => item.key);

  async function library() {
    app = await startTestApp();
    for (const item of [
      show('tv:1', { episodes: [episode(1, 1, '2020-01-01')] }),
      show('tv:2', { episodes: [episode(1, 1, '2999-01-01')] }),
      film('movie:3', [{ region: 'US', kind: 'theatrical', date: '2020-01-01T00:00:00.000Z' }]),
      film('movie:4', [digital('2020-01-01T00:00:00.000Z')], { fileId: 'f' }),
      film('movie:5', [digital('2020-01-01T00:00:00.000Z')]),
    ]) {
      app.db.data.titles[item.key] = item;
    }
    app.db.data.files.f = { id: 'f', titleKey: 'movie:4', path: 'a.mkv', sizeBytes: 1, mtimeMs: 1, episodes: [], missing: false, addedAt: 1 };
  }

  it('lists missing, waiting, and available titles', async () => {
    await library();
    expect(await keys('filter=missing')).toEqual(['movie:5', 'tv:1']);
    expect(await keys('filter=waiting')).toEqual(['movie:3', 'tv:2']);
    expect(await keys('filter=available')).toEqual(['movie:4']);
    expect(await keys('')).toHaveLength(5);
    expect((await app.get('/library?filter=missing&limit=1&offset=1')).body).toMatchObject({ total: 2, items: [{ key: 'tv:1' }] });
    expect(await keys('filter=missing&type=movie')).toEqual(['movie:5']);
  });

  it('lists the titles that have a target in Needs attention', async () => {
    await library();
    const entry = (id: string, titleKey: string, extra: object) => {
      app.db.data.queue[id] = { id, titleKey, season: null, number: null, stage: 'queued', branch: null, reason: { code: 'file_not_found' }, attempt: 1, clearedAt: null, ...extra } as never;
    };
    entry('tv:1:1x1', 'tv:1', {});
    entry('movie:4', 'movie:4', { clearedAt: 5 });
    entry('movie:5', 'movie:5', { attempt: 0 });
    entry('movie:3', 'movie:3', { branch: 'waiting' });
    expect(await keys('filter=attention')).toEqual(['tv:1']);
  });

  it('refuses an unknown filter', async () => {
    await library();
    for (const value of ['nope', 'upgrades', 'missing,waiting', '']) expect((await app.get(`/library?filter=${value}`)).body, value).toEqual({ error: 'invalid_filter' });
  });
});

describe('iCal feed', () => {
  let app: Awaited<ReturnType<typeof startTestApp>>;
  afterEach(() => app.close());
  const feed = (token?: string) => fetch(`${app.base}/calendar/feed.ics${token === undefined ? '' : `?token=${token}`}`);

  async function withEvents() {
    app = await startTestApp();
    const today = dayOf(Date.now(), 'UTC');
    app.db.data.titles['tv:1'] = show('tv:1', { episodes: [episode(1, 1, addDays(today, 3), { name: 'A, B; C' }), episode(1, 2, addDays(today, 4), { override: 'unmonitored' }), episode(1, 3, null)] });
    app.db.data.titles['movie:2'] = film('movie:2', [digital(`${addDays(today, 5)}T22:00:00.000Z`)]);
    app.db.data.titles['movie:3'] = film('movie:3', [digital(`${addDays(today, 6)}T00:00:00.000Z`)]);
    return today;
  }

  it('is off until the owner makes a token', async () => {
    await withEvents();
    expect((await app.get('/calendar/feed')).body).toEqual({ token: null });
    expect((await feed()).status).toBe(404);
    expect((await feed('x')).status).toBe(404);
    expect((await feed('')).status).toBe(404);
  });

  it('serves the monitored events to a caller that has the token and no session', async () => {
    const today = await withEvents();
    const { token } = (await app.post('/calendar/feed')).body;
    expect(token).toMatch(/^[\w-]{43}$/);
    expect((await app.get('/calendar/feed')).body).toEqual({ token });

    const res = await feed(token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    const text = await res.text();
    expect(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    // An all-day event for an episode, with the text escaped. The unmonitored episode and the undated one are left out.
    expect(text).toContain('UID:tv:1:1x1@ladarr');
    expect(text).toContain(`DTSTART;VALUE=DATE:${addDays(today, 3).replace(/-/g, '')}\r\nDTEND;VALUE=DATE:${addDays(today, 4).replace(/-/g, '')}`);
    expect(text).toContain('SUMMARY:Show 1 S01E01 - A\\, B\\; C');
    expect(text).not.toContain('tv:1:1x2');
    expect(text).not.toContain('tv:1:1x3');
    // A release with a time is a point in time. A release with no time is an all-day event.
    expect(text).toContain(`DTSTART:${addDays(today, 5).replace(/-/g, '')}T220000Z`);
    expect(text).toContain(`UID:movie:3@ladarr\r\nDTSTAMP:`);
  });

  it('stops serving the old URL after a revoke or a new token', async () => {
    await withEvents();
    const first = (await app.post('/calendar/feed')).body.token;
    const second = (await app.post('/calendar/feed')).body.token;
    expect(second).not.toBe(first);
    expect((await feed(first)).status).toBe(404);
    expect((await feed(second)).status).toBe(200);

    expect((await app.del('/calendar/feed')).body).toEqual({ token: null });
    expect((await feed(second)).status).toBe(404);
    expect((await app.get('/calendar/feed')).body).toEqual({ token: null });
    expect(app.db.data.calendarFeedToken).toBeNull();
  });

  it('does not cut the feed at the limit of the JSON answer', async () => {
    await withEvents();
    const today = dayOf(Date.now(), 'UTC');
    app.db.data.titles['tv:9'] = show('tv:9', { episodes: Array.from({ length: MAX_EVENTS + 1 }, (_, n) => episode(1, n + 1, addDays(today, 2))) });
    const { token } = (await app.post('/calendar/feed')).body;
    const text = await (await feed(token)).text();
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(MAX_EVENTS + 1 + 3);
  });

  it('lets only the owner session manage the token', async () => {
    await withEvents();
    app.db.data.apiKey = 'api-key';
    const asKey = (method: string) => fetch(`${app.base}/calendar/feed`, { method, headers: { 'x-api-key': 'api-key' } });
    for (const method of ['GET', 'POST', 'DELETE']) expect((await asKey(method)).status, method).toBe(401);
    expect((await fetch(`${app.base}/calendar/feed`)).status).toBe(401);
    // A session without the CSRF token cannot change it.
    expect((await fetch(`${app.base}/calendar/feed`, { method: 'POST', headers: { cookie: app.cookie } })).status).toBe(403);
    expect(app.db.data.calendarFeedToken).toBeNull();
  });

  it('works under the URL base', async () => {
    const db: Db = await open('unused.json');
    db.data.calendarFeedToken = 'secret-token';
    const server = createApp({ urlBase: '/ladarr' }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const status = async (path: string) => (await fetch(`${origin}${path}`)).status;
    expect(await status('/ladarr/api/calendar/feed.ics?token=secret-token')).toBe(200);
    expect(await status('/ladarr/api/calendar/feed.ics?token=other')).toBe(404);
    expect(await status('/api/calendar/feed.ics?token=secret-token')).toBe(404);
    server.closeAllConnections();
    server.close();
  });
});

describe('iCal text', () => {
  const base = { id: 'movie:1', titleKey: 'movie:1', mediaType: 'movie' as const, title: 'Film', year: 2020, season: null, number: null, episodeName: null, day: '2024-06-01', at: null, availability: 'missing' as const, monitored: true, paused: false };

  it('folds long lines at 75 octets and never inside a character', () => {
    const text = buildIcal([{ ...base, title: 'Ünïcödé '.repeat(30) }], NOW);
    const lines = text.split('\r\n');
    for (const line of lines) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    const summary = text.replace(/\r\n /g, '').split('\r\n').find((line) => line.startsWith('SUMMARY:'))!;
    expect(summary).toBe(`SUMMARY:${'Ünïcödé '.repeat(30)}`);
  });

  it('gives each event a stable UID and a day range that ends on the next day', () => {
    const text = buildIcal([{ ...base, day: '2024-12-31' }], NOW);
    expect(text).toContain('UID:movie:1@ladarr');
    expect(text).toContain('DTSTART;VALUE=DATE:20241231\r\nDTEND;VALUE=DATE:20250101');
    expect(text).toContain('DTSTAMP:20240615T120000Z');
  });
});
