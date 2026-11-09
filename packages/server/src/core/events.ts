import { randomUUID } from 'node:crypto';
import type { RequestHandler, Response } from 'express';

type Entry = { seq: number; type: string; data: unknown };

const HEARTBEAT_MS = 25_000;
const MAX_PENDING_BYTES = 1_000_000;

// Ids are "<boot>:<seq>". After a restart the boot part changes, so a client that reconnects
// with an old id gets a "resync" event and loads the current state again.
export function createEvents(replayLimit = 1_000) {
  const boot = randomUUID().slice(0, 8);
  const recent: Entry[] = [];
  const clients = new Set<Response>();
  let seq = 0;

  const frame = ({ seq, type, data }: Entry) => `id: ${boot}:${seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

  function send(res: Response, text: string) {
    // A client that does not read must not make the server keep an unbounded buffer.
    if (res.writableLength > MAX_PENDING_BYTES) return void res.destroy();
    res.write(text);
  }

  setInterval(() => clients.forEach((res) => send(res, ':\n\n')), HEARTBEAT_MS).unref();

  const handler: RequestHandler = (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();

    const [lastBoot, lastSeq] = (req.get('last-event-id') ?? '').split(':');
    if (lastBoot) {
      const last = Number(lastSeq);
      const oldest = recent[0]?.seq ?? seq + 1;
      // Replay only when the client has seen the start of the window. Otherwise it missed events.
      if (lastBoot !== boot || !Number.isInteger(last) || last + 1 < oldest) {
        send(res, 'event: resync\ndata: {}\n\n');
      } else {
        for (const entry of recent) if (entry.seq > last) send(res, frame(entry));
      }
    }

    clients.add(res);
    res.on('close', () => clients.delete(res));
  };

  return {
    handler,
    publish(type: string, data: unknown = {}) {
      const entry = { seq: ++seq, type, data };
      recent.push(entry);
      if (recent.length > replayLimit) recent.shift();
      const text = frame(entry);
      for (const res of clients) send(res, text);
    },
    get clientCount() {
      return clients.size;
    },
  };
}

export type Events = ReturnType<typeof createEvents>;
