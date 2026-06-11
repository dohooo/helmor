# Windows build environment for Helmor.
# Dot-source this before running cargo/tauri:  . scripts\win\build-env.ps1
# Prepends the native toolchain (sccache, cmake, ninja, go, nasm) needed to
# build boring-sys/BoringSSL, and appends Git's usr/bin LAST so MSVC's link.exe
# is never shadowed by the MSYS coreutils `link`.

$toolDirs = @(
  'C:\Users\dildev\AppData\Local\Microsoft\WinGet\Packages\Mozilla.sccache_Microsoft.Winget.Source_8wekyb3d8bbwe\sccache-v0.15.0-x86_64-pc-windows-msvc',
  'C:\Program Files\CMake\bin',
  'C:\Users\dildev\AppData\Local\Microsoft\WinGet\Packages\Ninja-build.Ninja_Microsoft.Winget.Source_8wekyb3d8bbwe',
  'C:\Program Files (x86)\Go\bin',
  'C:\Users\dildev\AppData\Local\bin\NASM',
  'C:\Users\dildev\AppData\Roaming\npm'
)
$perlDir = 'C:\Program Files\Git\usr\bin'   # appended LAST (perl for BoringSSL)

$env:Path = ($toolDirs -join ';') + ';' + $env:Path + ';' + $perlDir

# The installed CMake predates the "Visual Studio 18 2026" generator that the
# cmake crate auto-detects (VS 2026 is installed). Pin to the VS 2022 generator,
# which this CMake supports and which self-locates MSVC without a dev shell.
# Needed to build boring-sys2 (BoringSSL, via wreq -> Slack TLS emulation).
$env:CMAKE_GENERATOR = 'Visual Studio 17 2022'

# Verify the critical tools resolve.
foreach ($t in 'sccache','cmake','ninja','go','nasm','perl','bun') {
  $p = (Get-Command $t -ErrorAction SilentlyContinue).Source
  if ($p) { Write-Host ("  {0,-8} {1}" -f $t, $p) }
  else    { Write-Host ("  {0,-8} MISSING" -f $t) -ForegroundColor Red }
}
