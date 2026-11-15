import { describe, expect, it } from 'vitest';
import { emptyData, withDefaults } from '../../src/core/db.ts';

describe('the defaults of an older file', () => {
  it('drops the blocklist that an older file had', () => {
    const data = emptyData() as ReturnType<typeof emptyData> & { blocklist?: unknown };
    data.blocklist = { '1:Show.Name.S01.1080p.WEB-DL-GRP': { title: 'Show.Name.S01.1080p.WEB-DL-GRP', reason: 'invalid_torrent', at: 1 } };
    const next = withDefaults(data);
    expect('blocklist' in next).toBe(false);
  });
});
