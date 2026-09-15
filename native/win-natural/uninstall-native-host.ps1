param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Stable", "Development")]
  [string]$Channel
)
$ErrorActionPreference = "Stop"
$channels = @{
  Stable = @{ HostName = "com.sguzman.edge_tts.win_natural"; Directory = "stable" }
  Development = @{ HostName = "com.sguzman.edge_tts.win_natural.dev"; Directory = "development" }
}
$channelConfig = $channels[$Channel]
$installRoot = Join-Path $env:LOCALAPPDATA ("EdgeNaturalTts\native-host\" + $channelConfig.Directory)
$key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$($channelConfig.HostName)"
if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Recurse -Force }
if (Test-Path -LiteralPath $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force }
Write-Host "Removed the $Channel Edge Native Messaging registration and payload only."
