// Windows PowerShell transport for packaged installations without Node.js.
export const BROWSER_TEST_HELPER = String.raw`param([string]$PlanPath, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$browserFiles = @(); $browserPaths = @(); $browserPerformed = $false
function Assert-TestPath([string]$Path) {
  if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path -notmatch '\.json$' -or
      $Path.Substring(2) -match '[\x00-\x1f<>:"|?*]' -or
      $Path -match '(^|[\\/])(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|[\\/]|$)') {
    throw 'Test files must use local absolute .json paths.'
  }
}
try {
  Assert-TestPath $PlanPath
  if (!$OutputPath) { $OutputPath = [regex]::Replace($PlanPath, '\.json$', '.report-' + [Guid]::NewGuid().ToString() + '.json', 'IgnoreCase') }
  Assert-TestPath $OutputPath
  if ((Get-Item -LiteralPath $PlanPath).Length -gt 131072) { throw 'Test plan exceeds 128 KiB.' }
  try { $browserPlan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw 'Invalid test JSON.' }
  foreach ($step in $browserPlan.steps) {
    if ($step.PSObject.Properties['valueFromEnv']) {
      if ($step.action -ne 'fill' -or $step.PSObject.Properties['value'] -or $step.valueFromEnv -isnot [string] -or $step.valueFromEnv -cnotmatch '^COPILOT_TEST_[A-Z0-9_]{1,115}$') { throw 'valueFromEnv requires a fill step and a COPILOT_TEST_ environment variable name.' }
      $browserValue = [Environment]::GetEnvironmentVariable($step.valueFromEnv)
      if ($null -eq $browserValue) { throw 'The test input environment variable is not set.' }
      $step.PSObject.Properties.Remove('valueFromEnv')
      $step | Add-Member -NotePropertyName value -NotePropertyValue $browserValue
    }
  }
  $browserBody = $browserPlan | ConvertTo-Json -Depth 20 -Compress
  if ([Text.Encoding]::UTF8.GetByteCount($browserBody) -gt 131072) { throw 'Test plan exceeds 128 KiB.' }
  $browserCount = @($browserPlan.steps | Where-Object { $_.action -eq 'screenshot' }).Count
  if ($browserCount -gt 5) { throw 'Use at most five screenshots.' }
  $browserPaths = @($OutputPath)
  for ($i = 1; $i -le $browserCount; $i++) { $browserPaths += [regex]::Replace($OutputPath, '\.json$', '.image-' + $i + '.png', 'IgnoreCase') }
  foreach ($path in $browserPaths) { $browserFiles += [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
  $browserControl = Get-Content -LiteralPath $env:COPILOT_DESKTOP_BROWSER_STATE -Raw | ConvertFrom-Json
  if ($browserControl.pid -notmatch '^\d+$' -or [long]$browserControl.pid -lt 1 -or [long]$browserControl.pid -gt 2147483647 -or
      !(Get-Process -Id ([int]$browserControl.pid) -ErrorAction SilentlyContinue) -or
      $browserControl.port -notmatch '^\d+$' -or [long]$browserControl.port -lt 1 -or [long]$browserControl.port -gt 65535 -or
      $browserControl.token -notmatch '^[a-f0-9]{64}$') { throw 'Browser control state is stale or invalid. Reopen this session Browser pane.' }
  $browserPerformed = $true
  try {
    $browserResponse = Invoke-WebRequest -UseBasicParsing -Method POST -Uri ('http://127.0.0.1:' + $browserControl.port + '/test') -Headers @{ Authorization = 'Bearer ' + $browserControl.token } -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($browserBody)) -TimeoutSec 315 -MaximumRedirection 0
  } catch {
    $browserRequestFailure = $_
    $browserRequestMessage = $null
    try {
      if ($browserRequestFailure.ErrorDetails.Message -is [string]) { $browserErrorBody = $browserRequestFailure.ErrorDetails.Message }
      $browserErrorResponse = $browserRequestFailure.Exception.Response
      if (!$browserErrorBody -and $browserErrorResponse -and $browserErrorResponse.PSObject.Methods['GetResponseStream']) {
        $browserReader = New-Object IO.StreamReader($browserErrorResponse.GetResponseStream())
        try { $browserErrorBody = $browserReader.ReadToEnd() } finally { $browserReader.Dispose() }
      }
      if ($browserErrorBody) {
        $browserError = $browserErrorBody | ConvertFrom-Json
        if ($browserError.message -is [string] -and $browserError.message) { $browserRequestMessage = $browserError.message }
      }
    } catch {}
    if ($browserRequestMessage) { $browserPerformed = $false; throw $browserRequestMessage }
    throw $browserRequestFailure
  }
  $browserReport = $browserResponse.Content | ConvertFrom-Json
  if (@('passed','failed','cancelled') -notcontains $browserReport.status -or $null -eq $browserReport.steps -or $null -eq $browserReport.screenshots -or @($browserReport.screenshots).Count -gt $browserCount) { throw 'Invalid test response; do not rerun actions automatically.' }
  $i = 0
  foreach ($image in $browserReport.screenshots) {
    $i++
    if ($image.imageBase64 -isnot [string] -or $image.imageBase64.Length -gt 3145728) { throw 'Invalid test screenshot.' }
    $bytes = [Convert]::FromBase64String($image.imageBase64)
    $browserFiles[$i].Write($bytes, 0, $bytes.Length)
    $image.PSObject.Properties.Remove('imageBase64')
    $image | Add-Member -NotePropertyName path -NotePropertyValue $browserPaths[$i]
  }
  $browserReport | Add-Member -NotePropertyName path -NotePropertyValue $OutputPath
  $browserJson = $browserReport | ConvertTo-Json -Depth 20 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($browserJson)
  $browserFiles[0].Write($bytes, 0, $bytes.Length)
  for ($i = @($browserReport.screenshots).Count + 1; $i -lt $browserFiles.Count; $i++) { $browserFiles[$i].Dispose(); Remove-Item -LiteralPath $browserPaths[$i] }
  $browserJson
} catch {
  if (!$browserPerformed) {
    for ($i = 0; $i -lt $browserFiles.Count; $i++) { $browserFiles[$i].Dispose(); Remove-Item -LiteralPath $browserPaths[$i] -ErrorAction SilentlyContinue }
  } elseif ($browserFiles.Count) {
    $bytes = [Text.Encoding]::UTF8.GetBytes('{"status":"unavailable","message":"Inspect Last test in the browser before rerunning actions."}')
    $browserFiles[0].Write($bytes, 0, $bytes.Length)
  }
  [Console]::Error.WriteLine('Browser test failed. ' + $_.Exception.Message)
  exit 1
} finally {
  foreach ($file in $browserFiles) { $file.Dispose() }
  $browserBody = $null; $browserPlan = $null; $browserValue = $null; $browserControl = $null
  $browserRequestFailure = $null; $browserRequestMessage = $null; $browserErrorResponse = $null; $browserErrorBody = $null; $browserError = $null
}
`
