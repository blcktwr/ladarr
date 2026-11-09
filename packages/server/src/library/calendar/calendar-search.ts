export const BULK_SEARCH_JOB = 'library.search';

// A plan of the kind `upgrades` comes from the Upgrade button of a title page. It searches the files below a resolution
// for a release of exactly that resolution. Other plans look for the missing files.
export type BulkSearchPayload = { planId: string; keys: string[]; offset: number; kind?: 'search' | 'upgrades'; resolution?: number };
