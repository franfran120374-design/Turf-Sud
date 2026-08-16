#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
collecte.py — constitution d'un historique de courses pour Turf Sud.

Objectif : produire un fichier courses.json importable dans l'appli,
contenant pour chaque course les partants, les cotes, l'arrivée et les
rapports placés.

Trois étapes séparées, chacune relançable :

    python collecte.py discover --debut 2023-01-01 --fin 2026-08-16
    python collecte.py fetch
    python collecte.py parse --dry-run
    python collecte.py parse

Le cache HTML est conservé dans ./cache/ : relancer parse ne retélécharge
rien. C'est volontaire — on itère sur le parseur, pas sur le réseau.

AVERTISSEMENT HONNÊTE
---------------------
Les sites de turf changent leur balisage régulièrement et leurs CGU
restreignent souvent l'extraction automatisée. Ce script est écrit pour
un usage personnel, à faible cadence (1 requête / 2 s), et il faudra
presque certainement ajuster les sélecteurs dans PARSEURS ci-dessous.
Lancez `parse --dry-run` sur une seule course et regardez la sortie
avant de traiter les 40.
"""

import argparse, json, os, re, sys, time, hashlib
from datetime import date, timedelta

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit("Dépendances manquantes :\n    pip install requests beautifulsoup4 lxml")

CACHE = "cache"
URLS_FILE = "urls.txt"
SORTIE = "courses.json"
UA = "Mozilla/5.0 (compatible; TurfSud/1.0; usage personnel)"
DELAI = 2.0

HIPPODROMES = {
    "grenade": ["grenade-sur-garonne", "grenade sur garonne"],
    "carcassonne": ["carcassonne"],
}


# ----------------------------------------------------------------------
# Utilitaires
# ----------------------------------------------------------------------
def chemin_cache(url):
    os.makedirs(CACHE, exist_ok=True)
    return os.path.join(CACHE, hashlib.md5(url.encode()).hexdigest() + ".html")


def telecharger(url, force=False):
    """Télécharge une page, avec cache disque et délai de politesse."""
    p = chemin_cache(url)
    if os.path.exists(p) and not force:
        return open(p, encoding="utf-8", errors="ignore").read()
    time.sleep(DELAI)
    r = requests.get(url, headers={"User-Agent": UA}, timeout=25)
    r.raise_for_status()
    r.encoding = r.apparent_encoding or "utf-8"
    open(p, "w", encoding="utf-8").write(r.text)
    return r.text


def nombre(txt):
    if txt is None:
        return None
    m = re.search(r"(\d+(?:[.,]\d+)?)", str(txt).replace("\u00a0", " "))
    return float(m.group(1).replace(",", ".")) if m else None


# ----------------------------------------------------------------------
# 1. discover — repérer les réunions
# ----------------------------------------------------------------------
def discover(args):
    """Parcourt les programmes quotidiens et note les URLs de courses
    des hippodromes ciblés. Grenade ne tourne que ~9 jours par an :
    on balaie les jours, on ne trouve presque rien, c'est normal."""
    d0 = date.fromisoformat(args.debut)
    d1 = date.fromisoformat(args.fin)
    cibles = HIPPODROMES[args.hippodrome]
    trouves = []
    jour = d0
    while jour <= d1:
        url = f"https://www.geny.com/programme/{jour.isoformat()}"
        try:
            html = telecharger(url)
        except Exception as e:
            print(f"  {jour} — échec ({e})")
            jour += timedelta(days=1)
            continue
        soup = BeautifulSoup(html, "lxml")
        texte = soup.get_text(" ", strip=True).lower()
        if any(c in texte for c in cibles):
            liens = [a["href"] for a in soup.find_all("a", href=True)
                     if "/course/" in a["href"]]
            liens = sorted(set("https://www.geny.com" + l if l.startswith("/") else l
                               for l in liens))
            print(f"  {jour} — réunion détectée, {len(liens)} liens de course")
            trouves += [(jour.isoformat(), l) for l in liens]
        jour += timedelta(days=1)

    # Attention : le programme du jour liste TOUTES les réunions.
    # L'étape parse filtre ensuite sur le nom de l'hippodrome réellement
    # présent dans la page de course.
    with open(URLS_FILE, "a", encoding="utf-8") as f:
        for j, l in trouves:
            f.write(f"{j}\t{args.hippodrome}\t{l}\n")
    print(f"\n{len(trouves)} URLs candidates ajoutées à {URLS_FILE}")
    print("Filtrage définitif à l'étape parse.")


# ----------------------------------------------------------------------
# 2. fetch — télécharger les pages de course
# ----------------------------------------------------------------------
def fetch(args):
    if not os.path.exists(URLS_FILE):
        sys.exit(f"{URLS_FILE} absent — lancez d'abord `discover`.")
    lignes = [l.strip().split("\t") for l in open(URLS_FILE, encoding="utf-8") if l.strip()]
    print(f"{len(lignes)} pages à récupérer (cache réutilisé si déjà présent)")
    for i, (jour, hippo, url) in enumerate(lignes, 1):
        try:
            telecharger(url, force=args.force)
            print(f"  [{i}/{len(lignes)}] ok  {url}")
        except Exception as e:
            print(f"  [{i}/{len(lignes)}] ÉCHEC {url} — {e}")


# ----------------------------------------------------------------------
# 3. parse — extraire les données
# ----------------------------------------------------------------------
def parser_course(html, jour, hippo):
    """Extraction tolérante. C'est ICI qu'il faudra ajuster si le
    balisage a changé : lancez `parse --dry-run` et comparez."""
    soup = BeautifulSoup(html, "lxml")
    texte = soup.get_text(" ", strip=True)

    # L'hippodrome doit apparaître dans la page, sinon on rejette
    if not any(c in texte.lower() for c in HIPPODROMES[hippo]):
        return None

    course = {
        "date": jour,
        "piste": hippo,
        "nom": None,
        "discipline": "trot_attele",
        "distance": None,
        "partants": [],
        "arrivee": None,
        "rapportsPlace": None,
    }

    h1 = soup.find(["h1", "h2"])
    if h1:
        course["nom"] = h1.get_text(" ", strip=True)[:80]

    m = re.search(r"(\d[\s.]?\d{3})\s*m(?:ètres)?\b", texte)
    if m:
        course["distance"] = int(re.sub(r"\D", "", m.group(1)))

    if re.search(r"trot\s+mont", texte, re.I):
        course["discipline"] = "trot_monte"
    elif re.search(r"\bhaies?|steeple|obstacle", texte, re.I):
        course["discipline"] = "obstacle"
    elif re.search(r"\bplat\b", texte, re.I) and not re.search(r"trot", texte, re.I):
        course["discipline"] = "plat"

    # --- arrivée : suite de numéros séparés par des tirets ---
    m = re.search(r"[Aa]rriv[ée]e\D{0,40}?((?:\d{1,2}\s*[-–]\s*){2,6}\d{1,2})", texte)
    if m:
        course["arrivee"] = [x.strip() for x in re.split(r"[-–]", m.group(1)) if x.strip()]

    # --- partants : on cherche le tableau le plus riche en lignes ---
    meilleur, score = None, 0
    for tbl in soup.find_all("table"):
        lignes = tbl.find_all("tr")
        if len(lignes) > score:
            meilleur, score = tbl, len(lignes)

    if meilleur:
        for tr in meilleur.find_all("tr"):
            cells = [td.get_text(" ", strip=True) for td in tr.find_all(["td", "th"])]
            if len(cells) < 3:
                continue
            num = nombre(cells[0])
            if num is None or num > 25:
                continue
            nom = next((c for c in cells[1:4] if re.search(r"[A-Za-zÀ-ÿ]{3,}", c)), None)
            if not nom:
                continue
            cote = next((nombre(c) for c in cells[2:]
                         if re.fullmatch(r"\s*\d{1,3}[.,]\d\s*", c or "")), None)
            musique = next((c for c in cells if re.fullmatch(r"[\dDATRa-z\s()]{6,}", c or "")
                            and re.search(r"[amh]", c or "")), None)
            course["partants"].append({
                "num": str(int(num)),
                "nom": nom.upper()[:40],
                "cote": cote,
                "cotePlace": None,
                "musique": musique,
            })

    return course if course["partants"] else None


def parse(args):
    if not os.path.exists(URLS_FILE):
        sys.exit(f"{URLS_FILE} absent — lancez d'abord `discover`.")
    lignes = [l.strip().split("\t") for l in open(URLS_FILE, encoding="utf-8") if l.strip()]
    if args.dry_run:
        lignes = lignes[: args.limite]

    courses, rejets = [], 0
    for jour, hippo, url in lignes:
        p = chemin_cache(url)
        if not os.path.exists(p):
            continue
        html = open(p, encoding="utf-8", errors="ignore").read()
        try:
            c = parser_course(html, jour, hippo)
        except Exception as e:
            print(f"  erreur de parsing {url} : {e}")
            c = None
        if c is None:
            rejets += 1
            continue
        courses.append(c)
        if args.dry_run:
            print("\n" + "=" * 60)
            print(f"{c['date']}  {c['nom']}  ({c['distance']} m, {c['discipline']})")
            print(f"arrivée : {c['arrivee']}")
            for p_ in c["partants"][:6]:
                print(f"   {p_['num']:>2}  {p_['nom']:<26} cote={p_['cote']}  musique={p_['musique']}")
            print(f"   ... {len(c['partants'])} partants au total")

    print(f"\n{len(courses)} courses exploitables, {rejets} pages rejetées")
    if args.dry_run:
        print("\nDry-run : rien n'a été écrit.")
        print("Si les colonnes sont décalées ou vides, ajustez parser_course().")
        return

    json.dump({"source": "collecte.py", "courses": courses},
              open(SORTIE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"→ {SORTIE} écrit. Importez-le dans Turf Sud : Réglages → Importer.")



# ----------------------------------------------------------------------
# Météo — Open-Meteo archive : gratuit, sans clé, sans restriction d'usage.
# Le cumul de pluie sur 48 h avant la réunion sert à déduire l'état du
# terrain. L'herbe de Carcassonne encaisse environ deux fois moins bien
# que le sable de Grenade : le seuil est ajusté en conséquence.
# ----------------------------------------------------------------------
COORDS = {
    "grenade": (43.79, 1.29, "sable"),
    "carcassonne": (43.22, 2.37, "herbe"),
}


def meteo_jour(hippo, jour):
    lat, lon, surface = COORDS[hippo]
    d = date.fromisoformat(jour)
    d0 = (d - timedelta(days=2)).isoformat()
    url = ("https://archive-api.open-meteo.com/v1/archive"
           f"?latitude={lat}&longitude={lon}&start_date={d0}&end_date={jour}"
           "&daily=precipitation_sum,temperature_2m_max,windspeed_10m_max"
           "&timezone=Europe/Paris")
    try:
        o = json.loads(telecharger(url))
        dd = o["daily"]
        cumul = sum(x or 0 for x in dd["precipitation_sum"])
        eff = cumul / 2 if surface == "sable" else cumul
        terrain = ("lourd" if eff >= 30 else "collant" if eff >= 15
                   else "souple" if eff >= 5 else "bon")
        return {
            "pluie48h": round(cumul, 1),
            "temperature": dd["temperature_2m_max"][-1],
            "vent": dd["windspeed_10m_max"][-1],
            "terrain": terrain,
            "surface": surface,
        }
    except Exception as e:
        print(f"  météo indisponible pour {jour} : {e}")
        return None


def meteo(args):
    """Enrichit courses.json avec la météo de chaque date de réunion.
    Une seule requête par date, pas par course."""
    if not os.path.exists(SORTIE):
        sys.exit(f"{SORTIE} absent — lancez d'abord `parse`.")
    data = json.load(open(SORTIE, encoding="utf-8"))
    cache_jour = {}
    for c in data["courses"]:
        cle = (c["piste"], c["date"])
        if cle not in cache_jour:
            cache_jour[cle] = meteo_jour(c["piste"], c["date"])
            m = cache_jour[cle]
            if m:
                print(f"  {c['date']} {c['piste']:<12} {m['pluie48h']:>5} mm  "
                      f"{m['temperature']:>5} C  vent {m['vent']:>5} km/h  -> {m['terrain']}")
        if cache_jour[cle]:
            c.update(cache_jour[cle])
    json.dump(data, open(SORTIE, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"\n{len(cache_jour)} journées enrichies dans {SORTIE}")


# ----------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Collecte d'historique pour Turf Sud")
    sub = ap.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("discover", help="repérer les réunions sur une période")
    d.add_argument("--debut", required=True, help="AAAA-MM-JJ")
    d.add_argument("--fin", required=True, help="AAAA-MM-JJ")
    d.add_argument("--hippodrome", default="grenade", choices=list(HIPPODROMES))
    d.set_defaults(func=discover)

    f = sub.add_parser("fetch", help="télécharger les pages de course")
    f.add_argument("--force", action="store_true", help="ignorer le cache")
    f.set_defaults(func=fetch)

    p = sub.add_parser("parse", help="extraire les données vers courses.json")
    p.add_argument("--dry-run", action="store_true", help="afficher sans écrire")
    p.add_argument("--limite", type=int, default=3, help="nb de courses en dry-run")
    p.set_defaults(func=parse)

    m = sub.add_parser("meteo", help="enrichir courses.json avec la meteo historique")
    m.set_defaults(func=meteo)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
