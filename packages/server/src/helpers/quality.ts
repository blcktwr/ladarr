import { isQualityId, type Profile } from '../library/grab/quality.ts';

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const isLimit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000;

// Returns the profile that the body describes, or the name of the first field that is not valid.
export function parseProfile(body: unknown): Omit<Profile, 'id'> | { invalid: string } {
  if (!isObject(body)) return { invalid: 'body' };
  const { name, items } = body;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) return { invalid: 'name' };
  const seen = new Set<string>();
  if (!Array.isArray(items) || items.length < 1 || !items.every((group) => Array.isArray(group) && group.length >= 1 && group.every((id) => isQualityId(id) && !seen.has(id) && seen.add(id)))) return { invalid: 'items' };
  return { name: name.trim(), items: items as string[][] };
}
