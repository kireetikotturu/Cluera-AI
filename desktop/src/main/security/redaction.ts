const SECRET_FIELDS = /(?:api[-_ ]?key|authorization|token|secret|password|license[-_ ]?key)/gi;
const KEY_LIKE_VALUE = /\b(?:AIza[\w-]{16,}|dg_[\w-]{12,}|SR-[A-Z2-9-]{12,}|Bearer\s+[\w.-]{12,})\b/gi;

export function redactSecrets(message: string, additionalSecrets: string[] = []): string {
  let safe = message.replace(KEY_LIKE_VALUE, '[REDACTED]').replace(SECRET_FIELDS, '[REDACTED_FIELD]');
  for (const secret of additionalSecrets) {
    if (secret) safe = safe.split(secret).join('[REDACTED]');
  }
  return safe.slice(0, 800);
}
