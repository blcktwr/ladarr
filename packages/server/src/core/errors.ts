import type { ErrorRequestHandler } from 'express';
import { SourceError } from '../migration/migration-source.ts';
import { TmdbError } from '../metadata/tmdb.ts';
import { log } from './log.ts';

const SOURCE_STATUS = {
  source_url_invalid: 400,
  source_unreachable: 502,
  source_key_rejected: 502,
  source_wrong_app: 400,
  source_version_unsupported: 400,
  source_invalid_response: 502,
  backup_invalid: 400,
  backup_unsupported: 400,
  backup_unsafe: 400,
  backup_too_large: 413,
  backup_no_database: 400,
  backup_database_invalid: 400,
} as const;

const PROVIDER_ERRORS = {
  not_found: { status: 404, error: 'not_found' },
  invalid_key: { status: 502, error: 'metadata_key_rejected' },
  rate_limited: { status: 503, error: 'metadata_unavailable' },
  unavailable: { status: 503, error: 'metadata_unavailable' },
} as const;

export const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof SourceError) return void res.status(SOURCE_STATUS[err.code]).json({ error: err.code, detail: err.detail });
  if (err instanceof TmdbError) return void res.status(PROVIDER_ERRORS[err.code].status).json({ error: PROVIDER_ERRORS[err.code].error });
  const status = typeof err.status === 'number' && err.status < 500 ? err.status : 500;
  if (status === 500) log.error('unhandled error', { error: err });
  res.status(status).json({ error: status === 500 ? 'internal_error' : 'bad_request' });
};
