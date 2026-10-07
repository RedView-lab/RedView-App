# Build du decodeur COPC du viewer LiDAR (Rust -> WASM) sans wasm-pack.
#
# Les proxys rustup de ~/.cargo/bin peuvent etre absents ou casses : on appelle
# directement le toolchain installe, puis le CLI wasm-bindgen dont la version
# doit etre exactement celle de Cargo.lock (sinon le JS genere ne colle pas au
# .wasm).
#
# Options :
#   -SkipTests   ne lance pas les tests (wasm32 + Node) avant le build WASM
#   -Toolchain   dossier bin du toolchain (defaut : stable-x86_64-pc-windows-gnu)
#   -WasmBindgen chemin du wasm-bindgen.exe (defaut : cache wasm-pack ou PATH)
#   -OutDir      dossier de sortie (defaut : src/features/lidar/lib/laz/pkg, glue
#                + .wasm, que Vite emet comme asset).

param(
    [switch]$SkipTests,
    [string]$Toolchain = "",
    [string]$WasmBindgen = "",
    [string]$OutDir = ""
)

# Pas d'ErrorActionPreference=Stop : cargo ecrit sa progression sur stderr, ce
# que PowerShell 5.1 transformerait en erreur. On teste $LASTEXITCODE a la place.
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptRoot

Write-Host "=== Build du decodeur COPC (redviewlaz) ===" -ForegroundColor Cyan

# --- Toolchain Rust ---------------------------------------------------------
if (-not $Toolchain) {
    $candidates = @(
        (Join-Path $env:USERPROFILE ".rustup\toolchains\stable-x86_64-pc-windows-gnu\bin"),
        (Join-Path $env:USERPROFILE ".rustup\toolchains\stable-x86_64-pc-windows-msvc\bin")
    )
    $Toolchain = $candidates | Where-Object { Test-Path (Join-Path $_ "cargo.exe") } | Select-Object -First 1
}
if (-not $Toolchain -or -not (Test-Path (Join-Path $Toolchain "cargo.exe"))) {
    Write-Host "Toolchain Rust introuvable (passer -Toolchain <dossier bin>)." -ForegroundColor Red
    exit 1
}
$cargo = Join-Path $Toolchain "cargo.exe"
# Toolchain gnu : dlltool.exe / gcc vivent dans self-contained (requis par
# windows-sys pour les tests natifs).
$selfContained = Join-Path $Toolchain "..\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained"
if (Test-Path $selfContained) { $env:PATH = "$selfContained;$env:PATH" }
$env:PATH = "$Toolchain;$env:PATH"
$env:RUSTC = Join-Path $Toolchain "rustc.exe"
Write-Host "Toolchain : $Toolchain"
& $cargo --version

# --- wasm-bindgen CLI (version = Cargo.lock) --------------------------------
$lock = Get-Content (Join-Path $scriptRoot "Cargo.lock") -Raw
$match = [regex]::Match($lock, 'name = "wasm-bindgen"\s*\r?\nversion = "([^"]+)"')
if (-not $match.Success) {
    Write-Host "Version de wasm-bindgen introuvable dans Cargo.lock." -ForegroundColor Red
    exit 1
}
$expectedBindgen = $match.Groups[1].Value

if (-not $WasmBindgen) {
    $cached = Get-ChildItem (Join-Path $env:LOCALAPPDATA ".wasm-pack") -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName "wasm-bindgen.exe" } |
        Where-Object { Test-Path $_ }
    $onPath = (Get-Command wasm-bindgen -ErrorAction SilentlyContinue).Source
    $WasmBindgen = @($cached) + @($onPath) |
        Where-Object { $_ -and ((& $_ --version) -match [regex]::Escape($expectedBindgen)) } |
        Select-Object -First 1
}
if (-not $WasmBindgen) {
    Write-Host "wasm-bindgen $expectedBindgen introuvable (cargo install wasm-bindgen-cli --version $expectedBindgen)." -ForegroundColor Red
    exit 1
}
$bindgenVersion = & $WasmBindgen --version
if ($bindgenVersion -notmatch [regex]::Escape($expectedBindgen)) {
    Write-Host "wasm-bindgen $bindgenVersion ne correspond pas a Cargo.lock ($expectedBindgen)." -ForegroundColor Red
    exit 1
}
Write-Host "wasm-bindgen : $bindgenVersion"

# --- Tests (wasm32 sous Node) -----------------------------------------------
# Un test natif windows-gnu exige dlltool + as (raw-dylib de windows-sys), absents
# du toolchain : les tests tournent donc en wasm32 via wasm-bindgen-test-runner.
# Dans les modules de test : `use wasm_bindgen_test::wasm_bindgen_test as test;`
# sous cfg(target_arch = "wasm32"), sinon #[test] n'est pas decouvert.
if (-not $SkipTests) {
    Write-Host "`n[1/3] Tests (wasm32 + Node)..." -ForegroundColor Yellow
    $runner = Join-Path (Split-Path -Parent $WasmBindgen) "wasm-bindgen-test-runner.exe"
    if (-not (Test-Path $runner)) {
        Write-Host "wasm-bindgen-test-runner introuvable a cote de $WasmBindgen." -ForegroundColor Red
        exit 1
    }
    $env:CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER = $runner
    & $cargo test --locked --target wasm32-unknown-unknown --lib
    if ($LASTEXITCODE -ne 0) { Write-Host "Tests en echec." -ForegroundColor Red; exit 1 }
} else {
    Write-Host "`n[1/3] Tests ignores (-SkipTests)." -ForegroundColor DarkYellow
}

# --- Build WASM -------------------------------------------------------------
Write-Host "`n[2/3] Build Rust -> wasm32..." -ForegroundColor Yellow
& $cargo build --release --locked --target wasm32-unknown-unknown --lib
if ($LASTEXITCODE -ne 0) { Write-Host "Build WASM en echec." -ForegroundColor Red; exit 1 }

# --- Glue JS + copie --------------------------------------------------------
Write-Host "`n[3/3] wasm-bindgen..." -ForegroundColor Yellow
$appPkgDir = Join-Path $scriptRoot "..\..\src\features\lidar\lib\laz\pkg"
$outputDir = if ($OutDir) { $OutDir } else { $appPkgDir }
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$wasmIn = Join-Path $scriptRoot "target\wasm32-unknown-unknown\release\redviewlaz.wasm"
& $WasmBindgen $wasmIn --target web --out-dir $outputDir --out-name redviewlaz
if ($LASTEXITCODE -ne 0) { Write-Host "wasm-bindgen en echec." -ForegroundColor Red; exit 1 }


Write-Host "`nBuild termine." -ForegroundColor Green
Get-ChildItem $outputDir | Format-Table Name, @{Label = "Taille (Ko)"; Expression = { [math]::Round($_.Length / 1KB, 1) } }
