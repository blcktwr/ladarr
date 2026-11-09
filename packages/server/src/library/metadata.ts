export const refreshJob = (key: string) => ({ type: 'metadata.refresh', payload: { key }, dedupeKey: `refresh:${key}` });
