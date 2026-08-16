# ---------------------------------------------------------------
# Turf Sud - publication sur GitHub Pages
#   powershell -ExecutionPolicy Bypass -File .\push.ps1
#
# Le script cree lui-meme le .gitignore : Windows refuse souvent de
# creer un fichier commencant par un point, et le telechargement le
# renomme en "gitignore" - auquel cas il ne filtre plus rien.
# ---------------------------------------------------------------
$repo    = "https://github.com/franfran120374-design/Turf-Sud.git"
$message = "Turf Sud v7 - simple place, base PMU, backtest Harville"

if (-not (Test-Path ".\index.html")) {
    Write-Host "index.html introuvable. Lancez le script depuis le dossier Turf-Sud." -ForegroundColor Red
    exit 1
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "git absent : https://git-scm.com/download/win" -ForegroundColor Red
    exit 1
}

# --- .gitignore ecrit par le script, jamais telecharge -----------
$ignore = @'
cache_pmu/
cache/
courses.json
stats_pmu.json
programmes.json
urls.txt
*.pdf
turf-sud-*.json
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

# --- depot -------------------------------------------------------
if (-not (Test-Path ".\.git")) {
    git init | Out-Null
    git remote add origin $repo
    git fetch origin 2>$null
}

# branche reelle du depot distant (master ou main selon la creation)
$branche = git rev-parse --abbrev-ref HEAD 2>$null
if (-not $branche -or $branche -eq "HEAD") { $branche = "master" }
Write-Host "Branche : $branche" -ForegroundColor Cyan

# supprime l'ancien fichier mal nomme s'il traine dans le depot
if (git ls-files --error-unmatch "gitignore" 2>$null) {
    git rm --cached "gitignore" | Out-Null
    Remove-Item ".\gitignore" -ErrorAction SilentlyContinue
    Write-Host "Ancien fichier 'gitignore' (sans point) retire du depot" -ForegroundColor Yellow
}

# --- service worker ---------------------------------------------
if (Test-Path ".\sw.js") {
    $sw = Get-Content .\sw.js -Raw
    if ($sw -match "turf-sud-v(\d+)") {
        $v = [int]$Matches[1] + 1
        Set-Content .\sw.js ($sw -replace "turf-sud-v\d+", "turf-sud-v$v") -NoNewline
        Write-Host "Service worker -> turf-sud-v$v" -ForegroundColor Cyan
    }
}

# --- publication -------------------------------------------------
git add -A
$staged = git diff --cached --name-only
if (-not $staged) { Write-Host "Rien a publier." -ForegroundColor Yellow; exit 0 }
Write-Host ""
Write-Host "Fichiers publies :" -ForegroundColor Cyan
$staged | ForEach-Object { Write-Host "   $_" }
Write-Host ""

git commit -m $message | Out-Null
git push -u origin $branche

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Push refuse. Causes habituelles :" -ForegroundColor Red
    Write-Host "  - Authentification : collez un TOKEN comme mot de passe"
    Write-Host "    https://github.com/settings/tokens (classic, case 'repo')"
    Write-Host "  - Historique divergent : git pull --rebase origin $branche"
    exit 1
}

Write-Host ""
Write-Host "Publie sur la branche $branche." -ForegroundColor Green
Write-Host "Settings > Pages > Deploy from a branch > $branche / (root) > Save"
Write-Host ""
Write-Host "   https://franfran120374-design.github.io/Turf-Sud/" -ForegroundColor Cyan
Write-Host "   (attention aux majuscules : l'URL est sensible a la casse)"
