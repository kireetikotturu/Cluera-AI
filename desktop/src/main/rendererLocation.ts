/** A packaged build must never load renderer code from an environment-provided server. */
export function developmentRendererUrl(isProduction: boolean, configuredUrl: string | undefined): string | null {
  return isProduction ? null : configuredUrl || null;
}
