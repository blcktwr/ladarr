import { describe, expect, it } from 'vitest';
import { normalizeTitle, parseRelease } from '../../src/library/grab/release.ts';

describe('parseRelease', () => {
  it.each([
    ['Show.Name.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRP', { title: 'Show Name', season: 1, episodes: [2], pack: false, resolution: 1080, source: 'webdl', group: 'GRP' }],
    ['The.Show.S02E05E06.720p.HDTV.x264-ABC', { title: 'The Show', season: 2, episodes: [5, 6], source: 'hdtv', resolution: 720 }],
    ['Show S01E01-E03 2160p WEBRip', { title: 'Show', season: 1, episodes: [1, 2, 3], resolution: 2160, source: 'webrip' }],
    ['Show.Name.1x07.1080p.BluRay-X', { title: 'Show Name', season: 1, episodes: [7], source: 'bluray' }],
    ['Show.Name.S03.1080p.WEB-DL-GRP', { title: 'Show Name', season: 3, episodes: [], pack: true, multiSeason: false }],
    ['Show Name Season 2 1080p BluRay', { title: 'Show Name', season: 2, pack: true, source: 'bluray' }],
    ['Show.Name.S01-S03.COMPLETE.1080p.BluRay-GRP', { title: 'Show Name', multiSeason: true, pack: false }],
    ['Show.Name.2024.03.15.1080p.WEB-DL-GRP', { title: 'Show Name', airDate: '2024-03-15', year: null, season: null, episodes: [] }],
    ['Movie.Name.2019.1080p.BluRay.x264-GRP', { title: 'Movie Name', year: 2019, season: null, resolution: 1080, source: 'bluray' }],
    ['1917.2019.2160p.WEB-DL.DDP5.1-GRP', { title: '1917', year: 2019, resolution: 2160 }],
    ['2001.A.Space.Odyssey.1968.1080p.BluRay-GRP', { title: '2001 A Space Odyssey', year: 1968 }],
    ['Movie Name (2020) 1080p WEB-DL', { title: 'Movie Name', year: 2020, source: 'webdl' }],
    ['Movie.Name.2021.HDCAM.x264-GRP', { title: 'Movie Name', year: 2021, source: 'cam', resolution: null }],
    ['Movie.Name.2021.1080p.HDTS-GRP', { source: 'telesync' }],
    ['Movie.Name.2021.4K.UHD.BluRay-GRP', { resolution: 2160, source: 'bluray' }],
    ['[SubGroup] Anime Name - 05 [1080p]', { group: 'SubGroup', title: 'Anime Name - 05', resolution: 1080 }],
    ['Movie.Name.2018', { title: 'Movie Name', year: 2018, source: 'unknown', resolution: null }],
    // A word of the title that looks like a source marker stays in the title.
    ['Madame.Web.2024.1080p.AMZN.WEB-DL.DDP5.1.Atmos.H.264-LatTeam.mkv SPANiSH', { title: 'Madame Web', year: 2024, resolution: 1080, source: 'webdl' }],
    ['Madame.Web.2024.1080p.BluRay.BDRip.DTSHD-MA.5.1.h264.mkv SPANiSH', { title: 'Madame Web', year: 2024, resolution: 1080, source: 'bluray' }],
    ['Cam.2024.1080p.WEB-DL-GRP', { title: 'Cam', year: 2024, resolution: 1080, source: 'webdl' }],
  ])('%s', (name, expected) => {
    expect(parseRelease(name)).toMatchObject(expected);
  });

  it('reads audio languages only after the title', () => {
    expect(parseRelease('Movie.Name.2019.GERMAN.1080p.BluRay-GRP').audioLanguages).toEqual(['de']);
    expect(parseRelease('Movie.Name.2019.MULTi.1080p.BluRay-GRP').audioLanguages).toEqual(['multi']);
    expect(parseRelease('The.Italian.Job.1969.1080p.BluRay-GRP')).toMatchObject({ title: 'The Italian Job', audioLanguages: null });
    expect(parseRelease('Show.S01E01.1080p.WEB-DL-GRP').audioLanguages).toBeNull();
  });

  it('does not take a resolution number for an episode or a year', () => {
    expect(parseRelease('Show.Name.S01E02.1080p.WEB-DL')).toMatchObject({ year: null, episodes: [2] });
    expect(parseRelease('Show.Name.2019.S01E02.1080p.WEB-DL')).toMatchObject({ title: 'Show Name', year: 2019, episodes: [2] });
  });
});

describe('normalizeTitle', () => {
  it('matches spellings of one title', () => {
    expect(normalizeTitle("The Marvelous Mrs. Maisel")).toBe(normalizeTitle('Marvelous Mrs Maisel'));
    expect(normalizeTitle('Amélie')).toBe('amelie');
    expect(normalizeTitle('Law & Order')).toBe(normalizeTitle('Law and Order'));
    expect(normalizeTitle("Grey's Anatomy")).toBe('greys anatomy');
  });
});
