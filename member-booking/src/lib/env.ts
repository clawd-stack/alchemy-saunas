/**
 * Environment access. Every secret is read here and nowhere else, so a grep for
 * process.env outside this file is a review failure. Nothing in this module is
 * ever bundled into a client asset: the web/ pages call the API, they do not
 * import from src/.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const env = {
  /**
   * Postgres connection string. Netlify DB provisions the database and exposes
   * it as NETLIFY_DATABASE_URL; DATABASE_URL wins when set, so local work and
   * CI can point at their own Postgres without touching the deployed one.
   */
  get databaseUrl(): string {
    const url = process.env.DATABASE_URL ?? process.env.NETLIFY_DATABASE_URL;
    if (!url) throw new Error('No database connection string: set DATABASE_URL, or deploy where Netlify DB provides NETLIFY_DATABASE_URL');
    return url;
  },
  get hasDatabaseUrl(): boolean {
    return Boolean(process.env.DATABASE_URL ?? process.env.NETLIFY_DATABASE_URL);
  },
  /** Signing key for member and staff session cookies, and for token hashing. */
  get sessionSecret(): string {
    return required('SESSION_SECRET');
  },
  get hapanaBaseUrl(): string {
    return optional('HAPANA_BASE_URL', 'https://api.hapana.com');
  },
  get hapanaApiKey(): string {
    return required('HAPANA_API_KEY');
  },
  get hapanaSiteId(): string {
    return optional('HAPANA_SITE_ID');
  },
  get hapanaCompanyId(): string {
    return optional('HAPANA_COMPANY_ID');
  },
  /** Hidden member class on the East Fremantle room, Pattern A only. */
  get hapanaMemberClassId(): string {
    return optional('HAPANA_MEMBER_CLASS_ID');
  },
  get emailProvider(): 'postmark' | 'resend' | 'smtp' | 'console' {
    const value = optional('EMAIL_PROVIDER', 'console');
    if (value === 'postmark' || value === 'resend' || value === 'smtp' || value === 'console') return value;
    throw new Error(`Unsupported EMAIL_PROVIDER: ${value}`);
  },
  /**
   * SMTP settings, used when EMAIL_PROVIDER=smtp. This exists so the channel
   * can send through a mailbox the business already owns (Google Workspace,
   * Microsoft 365) rather than requiring a new transactional email vendor.
   */
  get smtp(): { host: string; port: number; user: string; pass: string; secure: boolean } {
    const host = optional('SMTP_HOST', 'smtp.gmail.com');
    const port = Number(optional('SMTP_PORT', '465'));
    return {
      host,
      port,
      user: required('SMTP_USER'),
      pass: required('SMTP_PASS'),
      // 465 is implicit TLS; 587 upgrades with STARTTLS.
      secure: port === 465,
    };
  },
  get emailApiKey(): string {
    return optional('EMAIL_API_KEY');
  },
  get emailFrom(): string {
    return optional('EMAIL_FROM', 'Alchemy Saunas <bookings@alchemysaunas.com.au>');
  },
  get publicBaseUrl(): string {
    return optional('PUBLIC_BASE_URL', 'http://localhost:8888');
  },
  /** Origins allowed to call the API. The Webflow site plus local dev. */
  get allowedOrigins(): string[] {
    return optional('ALLOWED_ORIGINS', 'http://localhost:8888')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  },
  get defaultVenueId(): string {
    return optional('DEFAULT_VENUE_ID', 'east-fremantle');
  },
  get isProduction(): boolean {
    return optional('CONTEXT', optional('NODE_ENV')) === 'production';
  },
};
