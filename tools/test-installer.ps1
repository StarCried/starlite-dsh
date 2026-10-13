#Requires -Version 7.2
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# This writes Windows application registrations. A different /D directory alone
# does not isolate them, so never run this against a developer's Windows account.
# The windows-2025 label serves both the VS 2022 and VS 2026 official images.
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:RUNNER_OS -ne 'Windows' -or $env:ImageOS -notin @('win25', 'win25-vs2026') -or
    $env:GITHUB_REPOSITORY -ne 'StarCried/starlite-dsh') {
    throw 'Installer acceptance only runs in the clean windows-2025 GitHub-hosted StarLite CI job.'
}

function Assert-PathInside([string] $Path, [string] $Root) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if (-not $fullPath.StartsWith($fullRoot + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Installer test path leaves its owned temporary directory.'
    }
    return $fullPath
}

function Invoke-Setup([string] $Executable, [string] $Arguments) {
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(120000)) {
        $process.Kill()
        throw 'The owned installer process exceeded its two-minute timeout.'
    }
    if ($process.ExitCode -ne 0) {
        throw "The owned installer process failed with exit code $($process.ExitCode)."
    }
}

function Set-NsisDefinition([string] $Text, [string] $Name, [string] $Value) {
    $pattern = '(?m)^!define ' + [regex]::Escape($Name) + ' "[^\r\n]*"\r?$'
    if ([regex]::Matches($Text, $pattern).Count -ne 1) {
        throw "The generated NSIS template must define $Name exactly once."
    }
    # Escape NSIS variable/quote syntax and use an evaluator so Windows paths
    # and dollar signs never become regular-expression replacement syntax.
    $definition = '!define ' + $Name + ' "' + $Value.Replace('$', '$$').Replace('"', '$\"') + '"'
    return [regex]::Replace($Text, $pattern, [Text.RegularExpressions.MatchEvaluator] { param($match) $definition })
}

function Get-NsisPayloadHash([byte[]] $BuildBytes) {
    # Tauri CLI 2.11.4 patches the first bundle-type marker before packaging,
    # then restores the unbundled release executable. Compute the expected full
    # installed hash from precisely that documented upstream transformation.
    # https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle.rs
    $unknown = '__TAURI_BUNDLE_TYPE_VAR_UNK'
    $nsis = [Text.Encoding]::ASCII.GetBytes('__TAURI_BUNDLE_TYPE_VAR_NSS')
    $offset = [Text.Encoding]::Latin1.GetString($BuildBytes).IndexOf($unknown, [StringComparison]::Ordinal)
    if ($offset -lt 0 -or $nsis.Length -ne $unknown.Length) {
        throw 'The restored release executable lacks the expected Tauri bundle-type marker.'
    }
    $patched = [byte[]]$BuildBytes.Clone()
    [Array]::Copy($nsis, 0, $patched, $offset, $nsis.Length)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($patched))
}

$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $workspace.Equals([IO.Path]::GetFullPath($env:GITHUB_WORKSPACE), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The installer acceptance script must belong to the checked-out CI workspace.'
}
$config = Get-Content -LiteralPath (Join-Path $workspace 'apps/desktop/src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
if ($config.productName -ne 'StarLite for DSH' -or $config.identifier -ne 'com.starcried.dsh-inochi2d-pet' -or
    $config.bundle.windows.nsis.installMode -ne 'currentUser') {
    throw 'Unexpected installer identity or installation mode.'
}
$productName = $config.productName
$bundleId = $config.identifier
$binaryName = 'dsh-inochi2d-pet.exe'
$bundleDirectory = Join-Path $workspace 'apps/desktop/src-tauri/target/release/bundle/nsis'
$installerName = "${productName}_$($config.version)_x64-setup.exe"
$installer = Join-Path $bundleDirectory $installerName
$buildBinary = Join-Path $workspace "apps/desktop/src-tauri/target/release/$binaryName"
foreach ($file in @($installer, $buildBinary)) {
    $item = Get-Item -LiteralPath $file
    if ($item.PSIsContainer -or $item.Length -eq 0 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The current installer and release executable must be nonempty ordinary files.'
    }
}
$bundleFiles = @(Get-ChildItem -LiteralPath $bundleDirectory -Force)
if ($bundleFiles.Count -ne 1 -or $bundleFiles[0].Name -ne $installerName) {
    throw 'The clean NSIS output must contain only the current product/version installer.'
}
if ((Get-Item -LiteralPath $installer).VersionInfo.ProductName -ne $productName) {
    throw 'The installer does not identify the expected StarLite product.'
}
$expectedBuildBinaryHash = (Get-FileHash -LiteralPath $buildBinary -Algorithm SHA256).Hash
$expectedBinaryHash = Get-NsisPayloadHash ([IO.File]::ReadAllBytes($buildBinary))
$expectedInstallerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
$expectedInstallerTime = (Get-Item -LiteralPath $installer).LastWriteTimeUtc
$generatedNsisDirectory = Join-Path $workspace 'apps/desktop/src-tauri/target/release/nsis/x64'
$generatedNsisScript = Join-Path $generatedNsisDirectory 'installer.nsi'
$expectedTemplateHash = (Get-FileHash -LiteralPath $generatedNsisScript -Algorithm SHA256).Hash
$makensis = Join-Path $env:LOCALAPPDATA 'tauri/NSIS/makensis.exe'
if (-not (Test-Path -LiteralPath $makensis -PathType Leaf)) { throw 'The just-built candidate must leave its NSIS compiler available.' }
$baselineVersion = '0.0.0-starlite-upgrade-fixture'
if ([version](($config.version -split '[-+]')[0]) -le [version]'0.0.0') {
    throw 'The synthetic baseline version must be lower than the candidate version.'
}
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$productName"
$manufacturerKey = "HKCU:\Software\StarCried\$productName"
$protocolKey = 'HKCU:\Software\Classes\dsh-inochi2d-pet'
$dataDirectories = @((Join-Path $env:APPDATA $bundleId), (Join-Path $env:LOCALAPPDATA $bundleId))

# Refuse all pre-existing identities and data before creating anything. Even a
# previous development protocol registration makes this machine unsuitable.
foreach ($hive in @('HKCU:', 'HKLM:')) {
    foreach ($name in @('StarLite for DSH', 'DSH Companion', 'DSH Inochi2D Pet')) {
        foreach ($prefix in @('Software', 'Software\WOW6432Node')) {
            foreach ($key in @("$hive\$prefix\Microsoft\Windows\CurrentVersion\Uninstall\$name",
                    "$hive\$prefix\StarCried\$name")) {
                if (Test-Path -LiteralPath $key) { throw 'An existing companion installation prevents isolated acceptance.' }
            }
        }
    }
    if (Test-Path -LiteralPath "$hive\Software\Classes\dsh-inochi2d-pet") {
        throw 'An existing companion URL registration prevents isolated acceptance.'
    }
}
foreach ($directory in $dataDirectories) {
    if (Test-Path -LiteralPath $directory) { throw 'Existing companion user data prevents isolated acceptance.' }
}
if (Get-Process -Name 'dsh-inochi2d-pet' -ErrorAction SilentlyContinue) {
    throw 'An existing companion process prevents isolated acceptance.'
}

$runnerTemp = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
$taskRoot = Assert-PathInside (Join-Path $runnerTemp ('starlite-installer-' + [guid]::NewGuid().ToString('N'))) $runnerTemp
if (Test-Path -LiteralPath $taskRoot) { throw 'The owned temporary directory already exists.' }
$installDirectory = Assert-PathInside (Join-Path $taskRoot 'app') $taskRoot
$installedBinary = Assert-PathInside (Join-Path $installDirectory $binaryName) $taskRoot
$uninstaller = Assert-PathInside (Join-Path $installDirectory 'uninstall.exe') $taskRoot
$sentinelName = 'starlite-installer-ci-sentinel.txt'
$sentinel = 'StarLite installer acceptance ' + [guid]::NewGuid().ToString('N')
$createdDataDirectories = [Collections.Generic.List[string]]::new()
$createdDataFiles = [Collections.Generic.List[string]]::new()
$settingsPath = Join-Path $dataDirectories[0] 'settings.json'
$settingsHash = $null
$installationStarted = $false
$testFailure = $null
$cleanupFailures = [Collections.Generic.List[string]]::new()

function Assert-Installed([string] $Version = $config.version, [string] $BinaryHash = $expectedBinaryHash) {
    if (-not (Test-Path -LiteralPath $installedBinary -PathType Leaf) -or
        -not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
        throw 'Installation did not create the executable and uninstaller.'
    }
    # No character pack or old runtime resources belong in the program bundle.
    # The current Tauri app embeds its frontend, leaving these two files only.
    $files = @(Get-ChildItem -LiteralPath $installDirectory -Recurse -Force)
    foreach ($file in $files) {
        [void](Assert-PathInside $file.FullName $taskRoot)
        if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.PSIsContainer -or
            $file.Name -notin @($binaryName, 'uninstall.exe')) {
            throw 'The installed program contains an unexpected file, directory or link.'
        }
    }
    if ($files.Count -ne 2 -or (Get-FileHash -LiteralPath $installedBinary -Algorithm SHA256).Hash -ne $BinaryHash) {
        throw 'Installed contents do not match the expected candidate or synthetic baseline payload.'
    }
    if ((Get-Item -LiteralPath $installedBinary).VersionInfo.ProductName -ne $productName) {
        throw 'The installed executable has the wrong product identity.'
    }
    $registration = Get-ItemProperty -LiteralPath $uninstallKey
    if ($registration.DisplayName -ne $productName -or $registration.DisplayVersion -ne $Version -or
        $registration.Publisher -ne 'StarCried' -or
        $registration.InstallLocation.Trim('"') -ne $installDirectory -or
        $registration.UninstallString -ne ('"' + $uninstaller + '"')) {
        throw 'The installation registration does not match the owned test installation.'
    }
    $command = (Get-Item -LiteralPath "$protocolKey\shell\open\command").GetValue('')
    if ($command -ne ('"' + $installedBinary + '" "%1"')) {
        throw 'The companion URL protocol does not point at the owned installed executable.'
    }
    if ((Get-Item -LiteralPath $manufacturerKey).GetValue('') -ne $installDirectory) {
        throw 'The installer did not retain the expected installation directory.'
    }
}

function Assert-Uninstalled {
    if ((Test-Path -LiteralPath $installedBinary) -or (Test-Path -LiteralPath $uninstallKey) -or
        (Test-Path -LiteralPath $protocolKey)) {
        throw 'Uninstall left the executable, uninstall entry or companion URL registration behind.'
    }
}

function Assert-Sentinels {
    foreach ($directory in $createdDataDirectories) {
        if ((Get-Content -LiteralPath (Join-Path $directory $sentinelName) -Raw) -ne $sentinel) {
            throw 'Reinstall or uninstall changed the synthetic user data sentinel.'
        }
    }
    if ((Get-FileHash -LiteralPath $settingsPath -Algorithm SHA256).Hash -ne $settingsHash) {
        throw 'Upgrade, reinstall or uninstall changed the original synthetic settings.json.'
    }
}

function New-SyntheticBaseline {
    # There is no previously released StarLite version. Recompile a temporary
    # copy of this exact generated installer template with lower install metadata.
    # Its payload is a candidate copy with an inert trailer, never executed; the
    # differing hash proves that upgrading actually replaces the old test file.
    # This covers NSIS upgrade mechanics, not old application/schema migration.
    $baselineDirectory = Assert-PathInside (Join-Path $taskRoot 'synthetic-baseline') $taskRoot
    [void](New-Item -ItemType Directory -Path $baselineDirectory)
    $payloadDirectory = Assert-PathInside (Join-Path $baselineDirectory 'payload') $taskRoot
    [void](New-Item -ItemType Directory -Path $payloadDirectory)
    $baselineBinary = Assert-PathInside (Join-Path $payloadDirectory $binaryName) $taskRoot
    Copy-Item -LiteralPath $buildBinary -Destination $baselineBinary
    $stream = [IO.File]::Open($baselineBinary, [IO.FileMode]::Append, [IO.FileAccess]::Write)
    try {
        $marker = [Text.Encoding]::UTF8.GetBytes('StarLite synthetic installer-upgrade fixture; never execute this payload.')
        $stream.Write($marker, 0, $marker.Length)
    } finally { $stream.Dispose() }
    $baselineHash = (Get-FileHash -LiteralPath $baselineBinary -Algorithm SHA256).Hash
    if ($baselineHash -eq $expectedBinaryHash) { throw 'The synthetic baseline must differ from the candidate payload.' }

    $text = Get-Content -LiteralPath $generatedNsisScript -Raw
    foreach ($definition in @(('!define PRODUCTNAME "' + $productName + '"'), ('!define VERSION "' + $config.version + '"'),
            ('!define MAINBINARYSRCPATH "' + $buildBinary + '"'))) {
        if (-not $text.Contains($definition)) { throw 'The generated NSIS template does not belong to the current candidate.' }
    }
    foreach ($include in @(Get-ChildItem -LiteralPath $generatedNsisDirectory -Filter '*.nsh' -File)) {
        if ($include.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'NSIS template includes must be ordinary files.' }
        Copy-Item -LiteralPath $include.FullName -Destination (Assert-PathInside (Join-Path $baselineDirectory $include.Name) $taskRoot)
    }
    $baselineInstaller = Assert-PathInside (Join-Path $baselineDirectory 'synthetic-old-starlite-setup.exe') $taskRoot
    $text = Set-NsisDefinition $text 'VERSION' $baselineVersion
    $text = Set-NsisDefinition $text 'VERSIONWITHBUILD' '0.0.0.0'
    $text = Set-NsisDefinition $text 'MAINBINARYSRCPATH' $baselineBinary
    $text = Set-NsisDefinition $text 'OUTFILE' $baselineInstaller
    $baselineScript = Assert-PathInside (Join-Path $baselineDirectory 'installer.nsi') $taskRoot
    Set-Content -LiteralPath $baselineScript -Value $text -Encoding utf8
    # Match Tauri's compiler environment without changing the parent shell or
    # inheriting a different NSIS installation's includes, stubs or configuration.
    $compilerInfo = [Diagnostics.ProcessStartInfo]::new()
    $compilerInfo.FileName = $makensis
    $compilerInfo.WorkingDirectory = $baselineDirectory
    $compilerInfo.UseShellExecute = $false
    $compilerInfo.CreateNoWindow = $true
    $compilerInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    foreach ($argument in @('-INPUTCHARSET', 'UTF8', '-OUTPUTCHARSET', 'UTF8', '-V2', $baselineScript)) {
        $compilerInfo.ArgumentList.Add($argument)
    }
    [void]$compilerInfo.Environment.Remove('NSISDIR')
    [void]$compilerInfo.Environment.Remove('NSISCONFDIR')
    $compiler = [Diagnostics.Process]::Start($compilerInfo)
    try {
        if (-not $compiler.WaitForExit(120000)) {
            $compiler.Kill($true)
            throw 'Compiling the synthetic old-version installer exceeded its two-minute timeout.'
        }
        if ($compiler.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $baselineInstaller -PathType Leaf)) {
            throw 'Compiling the synthetic old-version installer failed.'
        }
    } finally { $compiler.Dispose() }
    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $expectedInstallerHash -or
        (Get-Item -LiteralPath $installer).LastWriteTimeUtc -ne $expectedInstallerTime -or
        (Get-FileHash -LiteralPath $buildBinary -Algorithm SHA256).Hash -ne $expectedBuildBinaryHash -or
        (Get-FileHash -LiteralPath $generatedNsisScript -Algorithm SHA256).Hash -ne $expectedTemplateHash) {
        throw 'Creating the synthetic baseline changed a candidate build input or output.'
    }
    return @{ Installer = $baselineInstaller; BinaryHash = $baselineHash }
}

try {
    [void](New-Item -ItemType Directory -Path $taskRoot)
    $baseline = New-SyntheticBaseline
    $installationStarted = $true
    # NSIS /D and _?= must be the final, unquoted arguments, including paths
    # containing spaces. /R is deliberately absent: no real app or DSH starts.
    Invoke-Setup $installer "/S /D=$installDirectory"
    Assert-Installed
    Write-Host 'PASS: fresh install, program allowlist, product metadata and URL registration.'
    Invoke-Setup $uninstaller "/S _?=$installDirectory"
    Assert-Uninstalled
    $installationStarted = $false

    $installationStarted = $true
    Invoke-Setup $baseline.Installer "/S /D=$installDirectory"
    Assert-Installed $baselineVersion $baseline.BinaryHash
    Write-Host "PASS: explicitly synthetic old installer baseline ($baselineVersion); not a released old application."

    foreach ($directory in $dataDirectories) {
        if (Test-Path -LiteralPath $directory) { throw 'The silent installation unexpectedly created application user data.' }
        [void](New-Item -ItemType Directory -Path $directory)
        $createdDataDirectories.Add($directory)
        $sentinelPath = Join-Path $directory $sentinelName
        $createdDataFiles.Add($sentinelPath)
        Set-Content -LiteralPath $sentinelPath -Value $sentinel -NoNewline
    }
    $createdDataFiles.Add($settingsPath)
    Set-Content -LiteralPath $settingsPath -NoNewline -Value '{"schemaVersion":3,"preferences":{"fps":30,"maxDevicePixelRatio":1.25,"scale":0.8,"privacyMode":true,"bubbleMode":"detailed"}}'
    $settingsHash = (Get-FileHash -LiteralPath $settingsPath -Algorithm SHA256).Hash
    # No /D: use the remembered same-product installation directory, as a real
    # update does. DisplayVersion must advance and the differing file be replaced.
    Invoke-Setup $installer '/S'
    Assert-Installed
    Assert-Sentinels
    Write-Host "PASS: synthetic $baselineVersion -> $($config.version) upgrade replaces the program, preserves settings and keeps URL registration correct."

    Invoke-Setup $installer '/S'
    Assert-Installed
    Assert-Sentinels
    Write-Host 'PASS: same-version reinstall preserves synthetic Roaming and Local user data.'

    Invoke-Setup $uninstaller "/S _?=$installDirectory"
    Assert-Uninstalled
    Assert-Sentinels
    $installationStarted = $false
    Write-Host 'PASS: uninstall removes application/URL registrations and preserves synthetic user data.'
    Write-Host 'Synthetic NSIS upgrade and same-version reinstall passed; old app schema migration, old DSH product-name migration and model-import UI remain separate checks.'
} catch {
    $testFailure = $_
} finally {
    # Attempt the actual owned uninstaller after a failed check. Never unregister
    # unrelated identities or run a pre-existing installation's uninstaller.
    if ($installationStarted -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
        try { Invoke-Setup $uninstaller "/S _?=$installDirectory" }
        catch { $cleanupFailures.Add('The owned failed installation could not be uninstalled.') }
    }
    foreach ($file in $createdDataFiles) {
        try {
            if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force }
        } catch { $cleanupFailures.Add('An owned synthetic user data file could not be removed.') }
    }
    foreach ($directory in $createdDataDirectories) {
        try {
            if (Test-Path -LiteralPath $directory -PathType Container) {
                # User data lies outside taskRoot: remove only the exact empty
                # directories this run created, never recursively delete AppData.
                [IO.Directory]::Delete($directory, $false)
            }
        } catch { $cleanupFailures.Add('The owned synthetic user data could not be removed non-recursively.') }
    }
    # NSIS intentionally remembers its last directory when user data is kept.
    # Remove only the exact metadata key this clean run created, after proving
    # it still identifies our temporary installation. This is cleanup, not an
    # assertion that NSIS itself removes the remembered directory setting.
    if (Test-Path -LiteralPath $manufacturerKey) {
        try {
            if ((Get-Item -LiteralPath $manufacturerKey).GetValue('') -ne $installDirectory) {
                throw 'Installation metadata no longer belongs to this acceptance run.'
            }
            Remove-Item -LiteralPath $manufacturerKey -Force
        } catch { $cleanupFailures.Add('The owned remembered installation metadata could not be removed.') }
    }
    if (Test-Path -LiteralPath $taskRoot) {
        try {
            [void](Assert-PathInside $taskRoot $runnerTemp)
            foreach ($item in @(Get-Item -LiteralPath $taskRoot) + @(Get-ChildItem -LiteralPath $taskRoot -Recurse -Force)) {
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                    throw 'Refusing temporary cleanup because the owned tree contains a link.'
                }
            }
            Remove-Item -LiteralPath $taskRoot -Recurse -Force
        } catch { $cleanupFailures.Add('The owned temporary directory could not be safely removed.') }
    }
}
if ($cleanupFailures.Count -gt 0) {
    foreach ($failure in $cleanupFailures) { Write-Warning $failure }
}
if ($testFailure) { throw $testFailure }
if ($cleanupFailures.Count -gt 0) { throw 'Installer acceptance cleanup failed.' }
