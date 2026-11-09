import type { WebhookEventType } from '@ladarr/shared/enums';
import type { WebhookState } from '../core/webhook.ts';

// The statuses of the queue that start a webhook. The test is not one of them: it saves nothing.
export const WEBHOOK_EVENT_TYPES = ['stuck', 'available'] as const satisfies readonly WebhookEventType[];

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// The address must be http or https, and it must have no user name or password. Returns it, or nothing.
export function parseUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2_000) return;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    return url.href;
  } catch {}
}

// The user sees the host of the destination. The rest of the address can hold a token.
export const view = (webhook: WebhookState) => ({ id: webhook.id, type: webhook.type, host: new URL(webhook.url).host });

// The type and the address are both required. Returns them, or the field that is wrong.
export function parse(body: unknown) {
  if (!isObject(body)) return { field: 'type' as const };
  const type = body.type;
  if (typeof type !== 'string' || !WEBHOOK_EVENT_TYPES.includes(type as WebhookEventType)) return { field: 'type' as const };
  const url = parseUrl(body.url);
  if (!url) return { field: 'url' as const };
  return { type: type as WebhookEventType, url };
}
