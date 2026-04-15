# Build script for REDView Algorithm WASM module

Write-Host "=== Building REDView WASM Engine ===" -ForegroundColor Cyan

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptRoot
$outputDir = Join-Path $scriptRoot "..\..\src\features\fitPredictor\engine\pkg"
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

# 1. Build WASM with wasm-pack
Write-Host "`n[1/2] Building Rust -> WASM..." -ForegroundColor Yellow
wasm-pack build --release --target web --out-dir $outputDir

if ($LASTEXITCODE -ne 0) {
    Write-Host "WASM build failed!" -ForegroundColor Red
    exit 1
}

Write-Host "`n[2/2] Build complete!" -ForegroundColor Green

# Copy WASM binary to public/ for reliable worker loading
$publicDir = Join-Path $scriptRoot "..\..\public"
$wasmSrc = Join-Path $outputDir "redviewalgo_bg.wasm"
if (Test-Path $wasmSrc) {
    Copy-Item $wasmSrc (Join-Path $publicDir "redviewalgo_bg.wasm") -Force
    Write-Host "Copied WASM to public/redviewalgo_bg.wasm" -ForegroundColor Green
}

# Show output files
Write-Host "`nOutput files in app pkg/:" -ForegroundColor Cyan
Get-ChildItem $outputDir | Format-Table Name, @{Label="Size (KB)"; Expression={[math]::Round($_.Length / 1KB, 1)}}

Write-Host "`nTo use in your frontend:" -ForegroundColor Cyan
Write-Host "  1. Start RedView-App with npm run dev"
Write-Host "  2. Open the map dashboard"
Write-Host "  3. Use the Predict popup docked next to LiDAR"
Write-Host ""
