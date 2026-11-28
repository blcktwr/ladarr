import { describe, expect, it } from 'vitest';
import { emptyData, withDefaults } from '../../src/core/db.ts';
import type { QueueEntry } from '../../src/types.ts';

describe('the defaults of an older file', () => {
  it('gives UTC to a file without a time zone', () => {
    const data = emptyData();
    delete (data.settings as unknown as Record<string, unknown>).timeZone;
    expect(withDefaults(data).settings).toMatchObject({ timeZone: 'UTC' });
  });

  it('keeps the saved time zone of a file', () => {
    const data = emptyData();
    Object.assign(data.settings, { timeZone: 'Asia/Tokyo' });
    expect(withDefaults(data).settings).toMatchObject({ timeZone: 'Asia/Tokyo' });
  });

  it('drops the blocklist that an older file had', () => {
    const data = emptyData() as ReturnType<typeof emptyData> & { blocklist?: unknown };
    data.blocklist = { '1:Show.Name.S01.1080p.WEB-DL-GRP': { title: 'Show.Name.S01.1080p.WEB-DL-GRP', reason: 'invalid_torrent', at: 1 } };
    const next = withDefaults(data);
    expect('blocklist' in next).toBe(false);
  });

  it('keeps one copy of a torrent that an older file had in every target of its pack', () => {
    const data = emptyData();
    const hash = 'a'.repeat(40);
    const torrent = Buffer.from('the torrent').toString('base64');
    for (const id of ['tv:1:1x1', 'tv:1:1x2']) {
      data.queue[id] = {
        id,
        titleKey: 'tv:1',
        season: 1,
        number: Number(id.at(-1)),
        state: { kind: 'waiting_slot' },
        revision: 1,
        createdAt: 1,
        stateSince: 1,
        phaseSince: 1,
        completedAt: null,
        clearedAt: null,
        priority: null,
        attempt: 1,
        attempts: [],
        history: [],
        search: null,
        release: null,
        transferHash: hash,
        clientId: 'client-1',
        source: { torrent },
        importResult: null,
      } as unknown as QueueEntry;
    }
    const next = withDefaults(data);
    expect(next.torrents).toEqual({ [hash]: torrent });
    expect(next.queue['tv:1:1x1']!.source).toEqual({ torrent: true });
    expect(next.queue['tv:1:1x2']!.source).toEqual({ torrent: true });
  });

  it('drops the torrent that no target waits for', () => {
    const data = emptyData();
    data.torrents = { ['b'.repeat(40)]: Buffer.from('nobody waits').toString('base64') };
    expect(withDefaults(data).torrents).toEqual({});
  });
});
