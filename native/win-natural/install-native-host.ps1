param(
  [string]$PublishDir = "",
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId
)
$ErrorActionPreference = "Stop"
$scriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptRoot)) { $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrWhiteSpace($PublishDir)) { $PublishDir = Join-Path $scriptRoot "bin\Release\net10.0-windows\win-x64\publish" }
$publishPath = (Resolve-Path -LiteralPath $PublishDir).Path
$exe = Join-Path $publishPath "WinNaturalHost.exe"
if (-not (Test-Path -LiteralPath $exe)) { throw "Build the x64 host first: dotnet publish -c Release -r win-x64 --self-contained false" }
$manifestDir = Join-Path $env:LOCALAPPDATA "EdgeNaturalTts\native-host"
New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null
$manifestPath = Join-Path $manifestDir "com.sguzman.edge_tts.win_natural.json"
$manifest = [ordered]@{
  name = "com.sguzman.edge_tts.win_natural"
  description = "Edge Natural TTS Windows Natural diagnostic host"
  path = $exe
  type = "stdio"
}
$origins = @()
if (Test-Path -LiteralPath $manifestPath) {
  $existingManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($null -ne $existingManifest.allowed_origins) {
    $origins = @($existingManifest.allowed_origins | ForEach-Object { [string]$_ })
  }
}
$origin = "chrome-extension://$ExtensionId/"
$manifest.allowed_origins = @($origins + $origin | Select-Object -Unique)
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
$key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.sguzman.edge_tts.win_natural"
New-Item -Force -Path $key | Out-Null
Set-ItemProperty -LiteralPath $key -Name "(default)" -Value $manifestPath
Write-Host "Installed Edge Native Messaging host for extension $ExtensionId"
Write-Host "Manifest: $manifestPath"
