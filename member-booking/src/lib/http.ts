import { BookingError, type RefusalCode } from './errors.ts';
import { env } from './env.ts';

/**
 * Request and response helpers shared by every function. Keeping CORS, cookie
 * and error shaping here means a new endpoint cannot accidentally invent its
 * own error format or leak an internal message to a member.
 */

export const MEMBER_COOKIE = 'alchemy_member';
export const STAFF_COOKIE = 'alchemy_staff';

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin') ?? '';
  const allowed = env.allowedOrigins;
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Credentials': 'true',
  };
  if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

export function json(request: Request, body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(request),
      ...extraHeaders,
    },
  });
}

export function errorResponse(request: Request, error: unknown): Response {
  if (error instanceof BookingError) {
    return json(
      request,
      { ok: false, code: error.code, message: error.userMessage, detail: error.detail },
      error.status,
    );
  }
  // Never surface an internal message. The detail goes to the function log.
  console.error('[member-booking] unhandled error', error);
  return json(request, { ok: false, code: 'INTERNAL', message: 'Something went wrong at our end. Please try again.' }, 500);
}

export function preflight(request: Request): Response | null {
  if (request.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export function requireMethod(request: Request, ...methods: string[]): void {
  if (!methods.includes(request.method)) {
    throw new BookingError('INVALID_REQUEST', { allowed: methods }, 'That request was not valid.');
  }
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new BookingError('INVALID_REQUEST');
  }
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (env.isProduction) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-nf-client-connection-ip') ?? request.headers.get('x-forwarded-for');
  if (!forwarded) return null;
  const first = forwarded.split(',')[0]?.trim();
  return first && first.length > 0 ? first : null;
}

export function refuse(code: RefusalCode, detail?: unknown): never {
  throw new BookingError(code, detail);
}

/** Trims, lowercases and sanity-checks an email without pretending to validate RFC 5322. */
export function normaliseEmail(value: unknown): string {
  if (typeof value !== 'string') refuse('INVALID_REQUEST');
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    refuse('INVALID_REQUEST', { field: 'email' });
  }
  return email;
}

export function requireString(value: unknown, field: string, maxLength = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    refuse('INVALID_REQUEST', { field });
  }
  return value.trim();
}
