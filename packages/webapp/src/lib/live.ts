import { useEffect, useRef } from 'react';

import { apiUrl } from './api.ts';

// One connection serves every component, because a browser allows only a few for each site.
const listeners = new Map<string, Set<(data?: unknown) => void>>();
let source: EventSource | undefined;

function connect() {
  source = new EventSource(apiUrl('/events'), { withCredentials: true });
  const resync = () => listeners.forEach((set) => set.forEach((listener) => listener()));
  // The server sends "resync" when the client missed events. Every listener loads its data again.
  source.addEventListener('resync', resync);
  // A page that has seen no event has no event ID, so the server cannot tell what it missed. A reconnect loads the data again.
  let opened = false;
  source.addEventListener('open', () => {
    if (opened) resync();
    opened = true;
  });
}

function subscribe(type: string, listener: (data?: unknown) => void) {
  if (!source) connect();
  let set = listeners.get(type);
  if (!set) {
    set = new Set();
    listeners.set(type, set);
    source!.addEventListener(type, (event) => {
      let data: unknown;
      try {
        data = JSON.parse((event as MessageEvent<string>).data);
      } catch {
        data = undefined;
      }
      listeners.get(type)?.forEach((fn) => fn(data));
    });
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if ([...listeners.values()].every((s) => s.size === 0)) {
      source?.close();
      source = undefined;
      listeners.clear();
    }
  };
}

// Calls onEvent when the server publishes an event of this type. The data is the JSON of the event.
// After a missed event the server sends "resync", and then onEvent gets no data: load the state again.
export function useLive(type: string, onEvent: (data?: unknown) => void) {
  const latest = useRef(onEvent);
  useEffect(() => {
    latest.current = onEvent;
  });
  useEffect(() => subscribe(type, (data) => latest.current(data)), [type]);
}
