import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { ApiErrorBody, DeliveryRequest } from '../shared/types.js';
import { fieldErrors } from '../shared/validation.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: { fields?: Record<string, string>; request?: DeliveryRequest } = {},
  ) {
    super(message);
  }
}

export const notFound = (message = 'We couldn’t find that.') => new HttpError(404, 'not_found', message);

/** Parses a request body with a schema, turning failures into a 400 with per-field messages. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const fields = fieldErrors(result.error);
    const first = Object.values(fields)[0] ?? 'Please check what you entered.';
    throw new HttpError(400, 'validation_failed', first, { fields });
  }
  return result.data;
}

export function parseId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound();
  return id;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof HttpError) {
    const body: ApiErrorBody = { error: { code: err.code, message: err.message, fields: err.extra.fields } };
    if (err.extra.request) body.request = err.extra.request;
    res.status(err.status).json(body);
    return;
  }
  // Malformed JSON from express.json().
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'bad_json', message: 'The request was not valid JSON.' } } satisfies ApiErrorBody);
    return;
  }
  if ((err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'too_large', message: 'That was too much data.' } } satisfies ApiErrorBody);
    return;
  }
  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong on our side. Please try again.' } } satisfies ApiErrorBody);
}
