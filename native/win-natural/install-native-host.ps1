param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Stable", "Development")]
  [string]$Channel,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId,
  [string]$PublishDir = ""
)
$ErrorActionPreference = "Stop"
$scriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptRoot)) { $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrWhiteSpace($PublishDir)) { $PublishDir = Join-Path $scriptRoot "bin\Release\net10.0-windows\win-x64\publish" }
$channels = @{
  Stable = @{ ExtensionId = "gfeeggciegdnlpdmebfjmahboogkilhi"; HostName = "com.sguzman.edge_tts.win_natural"; Directory = "stable" }
  Development = @{ ExtensionId = "gajodjkpikfgfbcobncfacbjeaekgefb"; HostName = "com.sguzman.edge_tts.win_natural.dev"; Directory = "development" }
}
$channelConfig = $channels[$Channel]
if ($ExtensionId -cne $channelConfig.ExtensionId) { throw "Extension ID '$ExtensionId' does not match the $Channel channel ($($channelConfig.ExtensionId))." }
$publishPath = (Resolve-Path -LiteralPath $PublishDir).Path
$sourceExe = Join-Path $publishPath "WinNaturalHost.exe"
if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf)) { throw "Build the x64 host first: dotnet publish -c Release -r win-x64 --self-contained false" }
$installRoot = Join-Path $env:LOCALAPPDATA ("EdgeNaturalTts\native-host\" + $channelConfig.Directory)
$payloadDir = Join-Path $installRoot "payload"
$manifestPath = Join-Path $installRoot ($channelConfig.HostName + ".json")
$hostExe = Join-Path $payloadDir "WinNaturalHost.exe"
New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
if (Test-Path -LiteralPath $payloadDir) { Remove-Item -LiteralPath $payloadDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $payloadDir | Out-Null
Get-ChildItem -LiteralPath $publishPath | Copy-Item -Destination $payloadDir -Recurse -Force
$manifest = [ordered]@{
  name = $channelConfig.HostName
  description = "Edge Natural TTS Windows Natural $Channel Native Messaging host"
  path = $hostExe
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
$key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$($channelConfig.HostName)"
New-Item -Force -Path $key | Out-Null
Set-ItemProperty -LiteralPath $key -Name "(default)" -Value $manifestPath
Write-Host "Installed Edge Native Messaging host for $Channel channel."
Write-Host "Host: $($channelConfig.HostName)"
Write-Host "Manifest: $manifestPath"
Write-Host "Payload: $payloadDir"
