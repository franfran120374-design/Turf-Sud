#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
jour.py — prépare les réunions du jour pour Turf Sud.

    python jour.py                    # aujourd'hui
    python jour.py --date 2026-08-20
    python jour.py --monde            # inclure l'étranger
    python jour.py --push             # publier dans la foulée

Écrit data/jour.json. Dans l'appli : onglet Course → piste « Ailleurs »
→ Réunions du jour → choisir → Charger cette course.

POURQUOI CE FICHIER EXISTE
--------------------------
L'API PMU refuse les appels venant d'un navigateur : elle renvoie 403
dès qu'un en-tête Origin est présent (vérifié, y compris sur le
preflight OPTIONS). Impossible donc de l'interroger depuis GitHub
Pages. Ce script fait l'appel côté PC, où il n'y a pas de CORS, et
dépose le résultat à côté de l'appli.

CE QUE ÇA CHANGE
----------------
Plus rien à saisir à la main : partants, cotes, musiques, gains, âge,
corde et poids arrivent remplis. Et les taux de réussite des drivers et
entraîneurs sont injectés depuis stats_pmu.json si vous l'avez généré.

Grenade ne tourne que 9 fois par an. En attendant, ça permet de tester
le modèle sur les 30 à 50 courses quotidiennes du réseau PMU.
"""

import argparse, json, os, subprocess, sys, time
from datetime import date

try:
    import requests
except ImportError:
    sys.exit("pip install requests")

API = "https://offline.turfinfo.api.pmu.fr/rest/client/1/programme"
UA = {"User-Agent": "Mozilla/5.0 (compatible; TurfSud/1.0; usage personnel)"}
SORTIE = os.path.join("data", "jour.json")
STATS = "stats_pmu.json"

DISCIPLINES = {
    "ATTELE": "trot_attele", "TROT_ATTELE": "trot_attele",
    "MONTE": "trot_monte", "TROT_MONTE": "trot_monte",
    "PLAT": "plat",
    "OBSTACLE": "obstacle", "HAIE": "obstacle",
    "STEEPLE_CHASE": "obstacle", "CROSS": "obstacle",
}


DEFERRE = {"DEFERRE_ANTERIEURS": 1, "DEFERRE_POSTERIEURS": 2,
           "DEFERRE_ANTERIEURS_POSTERIEURS": 3}


def get(url, essais=3):
    for i in range(essais):
        try:
            r = requests.get(url, headers=UA, timeout=25)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (404, 204):
                return None
        except Exception:
            pass
        time.sleep(1.2 * (i + 1))
    return None


def charger_stats():
    """Taux de réussite calculés par collecte_pmu.py stats."""
    if not os.path.exists(STATS):
        print("  (stats_pmu.json absent : colonnes %driver et %entraineur vides)")
        return {}, {}, {}
    d = json.load(open(STATS, encoding="utf-8"))
    print(f"  stats : {len(d.get('drivers', {}))} drivers, "
          f"{len(d.get('entraineurs', {}))} entraîneurs")
    return d.get("drivers", {}), d.get("entraineurs", {}), d.get("drivers_par_hippodrome", {})


def main():
    ap = argparse.ArgumentParser(description="Réunions du jour pour Turf Sud")
    ap.add_argument("--date", default=date.today().isoformat(), help="AAAA-MM-JJ")
    ap.add_argument("--monde", action="store_true", help="inclure les hippodromes étrangers")
    ap.add_argument("--push", action="store_true", help="publier avec push.ps1 ensuite")
    a = ap.parse_args()

    a_, m_, j_ = a.date.split("-")
    jour_api = f"{j_}{m_}{a_}"

    print(f"Programme du {a.date}")
    prog = get(f"{API}/{jour_api}")
    if not prog or "programme" not in prog:
        sys.exit("Programme indisponible pour cette date.")

    td, te, tdh = charger_stats()
    reunions, total = [], 0

    for reu in prog["programme"].get("reunions", []):
        pays = (reu.get("pays") or {}).get("code", "FRA")
        if not a.monde and pays != "FRA":
            continue
        hip = (reu.get("hippodrome") or {})
        nom_hip = hip.get("libelleLong") or hip.get("libelleCourt") or "?"
        numR = reu.get("numOfficiel") or reu.get("numExterne")
        courses = []

        for co in reu.get("courses", []):
            numC = co.get("numOrdre") or co.get("numExterne")
            part = get(f"{API}/{jour_api}/R{numR}/C{numC}/participants")
            time.sleep(0.25)
            if not part or not part.get("participants"):
                continue

            partants = []
            for x in part["participants"]:
                if x.get("statut") == "NON_PARTANT":
                    continue
                g = x.get("gainsParticipant") or {}
                nc = x.get("nombreCourses") or 0
                carriere = (g.get("gainsCarriere") or 0) / 100.0
                drd = x.get("dernierRapportDirect") or {}
                drr = x.get("dernierRapportReference") or {}
                drv = x.get("driver") or ""
                ent = x.get("entraineur") or ""
                partants.append({
                    "num": str(x.get("numPmu")),
                    "nom": x.get("nom"),
                    "cote": drd.get("rapport") or drr.get("rapport"),
                    "cotePlace": None,          # rapport probable placé : non exposé par l'API
                    "musique": x.get("musique"),
                    "driver": (td.get(drv) or {}).get("taux"),
                    "driverLocal": (tdh.get(f"{drv} @ {nom_hip}") or {}).get("taux"),
                    "entraineur": (te.get(ent) or {}).get("taux"),
                    "gains": round(carriere / nc) if nc else None,
                    "vitesse": x.get("handicapValeur"),
                    "recul": None,
                    "deferre": DEFERRE.get(x.get("deferre") or "", 0),
                    "jours": None,
                    "age": x.get("age"),
                    "aptPiste": None,
                    "corde": x.get("placeCorde"),
                    "poids": x.get("handicapPoids"),
                    "_driver_nom": drv,
                })

            if len(partants) < 4:
                continue
            courses.append({
                "c": numC,
                "libelle": co.get("libelle") or co.get("libelleCourt") or f"Course {numC}",
                "discipline": DISCIPLINES.get(co.get("specialite") or "", "trot_attele"),
                "distance": co.get("distance"),
                "heure": co.get("heureDepart"),
                "partants": partants,
            })
            total += 1

        if courses:
            reunions.append({"r": numR, "hippodrome": nom_hip, "courses": courses})
            disc = {c["discipline"] for c in courses}
            print(f"  R{numR} {nom_hip[:34]:<34} {len(courses)} courses  {','.join(sorted(disc))}")

    if not reunions:
        sys.exit("Aucune réunion exploitable.")

    os.makedirs("data", exist_ok=True)
    json.dump({"date": a.date, "reunions": reunions},
              open(SORTIE, "w", encoding="utf-8"), ensure_ascii=False)
    ko = os.path.getsize(SORTIE) / 1024
    print(f"\n{len(reunions)} réunions, {total} courses → {SORTIE} ({ko:.0f} Ko)")

    if a.push and os.path.exists("push.ps1"):
        print("\nPublication…")
        subprocess.run(["powershell", "-ExecutionPolicy", "Bypass", "-File", "./push.ps1"])
    else:
        print("Publiez avec : .\\push.ps1")
    print("\nDans l'appli : piste « Ailleurs » → Réunions du jour → Actualiser")


if __name__ == "__main__":
    main()
