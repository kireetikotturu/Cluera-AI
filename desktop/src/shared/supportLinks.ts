export const SUPPORT_EMAIL = 'sigmaroundsupport@gmail.com';
export const SUPPORT_SUBJECT = 'Cluera Support Request';

export type SupportDestination = 'supportGmail' | 'supportMail';

export function supportExternalUrl(kind: unknown): string {
  if (kind === 'supportGmail') {
    return `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(SUPPORT_EMAIL)}&su=${encodeURIComponent(SUPPORT_SUBJECT)}`;
  }
  if (kind === 'supportMail') {
    return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(SUPPORT_SUBJECT)}`;
  }
  throw new Error('Unknown support destination.');
}

export async function openSupportDestination(
  kind: unknown,
  openExternal: (url: string) => Promise<void>,
): Promise<void> {
  const url = supportExternalUrl(kind);
  if (kind === 'supportMail') {
    await openExternal(url);
    return;
  }
  try {
    await openExternal(url);
  } catch {
    await openExternal(supportExternalUrl('supportMail'));
  }
}
