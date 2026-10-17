// Shared browser/BFF creation-and-reset policy. Existing-password login remains opaque.
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
export const passwordRequirement = `Use ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters. A unique long passphrase is recommended.`;
export const weakPasswordNotice = `Choose a stronger password of ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters. Use a unique long passphrase and avoid compromised passwords.`;
