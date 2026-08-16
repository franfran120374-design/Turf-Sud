# ---------------------------------------------------------------
# Turf Sud - publication sur GitHub Pages
# Placez ce script dans le dossier qui contient index.html, puis :
#     powershell -ExecutionPolicy Bypass -File .\push.ps1
# ---------------------------------------------------------------
$repo = "https://github.com/franfran120374-design/turf-sud.git"
$msg  = "Turf Sud v5 - simple place, mise fixe, base Grenade 37 courses"

if (-not (Test-Path ".\index.html")) {
    Write-Host "index.html introuvable. Lancez le script depuis le dossier turf-sud." -ForegroundColor Red
    exit 1
}

# incremente automatiquement la version du service worker (sinon cache obsolete)
if (Test-Path ".\sw.js") {
    $sw = Get-Content .\sw.js -Raw
    if ($sw -match "turf-sud-v(\d+)") {
        $v = [int]$Matches[1] + 1
        $sw = $sw -replace "turf-sud-v\d+", "turf-sud-v$v"
        Set-Content .\sw.js $sw -NoNewline
        Write-Host "Service worker -> turf-sud-v$v" -ForegroundColor Cyan
    }
}

if (-not (Test-Path ".\.git")) {
    git init
    git branch -M main
    git remote add origin $repo
    Write-Host "Depot initialise." -ForegroundColor Cyan
}

git add .
git commit -m $msg
git push -u origin main

Write-Host ""
Write-Host "Pousse. Activez ensuite GitHub Pages :" -ForegroundColor Green
Write-Host "  Settings > Pages > Deploy from a branch > main / (root) > Save"
Write-Host "  URL : https://franfran120374-design.github.io/turf-sud/"
