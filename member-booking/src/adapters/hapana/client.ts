import { env } from '../../lib/env.ts';

/**
 * Thin HTTP client for Hapana.
 *
 * Credentials come from server-side environment variables only. Nothing in this
 * module, or anything that imports it, is ever shipped to a browser: the pages
 * in web/ talk to our own /api endpoints and never to Hapana directly.
 *
 * The authentication scheme is configurable because it could not be confirmed
 * from the build environment (apidocs.hapana.com is unreachable from CI).
 * HAPANA_AUTH_STYLE selects how the key is presented; run
 * scripts/probe-hapana.mjs to find which one the account accepts.
 */

export class HapanaError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, url: string) {
    super(`Hapana ${status} for ${url}`);
    this.name = 'HapanaError';
    this.status = status;
    this.body = body;
  }
}

export class HapanaUnavailable extends Error {
  constructor(cause: unknown) {
    super(`Hapana unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'HapanaUnavailable';
  }
}

export type AuthStyle = 'x-api-key' | 'bearer' | 'basic' | 'apikey-header' | 'query';

function authStyle(): AuthStyle {
  const style = process.env.HAPANA_AUTH_STYLE ?? 'x-api-key';
  const allowed: AuthStyle[] = ['x-api-key', 'bearer', 'basic', 'apikey-header', 'query'];
  return (allowed as string[]).includes(style) ? (style as AuthStyle) : 'x-api-key';
}

function applyAuth(url: URL, headers: Record<string, string>): void {
  const key = env.hapanaApiKey;
  switch (authStyle()) {
    case 'bearer':
      headers.authorization = `Bearer ${key}`;
      break;
    case 'basic': {
      // Keys of the form "id:secret" are a natural fit for basic auth.
      headers.authorization = `Basic ${Buffer.from(key).toString('base64')}`;
      break;
    }
    case 'apikey-header':
      headers.apikey = key;
      break;
    case 'query':
      url.searchParams.set('apikey', key);
      break;
    case 'x-api-key':
    default:
      headers['x-api-key'] = key;
      break;
  }
  if (env.hapanaSiteId) headers['x-site-id'] = env.hapanaSiteId;
  if (env.hapanaCompanyId) headers['x-company-id'] = env.hapanaCompanyId;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs?: number;
  /** Retries apply to transport failures and 5xx only, never to a 4xx. */
  retries?: number;
}

export async function hapanaRequest<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', query, body, timeoutMs = 8000, retries = method === 'GET' ? 2 : 0 } = options;
  const url = new URL(path.replace(/^\//, ''), env.hapanaBaseUrl.replace(/\/?$/, '/'));
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  applyAuth(url, headers);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        if (response.status >= 500 && attempt < retries) {
          lastError = new HapanaError(response.status, text, url.toString());
          await backoff(attempt);
          continue;
        }
        throw new HapanaError(response.status, text, url.toString());
      }
      return (text ? JSON.parse(text) : {}) as T;
    } catch (error) {
      if (error instanceof HapanaError) throw error;
      lastError = error;
      if (attempt < retries) {
        await backoff(attempt);
        continue;
      }
      throw new HapanaUnavailable(error);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new HapanaUnavailable(lastError);
}

function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
}
