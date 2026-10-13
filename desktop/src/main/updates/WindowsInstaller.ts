import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

/** Stable updates require a trusted, timestamped Windows signature from the pinned publisher. */
export async function verifyWindowsPublisher(file: string, publisher: string | undefined): Promise<void> {
  if (process.platform !== 'win32' || !publisher) throw new Error('Production update publisher is not configured.');
  const script = "$s=Get-AuthenticodeSignature -LiteralPath $env:SIGMAROUND_UPDATE_FILE; [pscustomobject]@{valid=($s.Status -eq 'Valid');publisher=$s.SignerCertificate.Subject;timestamp=($null -ne $s.TimeStamperCertificate)} | ConvertTo-Json -Compress";
  const { stdout } = await promisify(execFile)(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000, maxBuffer: 8192,
      env: { ...process.env, SIGMAROUND_UPDATE_FILE: file } });
  const result = JSON.parse(stdout) as { valid: boolean; publisher: string; timestamp: boolean };
  if (result.valid !== true || result.timestamp !== true || result.publisher !== publisher) {
    throw new Error('Installer publisher or timestamp verification failed.');
  }
}

export function installerArguments(executable: string): string[] {
  const directory = path.win32.dirname(executable);
  if (!path.win32.isAbsolute(directory) || /["\r\n\0]/.test(directory)) throw new Error('Invalid installation directory.');
  // NSIS requires /D= to be the last argument, without quotes, even with spaces.
  return ['--updated', `/D=${directory}`];
}

export async function launchWindowsInstaller(file: string, executable: string): Promise<void> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Updates require installed Windows x64.');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, installerArguments(executable), {
      detached: true, stdio: 'ignore', shell: false, windowsHide: true, windowsVerbatimArguments: true,
    });
    child.once('error', () => reject(new Error('Windows could not start the installer. Try again or use the official download page.')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
