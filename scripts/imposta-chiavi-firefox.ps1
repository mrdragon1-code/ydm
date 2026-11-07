# Salva le chiavi API di addons.mozilla.org come secret del repository
# GitHub, per la firma automatica di YDM per Firefox.
#
# Le chiavi si scrivono qui, in campi nascosti: non compaiono sullo schermo,
# non finiscono in nessun file e passano direttamente a GitHub.
#
#   Tasto destro su questo file > "Esegui con PowerShell"
#   oppure:  powershell -ExecutionPolicy Bypass -File scripts\imposta-chiavi-firefox.ps1

$ErrorActionPreference = 'Stop'
$repo = 'mrdragon1-code/ydm'
$gh = 'C:\Program Files\GitHub CLI\gh.exe'
if (-not (Test-Path $gh)) { $gh = 'gh' }

Write-Host ''
Write-Host 'Chiavi di YDM per Firefox' -ForegroundColor Green
Write-Host 'Aprile qui: https://addons.mozilla.org/developers/addon/api/key/'
Write-Host '(se le avevi gia'' mostrate o incollate da qualche parte: "Revoke and regenerate credentials")'
Write-Host ''

function Read-Hidden([string]$prompt) {
  $secure = Read-Host $prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim() }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$issuer = Read-Hidden 'JWT issuer (inizia con user:)'
if ($issuer -notmatch '^user:\d+:\d+$') {
  Write-Host 'Non sembra un JWT issuer: deve essere tipo user:12345:67. Niente salvato.' -ForegroundColor Red
  Read-Host 'Premi Invio per chiudere'
  exit 1
}
$secret = Read-Hidden 'JWT secret (la stringa lunga)'
if ($secret -notmatch '^[0-9a-f]{64}$') {
  Write-Host 'Non sembra un JWT secret: deve essere una stringa di 64 caratteri 0-9 a-f. Niente salvato.' -ForegroundColor Red
  Read-Host 'Premi Invio per chiudere'
  exit 1
}

# Passate a gh dallo standard input: non compaiono tra gli argomenti del processo.
$issuer | & $gh secret set FIREFOX_JWT_ISSUER -R $repo
if ($LASTEXITCODE) { throw 'Salvataggio di FIREFOX_JWT_ISSUER non riuscito.' }
$secret | & $gh secret set FIREFOX_JWT_SECRET -R $repo
if ($LASTEXITCODE) { throw 'Salvataggio di FIREFOX_JWT_SECRET non riuscito.' }
Remove-Variable issuer, secret

Write-Host ''
Write-Host 'Fatto: le chiavi sono su GitHub. Torna nella chat e scrivi "fatto".' -ForegroundColor Green
Read-Host 'Premi Invio per chiudere'
