import { describe, expect, it } from 'vitest';
import { emptyData, withDefaults } from '../../src/core/db.ts';

describe('the defaults of an older file', () => {
  it('drops a pack that an old rule blocked for a season that it holds in part', () => {
    const data = emptyData();
    data.blocklist = {
      '1:Show.Name.S01.1080p.WEB-DL-GRP': { title: 'Show.Name.S01.1080p.WEB-DL-GRP', reason: 'pack_missing_episodes', at: 1, titleKey: 'tv:1', season: 1 },
      '1:Show.Name.S01E01.CAM-GRP': { title: 'Show.Name.S01E01.CAM-GRP', reason: 'quality_rejected', at: 2, titleKey: 'tv:1', season: 1 },
    };
    const next = withDefaults(data);
    expect(next.blocklist).toEqual({ '1:Show.Name.S01E01.CAM-GRP': expect.objectContaining({ reason: 'quality_rejected' }) });
  });
});
