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
});
