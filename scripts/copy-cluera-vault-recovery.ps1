# Run privately on the original Windows account. No network requests or key generation.
# Paste into an encrypted password manager for independent recovery; never into chat.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$productRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$privateFile = Join-Path $productRoot '.local-secrets/provider-vault-owner/keyring.dpapi'
$entropy = [Text.Encoding]::UTF8.GetBytes('cluera-provider-vault-recovery-v1')
$bytes = $null
try {
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($privateFile), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString($bytes))
    Write-Host 'Keyring copied privately. Paste into your encrypted password manager, then run Set-Clipboard -Value "". Never paste it into chat or a source file.'
} catch {
    throw 'Protected recovery is unavailable on this Windows account. Do not generate a replacement keyring.'
} finally {
    if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
}
