/** Client-safe fixed guidance. Never render a server exception/message/body. */
export const releaseErrorMessages = {
 RELEASE_VERSION_INVALID: 'Use a three-part version such as 1.0.8, without v or a test suffix.',
 RELEASE_MINIMUM_INVALID: 'Use a valid minimum Account version no newer than the release version.',
 RELEASE_URL_INVALID: 'Use the exact HTTPS GitHub asset URL ending in ClueraAITestSetup-<version>.exe.',
 RELEASE_ORIGIN_DENIED: 'The installer host is not approved. Ask the staging operator to verify RELEASE_DOWNLOAD_ORIGINS.',
 RELEASE_HASH_INVALID: 'Enter the verified 64-character SHA-256 in hexadecimal.',
 RELEASE_SIZE_INVALID: 'Enter the exact whole-number byte size, between 1 and 536870912.',
 RELEASE_NOTES_INVALID: 'Release notes must be text of at most 2000 characters.',
 RELEASE_POLICY_INVALID: 'Choose OPTIONAL, RECOMMENDED or REQUIRED.',
 RELEASE_REASON_INVALID: 'Enter an audit reason of 10–500 characters after trimming spaces.',
 RELEASE_OPERATION_INVALID: 'The operation identifier is invalid. Refresh the Admin page before a new operation.',
 RELEASE_CONFIRMATION_REQUIRED: 'Independently verify the Account installer, then explicitly confirm its identity.',
 RELEASE_INPUT_INVALID: 'Check the release form fields. Only the documented Account release fields are accepted.',
 RELEASE_DATABASE_INVALID: 'The database rejected the release metadata or approval confirmation. Contact the staging operator if all fields match the release guide.',
 RELEASE_CONFLICT: 'This version or operation already exists, or publication would downgrade an approved version. Refresh the release list before proceeding.',
 RELEASE_NOT_FOUND: 'The selected release no longer exists. Refresh the release list.',
 RELEASE_MFA_REQUIRED: 'Complete Admin MFA again, refresh the release list, then submit.',
 RELEASE_SERVICE_UNAVAILABLE: 'Release configuration or its database service is unavailable. Do not create another operation while this result is unconfirmed.',
 UNAUTHENTICATED: 'Your session expired. Sign in again and complete Admin MFA.',
 FORBIDDEN: 'Admin authorization was denied. Use your allowed staging account with current MFA and the staging website.',
 RATE_LIMITED: 'Too many requests. Wait before retrying; keep the same operation if its earlier result is unconfirmed.',
} as const;
export type ReleaseErrorCode = keyof typeof releaseErrorMessages;
export function releaseErrorMessage(value: unknown): string | undefined {
 return typeof value==='string' && Object.hasOwn(releaseErrorMessages,value)
  ? `[${value}] ${releaseErrorMessages[value as ReleaseErrorCode]}` : undefined;
}
