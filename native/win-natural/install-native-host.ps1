param(
  [string]$PublishDir = (Join-Path $PSScriptRoot "bin\Release\net10.0-windows\win-x64\publish"),
  [Parameter(Mandatory=$true)][string]$ExtensionId
)
$ErrorActionPreference = "Stop"
$exe = Join-Path (Resolve-Path $PublishDir) "WinNaturalHost.exe"
if (-not (Test-Path -LiteralPath $exe)) { throw "Build the x64 host first: dotnet publish -c Release -r win-x64 --self-contained false" }
$manifestDir = Join-Path $env:LOCALAPPDATA "EdgeNaturalTts\native-host"
New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null
$manifestPath = Join-Path $manifestDir "com.sguzman.edge_tts.win_natural.json"
$manifest = [ordered]@{ name="com.sguzman.edge_tts.win_natural"; description="Edge Natural TTS Windows Natural SAPI host"; path=$exe; type="stdio"; allowed_origins=@("chrome-extension://$ExtensionId/") }
$json = $manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $json, [System.Text.UTF8Encoding]::new($false))
$key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.sguzman.edge_tts.win_natural"
New-Item -Force -Path $key | Out-Null
Set-ItemProperty -LiteralPath $key -Name "(default)" -Value $manifestPath
Write-Host "Native host manifest installed at $manifestPath"
Write-Host "Registered for extension $ExtensionId. No adapter or voice package was changed."
