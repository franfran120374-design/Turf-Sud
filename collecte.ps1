# ---------------------------------------------------------------
# Turf Sud - collecte PMU en une commande
#
#   powershell -ExecutionPolicy Bypass -File .\collecte.ps1
#
# Enchaine : verification -> test sur 7 jours -> collecte complete
#            -> statistiques -> export courses.json
# Empeche la mise en veille pendant toute la duree.
# ---------------------------------------------------------------
param(
    [string]$Debut   = "",          # par defaut : 2 ans en arriere
    [string]$Fin     = "",          # par defaut : hier
    [int]   $Workers = 3,
    [switch]$SansTest                # sauter l'essai sur 7 jours
)

$ErrorActionPreference = "Continue"
if (-not $Fin)   { $Fin   = (Get-Date).AddDays(-1).ToString("yyyy-MM-dd") }
if (-not $Debut) { $Debut = (Get-Date).AddYears(-2).ToString("yyyy-MM-dd") }

function Titre($t) {
    Write-Host ""
    Write-Host ("=" * 62) -ForegroundColor DarkGray
    Write-Host "  $t" -ForegroundColor Cyan
    Write-Host ("=" * 62) -ForegroundColor DarkGray
}

# --- 1. verifications -------------------------------------------
Titre "Verifications"
if (-not (Test-Path ".\collecte_pmu.py")) {
    Write-Host "collecte_pmu.py introuvable. Lancez depuis le dossier Turf-Sud." -ForegroundColor Red
    exit 1
}
$py = $null
foreach ($c in @("python", "py", "python3")) {
    if (Get-Command $c -ErrorAction SilentlyContinue) { $py = $c; break }
}
if (-not $py) {
    Write-Host "Python introuvable : https://www.python.org/downloads/" -ForegroundColor Red
    Write-Host "Cochez 'Add python.exe to PATH' pendant l'installation." -ForegroundColor Red
    exit 1
}
Write-Host "Python : $py  ($(& $py --version 2>&1))" -ForegroundColor Green

& $py -c "import requests" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installation de requests..." -ForegroundColor Yellow
    & $py -m pip install requests --quiet
}
Write-Host "requests : ok" -ForegroundColor Green
Write-Host "Periode  : $Debut  ->  $Fin"

# --- 2. essai sur 7 jours ---------------------------------------
if (-not $SansTest) {
    Titre "Essai sur 7 jours"
    Write-Host "But : verifier que tout fonctionne avant de lancer les heures." -ForegroundColor DarkGray
    $t0 = (Get-Date).AddDays(-8).ToString("yyyy-MM-dd")
    $t1 = (Get-Date).AddDays(-1).ToString("yyyy-MM-dd")
    & $py collecte_pmu.py collecter --debut $t0 --fin $t1 --workers $Workers
    & $py collecte_pmu.py stats --mini 5
    & $py collecte_pmu.py exporter --limite 500

    if (-not (Test-Path ".\courses.json")) {
        Write-Host "courses.json non genere : arret." -ForegroundColor Red
        exit 1
    }
    $mo = [math]::Round((Get-Item .\courses.json).Length / 1MB, 2)
    Write-Host ""
    Write-Host "Essai concluant. courses.json = $mo Mo" -ForegroundColor Green
    Write-Host ""
    Write-Host "IMPORTEZ-LE MAINTENANT dans l'appli (Reglages > Importer)," -ForegroundColor Yellow
    Write-Host "puis onglet Suivi > Rejouer l'historique." -ForegroundColor Yellow
    Write-Host "Si les chiffres s'affichent, la chaine complete fonctionne." -ForegroundColor Yellow
    Write-Host ""
    $r = Read-Host "Lancer la collecte complete ($Debut -> $Fin) ? (o/N)"
    if ($r -ne "o") {
        Write-Host "Arret. Relancez avec -SansTest quand vous serez pret." -ForegroundColor DarkGray
        exit 0
    }
}

# --- 3. collecte complete ---------------------------------------
Titre "Collecte complete"
Write-Host "Comptez 2 a 3 heures. Ctrl-C possible : la reprise est automatique." -ForegroundColor DarkGray
Write-Host "Mise en veille bloquee pendant la duree." -ForegroundColor DarkGray

# empeche la veille (SetThreadExecutionState)
$sig = @"
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
"@
try {
    $api = Add-Type -MemberDefinition $sig -Name Veille -Namespace Sys -PassThru
    $api::SetThreadExecutionState(0x80000003) | Out-Null   # CONTINUOUS|SYSTEM|DISPLAY
} catch { Write-Host "(veille non bloquee, verifiez vos parametres d'alimentation)" -ForegroundColor Yellow }

$chrono = [Diagnostics.Stopwatch]::StartNew()
& $py collecte_pmu.py collecter --debut $Debut --fin $Fin --workers $Workers
$chrono.Stop()

try { $api::SetThreadExecutionState(0x80000000) | Out-Null } catch {}
Write-Host ""
Write-Host ("Collecte terminee en {0:hh\:mm\:ss}" -f $chrono.Elapsed) -ForegroundColor Green

# --- 4. statistiques et export ----------------------------------
Titre "Taux de reussite drivers et entraineurs"
& $py collecte_pmu.py stats --mini 60

Titre "Export"
& $py collecte_pmu.py exporter --limite 4000

if (Test-Path ".\courses.json") {
    $mo = [math]::Round((Get-Item .\courses.json).Length / 1MB, 2)
    Write-Host ""
    Write-Host "courses.json : $mo Mo" -ForegroundColor Green
    if ($mo -gt 4) {
        Write-Host "Trop lourd pour le navigateur. Relancez :" -ForegroundColor Yellow
        Write-Host "  $py collecte_pmu.py exporter --limite 2000" -ForegroundColor Yellow
    }
}

# --- 5. mise en place pour l'appli -------------------------------
Titre "Publication de la base"
if (Test-Path ".\courses.json") {
    if (-not (Test-Path ".\data")) { New-Item -ItemType Directory -Path ".\data" | Out-Null }
    Copy-Item ".\courses.json" ".\data\courses.json" -Force
    Write-Host "data\courses.json en place" -ForegroundColor Green
    Write-Host ""
    $r = Read-Host "Publier maintenant sur GitHub ? (o/N)"
    if ($r -eq "o") {
        powershell -ExecutionPolicy Bypass -File .\push.ps1
    } else {
        Write-Host "Publiez plus tard avec : .\push.ps1" -ForegroundColor DarkGray
    }
}

Titre "Suite"
Write-Host "1. Ouvrez l'appli, onglet Suivi > Base d'entrainement > Charger"
Write-Host "   (plus d'import de fichier : la base est servie par le site)"
Write-Host "2. Rejouer l'historique"
Write-Host "3. Apprendre les poids"
Write-Host "4. Appliquer les poids SEULEMENT si le gain hors echantillon est positif"
Write-Host ""
Write-Host "stats_pmu.json contient les taux de place par driver et entraineur :"
Write-Host "ce sont les colonnes %driver, %driver_ici et %entraineur du collage."
