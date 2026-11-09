// The Docker health check. The exit code is 0 when the server answers and the worker runs.
export async function checkHealth(port: number, urlBase: string, timeoutMs = 5_000): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${urlBase}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const urlBase = (process.env.LADARR_URL_BASE ?? '').replace(/\/+$/, '');
  process.exit((await checkHealth(Number(process.env.PORT ?? 3000), urlBase)) ? 0 : 1);
}
