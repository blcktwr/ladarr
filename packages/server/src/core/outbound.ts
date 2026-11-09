import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// One request that the server sent. The id ties the line of the request to the log of the work that sent it.
export type OutboundRequest = { requestId: string; system: string };

type Work = { requests: OutboundRequest[]; ids: Map<string, string> };

// The requests of one piece of work: a job, a call of the API, or a poll. The work and its logs share the context.
const storage = new AsyncLocalStorage<Work>();

const newRequestId = () => `req-${randomUUID().replaceAll('-', '').slice(0, 12)}`;

// Runs one piece of work and keeps the requests that it sends, so every line of its log links to them.
export function withOutboundRequests<T>(run: () => T): T {
  return storage.run({ requests: [], ids: new Map() }, run);
}

// The requests of the work that runs now. Empty outside a work.
export function outboundRequests(): OutboundRequest[] {
  return storage.getStore()?.requests ?? [];
}

// One id for each system of the work: every request to that system in the work shares it. A reader opens all of them
// from the same line of the log.
export function requestIdFor(system: string): string {
  const work = storage.getStore();
  if (!work) return newRequestId();
  const known = work.ids.get(system);
  if (known) return known;
  const id = newRequestId();
  work.ids.set(system, id);
  work.requests.push({ requestId: id, system });
  return id;
}

// Adds a request that the caller named itself, so the log of the work also links to it.
export function recordOutboundRequest(system: string, requestId: string) {
  const list = storage.getStore()?.requests;
  if (list && !list.some((item) => item.requestId === requestId)) list.push({ requestId, system });
}
