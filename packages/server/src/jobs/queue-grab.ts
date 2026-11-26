import { enqueueSelection, readySelection } from '../library/grab/grab.ts';
import type { GrabberDeps, Handler, ReleaseRef } from '../types.ts';

export function queueGrabHandler({ queue, finder, enqueue }: GrabberDeps): Handler {
  return {
    run: async (job) => {
      const { entryIds } = job.payload as { entryIds: string[] };
      const items = new Set(entryIds.flatMap((id) => {
        const entry = queue.get(id);
        const item = entry && queue.itemFor(entry);
        return item ? [item] : [];
      }));
      for (const item of items) {
        if (readySelection(item)) {
          enqueueSelection(item, enqueue);
          continue;
        }
        if (item.state.kind !== 'fetching') continue;
        const releases = new Map<string, ReleaseRef>();
        for (const id of item.entryIds) {
          const entry = queue.get(id);
          const ref = entry?.release;
          if (entry?.state.kind === 'fetching' && ref && !ref.uploadPath) releases.set(`${ref.indexerId}:${ref.guid}`, ref);
        }
        const refs = [...releases.values()];
        finder.enqueueSearch({
          titleKey: item.titleKey,
          season: item.season,
          entryIds: item.entryIds,
          manual: refs.some((ref) => ref.manual),
          forced: refs.some((ref) => ref.manual),
          supplied: refs.map((ref) => ({ ...ref, publishedAt: null, peers: null, categories: [] })),
        });
      }
    },
  };
}
