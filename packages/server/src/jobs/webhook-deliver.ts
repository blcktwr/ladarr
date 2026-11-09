import type { Db } from '../core/db.ts';
import { JobError } from '../core/jobs.ts';
import { log } from '../core/log.ts';
import { DELIVER, MAX_ATTEMPTS, send, type WebhookEvent } from '../integrations/webhook.ts';
import type { Handler } from '../core/worker.ts';

// A receiver that is busy or down can recover. Another status means that the address or the receiver is wrong.
const retryable = (status: number) => status >= 500 || status === 408 || status === 425 || status === 429;

export function webhookDeliverHandler({ db, timeoutMs }: { db: Db; timeoutMs?: number }): Record<string, Handler> {
  return {
    [DELIVER]: {
      concurrency: 2,
      // A receiver that is down must not take a slot that an import needs.
      separate: true,
      maxAttempts: MAX_ATTEMPTS,
      async run(job, { signal }) {
        const url = db.data.webhook.url;
        // The user removed the destination, so the event has no receiver.
        if (!url) return;
        const event = job.payload as WebhookEvent;
        const result = await send(url, event, { signal, timeoutMs });
        if (result.ok) return;
        if (signal.aborted) throw new Error('stopped');
        const permanent = result.status !== null && !retryable(result.status);
        const message = result.status === null ? 'The receiver did not answer.' : `The receiver answered with status ${result.status}.`;
        log.warn('webhook delivery failed', { eventId: event.id, eventType: event.type, attempt: job.attempts, message, final: permanent || job.attempts >= MAX_ATTEMPTS });
        throw new JobError(permanent ? 'invalid_input' : 'outage', message);
      },
    },
  };
}
