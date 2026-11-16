import { describe, expect, it, vi } from 'vitest';
import { posterState } from './format.ts';

vi.mock('./api.ts', () => ({ ApiError: class extends Error {} }));
vi.mock('../i18n/index.ts', () => ({ t: (text: string) => text }));

describe('poster state', () => {
  it.each(['not_found', 'no_match'])('shows %s as waiting instead of searching or available', (queueStatus) => {
    expect(posterState({ queueStatus, availability: 'available' })?.state).toBe('waiting');
  });

  it('keeps a blocked title stuck even when it has an available file', () => {
    expect(posterState({ queueStatus: 'stuck', availability: 'available' })?.state).toBe('stuck');
  });

  it.each(['fetching', 'sending', 'paused', 'cancelled'])('does not replace %s with availability', (queueStatus) => {
    expect(posterState({ queueStatus, availability: 'available' })).toBeNull();
  });

  it('shows the tick only when a file of the series is in the library', () => {
    // A series with nothing downloaded has no tick, also when its availability is available.
    expect(posterState({ availability: 'available', counts: { total: 3, eligible: 0, available: 0, upcoming: 3 } })).toBeNull();
    expect(posterState({ availability: 'available', counts: { total: 3, eligible: 1, available: 1, upcoming: 2 } })?.state).toBe('available');
    // A movie has no counts, and its available state means that its file is in the library.
    expect(posterState({ availability: 'available', counts: null })?.state).toBe('available');
  });
});
