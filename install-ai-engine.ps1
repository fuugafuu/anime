$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectRoot = Split-Path -Parent $PSCommandPath
$engineDirectory = Join-Path $projectRoot 'tools\rife'
$downloadUrl = 'https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-windows.zip'
$expectedBytes = 431540241L
$zipPath = Join-Path $env:TEMP ("frame-rife-" + [guid]::NewGuid().ToString('N') + '.zip')

try {
    $existingExe = Join-Path $engineDirectory 'rife-ncnn-vulkan.exe'
    $existingModel = Join-Path $engineDirectory 'models\rife-v4.6'
    $alternateModel = Join-Path $engineDirectory 'models\rife-anime'
    $engineReady = (Test-Path $existingExe) -and ((Test-Path $existingModel) -or (Test-Path $alternateModel))
    if (-not $engineReady) {
        $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($zipPath))
        $requiredBytes = $expectedBytes + 300MB
        if ($drive.AvailableFreeSpace -lt $requiredBytes) {
            $requiredMb = [math]::Ceiling($requiredBytes / 1MB)
            $freeMb = [math]::Floor($drive.AvailableFreeSpace / 1MB)
            throw "Not enough free disk space for a safe install: need $requiredMb MB, available $freeMb MB."
        }
    }
    $py = Get-Command py -ErrorAction SilentlyContinue
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($py) {
        & $py.Source -3 -m pip install --user --disable-pip-version-check 'Pillow>=11'
    } elseif ($python) {
        & $python.Source -m pip install --user --disable-pip-version-check 'Pillow>=11'
    } else {
        throw 'Python 3 is required. Install Python 3 and run this installer again.'
    }
    if ($LASTEXITCODE -ne 0) { throw 'Pillow installation failed.' }

    if ($engineReady) {
        Write-Host 'RIFE executable and model are already present.'
        exit 0
    }

    Write-Host 'Downloading official RIFE NCNN Vulkan for Windows (432 MB)...'
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing
    if ((Get-Item $zipPath).Length -ne $expectedBytes) {
        throw 'RIFE archive size mismatch. The download may be incomplete.'
    }
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        $exe = $zip.Entries | Where-Object { $_.Name -eq 'rife-ncnn-vulkan.exe' } | Select-Object -First 1
        if (-not $exe) { throw 'RIFE executable is missing from the official archive.' }
        $model = @($zip.Entries | Where-Object { $_.FullName -match '(^|/)rife-v4\.6/[^/]+$' })
        $modelName = 'rife-v4.6'
        if (-not $model.Count) {
            $model = @($zip.Entries | Where-Object { $_.FullName -match '(^|/)rife-anime/[^/]+$' })
            $modelName = 'rife-anime'
        }
        if (-not $model.Count) { throw 'Compatible RIFE model files were not found.' }

        New-Item -ItemType Directory -Path $engineDirectory -Force | Out-Null
        $targetModel = Join-Path $engineDirectory "models\$modelName"
        New-Item -ItemType Directory -Path $targetModel -Force | Out-Null
        Write-Host "Extracting the executable and the $modelName model only..."
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($exe, $existingExe, $true)
        foreach ($entry in $model) {
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $targetModel $entry.Name), $true)
        }
        $exeFolder = $exe.FullName.Substring(0, $exe.FullName.Length - $exe.Name.Length)
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName.StartsWith($exeFolder) -and $entry.FullName.Substring($exeFolder.Length) -notmatch '/' -and [System.IO.Path]::GetExtension($entry.Name) -eq '.dll') {
                [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $engineDirectory $entry.Name), $true)
            }
        }
    } finally {
        $zip.Dispose()
    }
    Write-Host 'RIFE NCNN Vulkan is installed locally. No Ollama or cloud inference is used.'
} catch {
    Write-Error $_.Exception.Message
    exit 1
} finally {
    if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
}
