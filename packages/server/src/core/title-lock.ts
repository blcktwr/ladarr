// One piece of work at a time for each title. The scan, the search, and the verification read the disk and the client,
// and they must not take the same target while another one holds it. The lock is in memory: a restart releases it.
const locks = new Map<string, Promise<void>>();

export async function withTitleLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => current);
  locks.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    // The last holder removes its entry, so a title that leaves the library leaves no lock behind.
    if (locks.get(key) === tail) locks.delete(key);
  }
}

export const titleLocked = (key: string) => locks.has(key);
