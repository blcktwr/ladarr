import { afterEach, describe, expect, it } from 'vitest';
import { movie } from '../helpers/test-fixtures.ts';
import { MIB, hashOf, startPipeline, until } from '../helpers/test-pipeline.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let api: Awaited<ReturnType<Awaited<ReturnType<typeof startPipeline>>['api']>> | undefined;
afterEach(async () => {
  api?.close();
  await pipe?.stop();
  pipe = api = undefined;
});

const NAME = 'Movie.Name.2019.1080p.BluRay-GROUP';

describe('the files of the torrent of a target', () => {
  it('lists every file that the .torrent of the release holds', async () => {
    pipe = await startPipeline();
    api = await pipe.api({ indexers: pipe.indexers });
    const m = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[m.key] = m;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * MIB, files: ['Movie.Name.mkv', 'Movie.Name.es.srt'], comment: 'A comment from the writer' }];
    const [entry] = pipe.finder.requestSearch(m.key);
    await until(() => entry!.stage === 'downloading');

    const answer = await api.get(`/queue/entries/${entry!.id}/torrent`);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      name: NAME,
      hash: hashOf(NAME, ['Movie.Name.mkv', 'Movie.Name.es.srt']),
      files: [
        { path: `${NAME}/Movie.Name.mkv`, sizeBytes: 1000 },
        { path: `${NAME}/Movie.Name.es.srt`, sizeBytes: 1000 },
      ],
      totalBytes: 2000,
      comment: 'A comment from the writer',
      source: null,
      createdBy: null,
      createdAt: null,
      pieceLength: 16384,
      pieceCount: 1,
      private: false,
    });
  });

  it('answers not found for a target that has no release', async () => {
    pipe = await startPipeline();
    api = await pipe.api({ indexers: pipe.indexers });
    const m = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[m.key] = m;
    pipe.tracker.state.items = [];
    const [entry] = pipe.finder.requestSearch(m.key);
    await until(() => entry!.branch === 'waiting' && entry!.reason?.code === 'no_results');

    const answer = await api.get(`/queue/entries/${entry!.id}/torrent`);
    expect(answer.status).toBe(404);
    expect(answer.body).toEqual({ error: 'not_found' });
  });
});
