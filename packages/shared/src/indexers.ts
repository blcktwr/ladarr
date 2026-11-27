export const DEFAULT_RELEASE_DAY_MINUTES = 60;

export const validReleaseDayMinutes = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1440;
