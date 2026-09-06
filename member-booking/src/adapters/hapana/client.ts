import { env } from '../../lib/env.ts';

/**
 * Thin HTTP client for Hapana.
 *
 * Credentials come from server-side environment variables only. Nothing in this
 * module, or anything that imports it, is ever shipped to a browser: the pages
 * in web/ talk to our own /api endpoints and never to Hapana directly.
 *
 * Authentication is two request headers, accessID and siteID, confirmed from
 * Hapana's own documentation on 2026-09-06. It used to be five candidate
 * styles behind HAPANA_AUTH_STYLE, guessed because the docs were unreachable
 * from the build environment. All five were wrong. There is one scheme, so
 * there is nothing left to configure.
 *
 * siteID is a header, not a query parameter, and the key is bound to the site
 * it was registered against. See docs/hapana-findings.md.
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

function applyAuth(headers: Record<string, string>): void {
  headers.accessID = env.hapanaApiKey;
  // Documented as "siteID registered with Auth Key & accessID": the key and
  // the site are bound at registration, so this is not optional in practice.
  // Sent only when configured, so a deployment that has not been told its site
  // yet gets Hapana's own 401 rather than a header reading "undefined".
  if (env.hapanaSiteId) headers.siteID = env.hapanaSiteId;
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
  applyAuth(headers);

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
