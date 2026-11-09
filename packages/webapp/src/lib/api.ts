export class ApiError extends Error {
  status: number;
  // The JSON body of the answer, for the details that go with the code.
  body: Record<string, unknown>;
  constructor(status: number, code: string, body: Record<string, unknown> = {}) {
    super(code);
    this.status = status;
    this.body = body;
  }
}

let csrfToken = '';
export const setCsrfToken = (token: string) => {
  csrfToken = token;
};

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`api${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'request_failed', data);
  return data as T;
}

// Sends a file as the raw body. The server reads the backup ZIP of Sonarr or Radarr this way.
// onProgress reports the part that the browser sent, from 0 to 1.
export function upload<T = unknown>(path: string, file: Blob, onProgress?: (part: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `api${path}`);
    request.setRequestHeader('content-type', 'application/zip');
    if (csrfToken) request.setRequestHeader('x-csrf-token', csrfToken);
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    });
    request.addEventListener('load', () => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(request.responseText) as Record<string, unknown>;
      } catch {
        // An empty body is a body that the server did not write.
      }
      if (request.status >= 200 && request.status < 300) resolve(data as T);
      else reject(new ApiError(request.status, typeof data.error === 'string' ? data.error : 'request_failed', data));
    });
    request.addEventListener('error', () => reject(new ApiError(0, 'request_failed')));
    request.send(file);
  });
}
