# aplicar-parche.ps1 - FocusFlow v6 (camara): copia renderer.js, lighting.js y camera-probe.js a tu proyecto.
# Hace copia de seguridad de los originales en una carpeta .backup-FECHA dentro del proyecto.
# Uso:  .\aplicar-parche.ps1            (busca la carpeta focusflow* solo)
#       .\aplicar-parche.ps1 -Destino "C:\ruta\a\focusflow2"
param([string]$Destino = "")
$ErrorActionPreference = "Stop"
$src   = $PSScriptRoot
$files = @("renderer.js", "lighting.js", "camera-probe.js")

function Test-Proj($p) { return ($p -and (Test-Path (Join-Path $p "renderer.js")) -and (Test-Path (Join-Path $p "lighting.js"))) }

if (-not $Destino) {
    $cands = @((Get-Location).Path)
    $roots = @("$HOME\Desktop", "$HOME\Documents", "$HOME\Downloads", "$HOME\source\repos", "$HOME")
    foreach ($r in $roots) {
        if (-not (Test-Path $r)) { continue }
        foreach ($d in (Get-ChildItem $r -Directory -Filter "focusflow*" -ErrorAction SilentlyContinue)) {
            $hit = Get-ChildItem $d.FullName -Recurse -Depth 2 -Filter "lighting.js" -ErrorAction SilentlyContinue |
                   Where-Object { $_.FullName -notmatch "node_modules" -and $_.FullName -notmatch "\.backup-" } | Select-Object -First 1
            if ($hit) { $cands += $hit.DirectoryName }
        }
    }
    $Destino = $cands | Where-Object { Test-Proj $_ } | Select-Object -First 1
}
if (-not (Test-Proj $Destino)) {
    Write-Host "No encontre la carpeta del proyecto. Ejecuta de nuevo con:  -Destino ""C:\ruta\a\focusflow2""" -ForegroundColor Red
    exit 1
}

$stamp  = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $Destino ".backup-$stamp"
New-Item -ItemType Directory -Path $backup | Out-Null
foreach ($f in $files) {
    $to = Join-Path $Destino $f
    if (Test-Path $to) { Copy-Item $to (Join-Path $backup $f) }
    Copy-Item (Join-Path $src $f) $to -Force
    Write-Host ("  actualizado: " + $f) -ForegroundColor Green
}
Write-Host ""
Write-Host ("Proyecto : " + $Destino)
Write-Host ("Respaldo : " + $backup)
Write-Host "Listo. Cierra la app por completo y vuelve a abrirla (npm start). Si algo sale mal, copia los archivos de la carpeta de respaldo de vuelta."
