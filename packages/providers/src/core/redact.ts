/**
 * Log redaction. Every value a provider logs passes through here; key and
 * token values are never logged, even when a library echoes them in an error.
 */
export const REDACTED = '[REDACTED]';

/** Query params that carry credentials (RetroAchievements uses `y` for its API key). */
const SENSITIVE_PARAM = /^(key|api_?key|apikey|token|access_token|refresh_token|y|secret|client_secret|password|auth|sig)$/i;
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-auth-token|x-api-key|x-hp-val)$/i;
const USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
const PAIR = /\b(key|api_?key|apikey|token|access_token|refresh_token|secret|client_secret|password)=([^&\s"']+)/gi;

/** Scrub free text: userinfo, bearer/basic credentials, key=value pairs, and every listed secret. */
export function redactText(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 4) out = out.split(s).join(REDACTED);
  }
  return out.replace(USERINFO, `$1${REDACTED}@`).replace(BEARER, `$1 ${REDACTED}`).replace(PAIR, `$1=${REDACTED}`);
}

/** Loggable URL: userinfo removed, sensitive query values replaced. Never throws. */
export function redactUrl(raw: string, secrets: readonly (string | null | undefined)[] = []): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return redactText(raw, secrets);
  }
  u.username = '';
  u.password = '';
  for (const k of [...new Set(u.searchParams.keys())]) {
    if (SENSITIVE_PARAM.test(k)) u.searchParams.set(k, REDACTED);
  }
  return redactText(u.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED), secrets);
}

export function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k] = SENSITIVE_HEADER.test(k) ? REDACTED : v;
  return out;
}

/** Message of any thrown value, redacted. */
export function safeErrorMessage(err: unknown, secrets: readonly (string | null | undefined)[] = []): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactText(msg, secrets);
}
