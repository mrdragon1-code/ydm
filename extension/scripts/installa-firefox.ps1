# Fa firmare YDM da Mozilla e lo installa in Firefox, in modo permanente.
# Chiede le credenziali API di addons.mozilla.org (gratuite:
# https://addons.mozilla.org/developers/addon/api/key/). Restano solo in
# questa finestra: non vengono salvate da nessuna parte.
#
#   Tasto destro su questo file > "Esegui con PowerShell"

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

$issuer = Read-Host 'JWT issuer (es. user:12345:67)'
$secure = Read-Host 'JWT secret' -AsSecureString
$secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

$env:WEB_EXT_API_KEY = $issuer
$env:WEB_EXT_API_SECRET = $secret
try {
  npm run release
  if ($LASTEXITCODE -ne 0) { throw 'Firma non riuscita: controlla le credenziali e che la versione in package.json sia nuova.' }
} finally {
  Remove-Item Env:WEB_EXT_API_KEY, Env:WEB_EXT_API_SECRET -ErrorAction SilentlyContinue
}

$xpi = Get-ChildItem ..\release\*.xpi | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $xpi) { throw 'Nessun file .xpi firmato in release\.' }
Write-Host "Firmato: $($xpi.FullName)"
# Firefox mostra la richiesta di installazione: clicca "Aggiungi".
Start-Process 'C:\Program Files\Mozilla Firefox\firefox.exe' -ArgumentList "`"$($xpi.FullName)`""
Read-Host 'In Firefox clicca "Aggiungi", poi premi Invio per chiudere'
