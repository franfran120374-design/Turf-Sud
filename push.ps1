# ---------------------------------------------------------------
# Turf Sud - publication sur GitHub Pages
#   powershell -ExecutionPolicy Bypass -File .\push.ps1
#
# Le script se charge lui-meme de :
#   - nettoyer les artefacts de telechargement (files\, files.zip)
#   - ecrire un vrai .gitignore (Windows renomme souvent en "gitignore")
#   - se recaler sur le depot distant avant de publier
# ---------------------------------------------------------------
$repo    = "https://github.com/franfran120374-design/Turf-Sud.git"
$message = "Turf Sud v7 - simple place, base PMU, backtest Harville"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "git absent : https://git-scm.com/download/win" -ForegroundColor Red
    exit 1
}

# --- 1. nettoyage des artefacts de telechargement ---------------
# Telecharger plusieurs fichiers d'un coup cree un sous-dossier files\
# et un files.zip : ce sont des doublons, jamais du code a publier.
if (Test-Path ".\files\index.html") {
    if (-not (Test-Path ".\index.html")) {
        Write-Host "Fichiers trouves dans files\ : remontee a la racine" -ForegroundColor Yellow
        Move-Item ".\files\*" "." -Force
    }
}
foreach ($p in @(".\files", ".\files.zip", ".\gitignore")) {
    if (Test-Path $p) {
        git rm -r --cached --ignore-unmatch (Split-Path $p -Leaf) 2>$null | Out-Null
        Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "Supprime : $p" -ForegroundColor Yellow
    }
}

if (-not (Test-Path ".\index.html")) {
    Write-Host "index.html introuvable. Lancez le script depuis le dossier Turf-Sud." -ForegroundColor Red
    exit 1
}

# --- 2. .gitignore ecrit par le script ---------------------------
$ignore = @'
cache_pmu/
cache/
courses.json
stats_pmu.json
programmes.json
urls.txt
*.pdf
turf-sud-*.json
files/
files.zip
gitignore
__pycache__/
*.pyc
.venv/
venv/
.DS_Store
Thumbs.db
desktop.ini
'@
Set-Content -Path ".\.gitignore" -Value $ignore -Encoding UTF8
Write-Host ".gitignore ecrit" -ForegroundColor Cyan

# --- 3. depot et recalage sur le distant -------------------------
if (-not (Test-Path ".\.git")) { git init | Out-Null }
if (-not (git remote get-url origin 2>$null)) { git remote add origin $repo }

git fetch origin 2>$null
$branche = git rev-parse --abbrev-ref HEAD 2>$null
if (-not $branche -or $branche -eq "HEAD") { $branche = "master"; git checkout -b master 2>$null | Out-Null }
Write-Host "Branche : $branche" -ForegroundColor Cyan

# Le depot distant a peut-etre pris de l'avance. On repart de son
# sommet en gardant les fichiers locaux : un seul commit propre
# par-dessus, pas de conflit de fusion a resoudre a la main.
$distant = git rev-parse --verify "origin/$branche" 2>$null
if ($distant) {
    git reset --soft "origin/$branche" 2>$null | Out-Null
    Write-Host "Recale sur origin/$branche" -ForegroundColor Cyan
}

# --- 4. service worker -------------------------------------------
if (Test-Path ".\sw.js") {
    $sw = Get-Content .\sw.js -Raw
    if ($sw -match "turf-sud-v(\d+)") {
        $v = [int]$Matches[1] + 1
        Set-Content .\sw.js ($sw -replace "turf-sud-v\d+", "turf-sud-v$v") -NoNewline
        Write-Host "Service worker -> turf-sud-v$v" -ForegroundColor Cyan
    }
}

# --- 5. publication ----------------------------------------------
git add -A
$staged = git diff --cached --name-only
if (-not $staged) { Write-Host "Rien a publier." -ForegroundColor Yellow; exit 0 }
Write-Host ""
Write-Host "Fichiers publies :" -ForegroundColor Cyan
$staged | ForEach-Object { Write-Host "   $_" }
Write-Host ""

git commit -m $message | Out-Null
git push origin $branche

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Push refuse." -ForegroundColor Red
    Write-Host "  Authentification : collez un TOKEN comme mot de passe"
    Write-Host "  https://github.com/settings/tokens (classic, case 'repo')"
    exit 1
}

Write-Host ""
Write-Host "Publie sur $branche." -ForegroundColor Green
Write-Host "Settings > Pages > Deploy from a branch > $branche / (root) > Save"
Write-Host ""
Write-Host "   https://franfran120374-design.github.io/Turf-Sud/" -ForegroundColor Cyan
