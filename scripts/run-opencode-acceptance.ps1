param([int]$TimeoutSeconds = 210)
$ErrorActionPreference = 'Stop'
if ($TimeoutSeconds -lt 30 -or $TimeoutSeconds -gt 600) { throw 'Use a timeout between 30 and 600 seconds.' }
$native = Join-Path $PSScriptRoot '../src-tauri'
$previousConfig = $env:TAURI_CONFIG
Push-Location $native
try {
    $entry = Invoke-WebRequest 'http://localhost:1421/src/main.tsx' -UseBasicParsing -TimeoutSec 5
    if ($entry.Content -notmatch 'OpenCodeAcceptanceApp') { throw 'Start this checkout with npm run dev before native acceptance.' }
    # Tauri config discovery reads the containing directory's base config;
    # apply the dedicated config as a process-local overlay during codegen/build.
    $env:TAURI_CONFIG = Get-Content (Join-Path $native 'tauri.opencode-acceptance.conf.json') -Raw
    # Cargo examples do not inherit the desktop binary's Common Controls manifest.
    $manifest = "/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    cargo rustc --example open_code_acceptance -- -C "link-arg=$manifest"
    if ($LASTEXITCODE -ne 0) { throw 'The isolated acceptance executable did not compile.' }
    $started = Get-Date
    $app = Start-Process (Join-Path $native 'target/debug/examples/open_code_acceptance.exe') -PassThru
    if (-not $app.WaitForExit($TimeoutSeconds * 1000)) {
        Stop-Process -Id $app.Id
        throw 'The isolated acceptance process timed out. Only that process was stopped.'
    }
    if ($app.ExitCode -ne 0) { throw "The isolated acceptance process exited with code $($app.ExitCode)." }
    $reports = @(Get-ChildItem 'C:/Users/burak/AppData/Local/Temp/opencode/tabs-opencode-acceptance' -Filter 'webview-report-*.json' -Recurse |
        Where-Object LastWriteTime -ge $started | Sort-Object FullName)
    if (-not $reports.Count) { throw 'No native WebView report was received. Do not treat process exit as acceptance.' }
    $reports | ForEach-Object { Get-Content $_.FullName -Raw }
    $last = Get-Content $reports[-1].FullName -Raw | ConvertFrom-Json
    if (-not $last.report.passed) { throw 'The native WebView reported incomplete or failed acceptance.' }
    # Reopen only this freshly created fixture profile. No new model turn is sent.
    $restart = Start-Process (Join-Path $native 'target/debug/examples/open_code_acceptance.exe') -ArgumentList '--resume-run', $last.runId -PassThru
    if (-not $restart.WaitForExit(60000)) {
        Stop-Process -Id $restart.Id
        throw 'Only the isolated restart process was stopped after 60 seconds.'
    }
    $restartReport = Join-Path $reports[-1].DirectoryName 'webview-report-1000.json'
    if ($restart.ExitCode -ne 0 -or -not (Test-Path $restartReport)) { throw 'Native restart produced no acceptance report.' }
    Get-Content $restartReport -Raw
    $reopened = Get-Content $restartReport -Raw | ConvertFrom-Json
    if (-not $reopened.report.passed) { throw 'Native restart acceptance failed.' }
} finally {
    if ($null -eq $previousConfig) { Remove-Item Env:TAURI_CONFIG -ErrorAction SilentlyContinue }
    else { $env:TAURI_CONFIG = $previousConfig }
    Pop-Location
}
