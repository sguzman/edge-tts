$manifestPath = Join-Path $env:LOCALAPPDATA "EdgeNaturalTts\native-host\com.sguzman.edge_tts.win_natural.json"
$key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.sguzman.edge_tts.win_natural"
if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Recurse -Force }
if (Test-Path -LiteralPath $manifestPath) { Remove-Item -LiteralPath $manifestPath -Force }
Write-Host "Removed the per-user Edge Native Messaging registration only. Windows voice packages and adapter registration were not changed."
