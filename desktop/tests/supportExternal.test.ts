import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SupportDialog } from '../src/renderer/components/SupportDialog';
import { openSupportDestination, supportExternalUrl, SUPPORT_EMAIL, SUPPORT_SUBJECT } from '../src/shared/supportLinks';

describe('desktop support', () => {
  it('shows the support address, response target, privacy reminder, and both email actions', () => {
    const html = renderToStaticMarkup(createElement(SupportDialog, { onClose: () => undefined }));
    expect(html).toContain('Cluera Support');
    expect(html).toContain(SUPPORT_EMAIL);
    expect(html).toContain('Include your Cluera version and the stage that failed. Response times depend on support availability.');
    expect(html).toContain('Never send API keys, passwords, or other private credentials.');
    expect(html).toContain('Email Cluera Support');
    expect(html).toContain('Open your email app instead');
  });

  it('builds only fixed Gmail compose and mailto destinations without a message body or private data', () => {
    expect(SUPPORT_EMAIL).toBe('clueraaisupport@gmail.com');
    const gmail = new URL(supportExternalUrl('supportGmail'));
    expect(gmail.origin).toBe('https://mail.google.com');
    expect(gmail.pathname).toBe('/mail/');
    expect(Object.fromEntries(gmail.searchParams)).toEqual({ view: 'cm', fs: '1', to: SUPPORT_EMAIL, su: SUPPORT_SUBJECT });
    const mail = new URL(supportExternalUrl('supportMail'));
    expect(mail.protocol).toBe('mailto:');
    expect(mail.pathname).toBe(SUPPORT_EMAIL);
    expect(Object.fromEntries(mail.searchParams)).toEqual({ subject: SUPPORT_SUBJECT });
    for (const url of [gmail, mail]) {
      expect(url.searchParams.has('body')).toBe(false);
      expect(url.toString()).not.toMatch(/device_hash|license_key|api_key|fingerprint|transcript|log|file_path/i);
    }
  });

  it('refuses renderer supplied URLs or other unsupported destinations before opening anything', async () => {
    const openExternal = vi.fn(async (_url: string) => undefined);
    for (const unsafe of ['https://example.com', 'mailto:someone@example.com', 'support', { url: 'https://example.com' }, null]) {
      await expect(openSupportDestination(unsafe, openExternal)).rejects.toThrow('Unknown support destination.');
    }
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('uses the system external handler and falls back to fixed mailto when Gmail opening fails', async () => {
    const browserOpener = vi.fn(async (_url: string) => undefined);
    await openSupportDestination('supportGmail', browserOpener);
    expect(browserOpener).toHaveBeenCalledExactlyOnceWith(supportExternalUrl('supportGmail'));

    const openExternal = vi.fn().mockRejectedValueOnce(new Error('No browser')).mockResolvedValueOnce(undefined);
    await openSupportDestination('supportGmail', openExternal);
    expect(openExternal).toHaveBeenNthCalledWith(1, supportExternalUrl('supportGmail'));
    expect(openExternal).toHaveBeenNthCalledWith(2, supportExternalUrl('supportMail'));
    const directMail = vi.fn(async (_url: string) => undefined);
    await openSupportDestination('supportMail', directMail);
    expect(directMail).toHaveBeenCalledExactlyOnceWith(supportExternalUrl('supportMail'));
  });
});
