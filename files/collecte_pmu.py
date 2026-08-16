#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
collecte_pmu.py — constitution d'une base d'entraînement pour Turf Sud.

Source : API publique du PMU (offline.turfinfo.api.pmu.fr).
Gratuite, sans clé, sans inscription. Historique d'environ 3 ans.

    pip install requests
    python collecte_pmu.py estimer   --debut 2024-08-01 --fin 2026-08-15
    python collecte_pmu.py collecter --debut 2024-08-01 --fin 2026-08-15
    python collecte_pmu.py stats
    python collecte_pmu.py exporter

Puis dans Turf Sud : Réglages → Importer → courses.json

POURQUOI CE COLLECTEUR EXISTE
-----------------------------
Grenade tourne en PMH : ses réunions sont quasi absentes de l'API PMU
(vérifié — le 23/11/2025 Grenade n'y figure pas du tout, le 15/08/2026
une seule course sur sept, celle qui portait le Quarté).

L'objectif n'est donc PAS de récupérer Grenade ici. C'est d'entraîner le
modèle sur des milliers de courses aux variables identiques — musique,
gains, driver, cotes, arrivée — puis de l'appliquer à Grenade avec ses
multiplicateurs de piste propres. 37 courses n'entraînent pas 14 poids ;
3 000 oui.

L'étape `stats` calcule ce que l'API ne donne pas : les taux de réussite
par driver et par entraîneur, et les taux de place par hippodrome. Ces
chiffres ne sont calculables qu'à partir d'un gros volume — c'est la
vraie valeur ajoutée de la collecte.

REPRISE SUR ERREUR
------------------
Chaque course est mise en cache sur disque. Relancer `collecter` reprend
là où ça s'est arrêté sans rien retélécharger. Vous pouvez interrompre
avec Ctrl-C à tout moment.
"""

import argparse, json, os, sys, time, threading
from collections import defaultdict, Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

try:
    import requests
except ImportError:
    sys.exit("Dépendance manquante :\n    pip install requests")

API = "https://offline.turfinfo.api.pmu.fr/rest/client/1/programme"
UA = {"User-Agent": "Mozilla/5.0 (compatible; TurfSud/1.0; usage personnel)"}
CACHE = "cache_pmu"
SORTIE = "courses.json"
STATS = "stats_pmu.json"

DISCIPLINES = {
    "ATTELE": "trot_attele",
    "MONTE": "trot_monte",
    "PLAT": "plat",
    "OBSTACLE": "obstacle",
    "HAIE": "obstacle",
    "STEEPLE_CHASE": "obstacle",
    "CROSS": "obstacle",
}

_lock = threading.Lock()
_compteur = {"ok": 0, "cache": 0, "vide": 0, "erreur": 0}


# ----------------------------------------------------------------------
def get(url, essais=3):
    """GET avec retry exponentiel. Renvoie None sur échec définitif."""
    for i in range(essais):
        try:
            r = requests.get(url, headers=UA, timeout=25)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (404, 204):
                return None
        except Exception:
            pass
        time.sleep(1.5 * (i + 1))
    return None


def chemin(jour, r, c):
    d = os.path.join(CACHE, jour[:7])
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f"{jour}_R{r}C{c}.json")


def jours(debut, fin):
    d, f = date.fromisoformat(debut), date.fromisoformat(fin)
    while d <= f:
        yield d.isoformat()
        d += timedelta(days=1)


def fmt_date(jour):
    a, m, j = jour.split("-")
    return f"{j}{m}{a}"


# ----------------------------------------------------------------------
def programme_du_jour(jour, france_seulement=True):
    """Renvoie la liste (numReunion, numCourse, meta) d'une journée."""
    p = get(f"{API}/{fmt_date(jour)}")
    if not p or "programme" not in p:
        return []
    out = []
    for reu in p["programme"].get("reunions", []):
        hip = reu.get("hippodrome", {}) or {}
        pays = (reu.get("pays", {}) or {}).get("code", "FRA")
        if france_seulement and pays != "FRA":
            continue
        for co in reu.get("courses", []):
            spec = co.get("specialite") or ""
            out.append({
                "jour": jour,
                "r": reu.get("numOfficiel") or reu.get("numExterne"),
                "c": co.get("numOrdre") or co.get("numExterne"),
                "hippodrome": hip.get("libelleLong") or hip.get("libelleCourt") or "?",
                "code_hippo": hip.get("codeHippodrome"),
                "libelle": co.get("libelle") or co.get("libelleCourt") or "",
                "discipline": DISCIPLINES.get(spec, spec.lower() or "autre"),
                "specialite": spec,
                "distance": co.get("distance"),
                "corde": co.get("corde"),
                "categorie": co.get("categorieParticularite"),
                "montant": co.get("montantPrix"),
                "nb_declares": co.get("nombreDeclaresPartants"),
            })
    return out


def collecte_course(meta):
    """Télécharge participants + rapports d'une course, met en cache, renvoie le dict."""
    p = chemin(meta["jour"], meta["r"], meta["c"])
    if os.path.exists(p):
        with _lock:
            _compteur["cache"] += 1
        try:
            return json.load(open(p, encoding="utf-8"))
        except Exception:
            os.remove(p)

    base = f"{API}/{fmt_date(meta['jour'])}/R{meta['r']}/C{meta['c']}"
    part = get(f"{base}/participants")
    if not part or not part.get("participants"):
        with _lock:
            _compteur["vide"] += 1
        json.dump({"meta": meta, "partants": [], "vide": True},
                  open(p, "w", encoding="utf-8"))
        return None

    rap = get(f"{base}/rapports-definitifs") or []
    rapports_place, rapport_gagnant = {}, {}
    for pari in rap:
        if not isinstance(pari, dict):
            continue
        t = pari.get("typePari")
        if t not in ("SIMPLE_PLACE", "SIMPLE_GAGNANT"):
            continue
        cible = rapports_place if t == "SIMPLE_PLACE" else rapport_gagnant
        for z in pari.get("rapports", []) or []:
            comb = str(z.get("combinaison", "")).strip()
            div = z.get("dividendePourUnEuro")
            if comb and div:
                cible[comb] = round(div / 100, 2)   # centimes -> euros

    partants = []
    for x in part["participants"]:
        g = x.get("gainsParticipant") or {}
        nc = x.get("nombreCourses") or 0
        carriere = (g.get("gainsCarriere") or 0) / 100.0
        drd = x.get("dernierRapportDirect") or {}
        drr = x.get("dernierRapportReference") or {}
        num = str(x.get("numPmu"))
        partants.append({
            "num": num,
            "nom": x.get("nom"),
            "cote": drd.get("rapport") or drr.get("rapport"),
            "cotePlace": rapports_place.get(num),
            "musique": x.get("musique"),
            "driver": x.get("driver"),
            "entraineur": x.get("entraineur"),
            "age": x.get("age"),
            "sexe": x.get("sexe"),
            "gains": round(carriere / nc, 0) if nc else None,   # gains par course
            "gains_carriere": carriere,
            "courses": nc,
            "victoires": x.get("nombreVictoires"),
            "places": x.get("nombrePlaces"),
            "corde": x.get("placeCorde"),
            "poids": x.get("handicapPoids"),
            "valeur": x.get("handicapValeur"),
            "deferre": x.get("deferre"),
            "oeilleres": x.get("oeilleres"),
            "driverChange": x.get("driverChange"),
            "inedit": x.get("indicateurInedit"),
            "statut": x.get("statut"),
            "arrivee": x.get("ordreArrivee"),
        })

    arrivee = [q["num"] for q in sorted(
        (z for z in partants if z["arrivee"]), key=lambda z: z["arrivee"])]

    doc = {"meta": meta, "partants": partants, "arrivee": arrivee,
           "rapportsPlaceParNum": rapports_place, "rapportGagnant": rapport_gagnant}
    json.dump(doc, open(p, "w", encoding="utf-8"), ensure_ascii=False)
    with _lock:
        _compteur["ok"] += 1
    return doc


# ----------------------------------------------------------------------
def cmd_estimer(a):
    """Compte le volume avant de lancer, sur un échantillon d'une journée sur sept."""
    tous = list(jours(a.debut, a.fin))
    ech = tous[::7]
    print(f"Période : {a.debut} → {a.fin}  ({len(tous)} jours)")
    print(f"Sondage sur {len(ech)} journées (1 sur 7)…\n")
    n, disc = 0, Counter()
    for i, j in enumerate(ech, 1):
        cs = programme_du_jour(j, not a.monde)
        n += len(cs)
        disc.update(c["discipline"] for c in cs)
        print(f"\r  {i}/{len(ech)}  {j}  cumul {n} courses", end="")
        time.sleep(a.delai)
    moy = n / max(len(ech), 1)
    total = int(moy * len(tous))
    print(f"\n\nMoyenne : {moy:.1f} courses par jour")
    print(f"Estimation : ~{total} courses, soit ~{total * 2 + len(tous)} requêtes")
    print(f"Durée approximative avec {a.workers} threads : "
          f"~{(total * 2 + len(tous)) * a.delai / max(a.workers,1) / 3600:.1f} h")
    print("\nRépartition par discipline :")
    for d, c in disc.most_common():
        print(f"  {d:<14} {100*c/max(n,1):>5.1f} %")


def cmd_collecter(a):
    os.makedirs(CACHE, exist_ok=True)
    tous = list(jours(a.debut, a.fin))
    print(f"{len(tous)} journées à traiter. Ctrl-C possible à tout moment, "
          f"la reprise est automatique.\n")
    t0 = time.time()
    for i, j in enumerate(tous, 1):
        cs = programme_du_jour(j, not a.monde)
        if a.disciplines:
            cs = [c for c in cs if c["discipline"] in a.disciplines]
        if cs:
            with ThreadPoolExecutor(max_workers=a.workers) as ex:
                list(ex.map(collecte_course, cs))
        el = time.time() - t0
        reste = el / i * (len(tous) - i)
        print(f"\r[{i}/{len(tous)}] {j}  "
              f"ok {_compteur['ok']}  cache {_compteur['cache']}  "
              f"vides {_compteur['vide']}  |  reste ~{reste/60:.0f} min   ", end="")
        time.sleep(a.delai)
    print(f"\n\nTerminé. {_compteur['ok']} courses téléchargées, "
          f"{_compteur['cache']} déjà en cache.")
    print("Lancez maintenant :  python collecte_pmu.py stats")


def charger_cache():
    for racine, _, fichiers in os.walk(CACHE):
        for f in sorted(fichiers):
            if not f.endswith(".json"):
                continue
            try:
                d = json.load(open(os.path.join(racine, f), encoding="utf-8"))
            except Exception:
                continue
            if d.get("vide") or not d.get("partants"):
                continue
            yield d


def nb_places(n):
    return 3 if n >= 8 else (2 if n >= 4 else 0)


def cmd_stats(a):
    """Calcule ce que l'API ne fournit pas : taux de réussite par acteur.

    C'est l'intérêt principal du volume. Un taux de place calculé sur
    20 drives ne vaut rien ; sur 400 il devient un indicateur."""
    dr = defaultdict(lambda: [0, 0])      # driver -> [places, courses]
    en = defaultdict(lambda: [0, 0])
    hi = defaultdict(lambda: [0, 0])
    dr_hi = defaultdict(lambda: [0, 0])   # (driver, hippodrome)
    n_courses = 0

    for d in charger_cache():
        arr = d.get("arrivee") or []
        if not arr:
            continue
        n_courses += 1
        partants = [p for p in d["partants"] if p.get("statut") != "NON_PARTANT"]
        k = nb_places(len(partants))
        podium = set(arr[:k])
        hip = d["meta"]["hippodrome"]
        for p in partants:
            place = 1 if p["num"] in podium else 0
            if p.get("driver"):
                dr[p["driver"]][0] += place; dr[p["driver"]][1] += 1
                cle = (p["driver"], hip)
                dr_hi[cle][0] += place; dr_hi[cle][1] += 1
            if p.get("entraineur"):
                en[p["entraineur"]][0] += place; en[p["entraineur"]][1] += 1
        hi[hip][0] += len(podium); hi[hip][1] += len(partants)

    def taux(d, mini):
        return {k: {"places": v[0], "courses": v[1],
                    "taux": round(100 * v[0] / v[1], 1)}
                for k, v in d.items() if v[1] >= mini}

    out = {
        "courses_analysees": n_courses,
        "drivers": taux(dr, a.mini),
        "entraineurs": taux(en, a.mini),
        "hippodromes": taux(hi, 50),
        "drivers_par_hippodrome": {f"{k[0]} @ {k[1]}": v for k, v in
                                   taux(dr_hi, max(a.mini // 4, 15)).items()},
    }
    json.dump(out, open(STATS, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    print(f"{n_courses} courses avec arrivée exploitées → {STATS}\n")
    top = sorted(out["drivers"].items(), key=lambda x: -x[1]["taux"])[:15]
    print(f"Meilleurs taux de place (min. {a.mini} drives) :")
    for n, v in top:
        print(f"  {v['taux']:>5.1f} %   {v['courses']:>4} drives   {n}")
    print(f"\n{len(out['drivers'])} drivers et {len(out['entraineurs'])} entraîneurs retenus.")
    print("Ces taux alimentent les colonnes %driver et %entraîneur du collage.")


def cmd_exporter(a):
    """Écrit courses.json au format importable par Turf Sud."""
    stats = {}
    if os.path.exists(STATS):
        stats = json.load(open(STATS, encoding="utf-8"))
    td = stats.get("drivers", {})
    te = stats.get("entraineurs", {})
    tdh = stats.get("drivers_par_hippodrome", {})

    courses, n = [], 0
    for d in charger_cache():
        m = d["meta"]
        if a.disciplines and m["discipline"] not in a.disciplines:
            continue
        arr = d.get("arrivee") or []
        if a.avec_arrivee and not arr:
            continue
        partants = [p for p in d["partants"] if p.get("statut") != "NON_PARTANT"]
        if len(partants) < 4:
            continue
        hip = m["hippodrome"]
        out = []
        for p in partants:
            drv = td.get(p.get("driver") or "", {})
            ent = te.get(p.get("entraineur") or "", {})
            loc = tdh.get(f"{p.get('driver')} @ {hip}", {})
            out.append({
                "num": p["num"], "nom": p["nom"], "cote": p["cote"],
                "cotePlace": p["cotePlace"], "musique": p["musique"],
                "driver": drv.get("taux"), "driverLocal": loc.get("taux"),
                "entraineur": ent.get("taux"), "gains": p["gains"],
                "age": p["age"], "corde": p["corde"], "poids": p["poids"],
                "deferre": p["deferre"], "vitesse": p["valeur"],
            })
        courses.append({
            "date": m["jour"], "piste": "pmu", "hippodrome": hip,
            "nom": m["libelle"], "discipline": m["discipline"],
            "distance": m["distance"], "partants": out,
            "arrivee": arr,
            "rapportsPlace": [d["rapportsPlaceParNum"].get(x) for x in arr[:nb_places(len(partants))]],
        })
        n += 1

    # les plus récentes d'abord, puis coupe : le navigateur ne digère pas 100 Mo
    courses.sort(key=lambda c: c["date"], reverse=True)
    if a.limite and len(courses) > a.limite:
        print(f"{len(courses)} courses disponibles, limitées aux {a.limite} plus récentes.")
        courses = courses[:a.limite]
        n = len(courses)
    for c in courses:                       # allègement : on retire les champs vides
        c["partants"] = [{k: v for k, v in p.items() if v is not None} for p in c["partants"]]

    json.dump({"source": "collecte_pmu.py", "courses": courses},
              open(SORTIE, "w", encoding="utf-8"), ensure_ascii=False)
    taille = os.path.getsize(SORTIE) / 1e6
    print(f"{n} courses écrites dans {SORTIE} ({taille:.1f} Mo)")
    if taille > 4:
        print("\nAttention : au-delà de ~4 Mo, l'import dans le navigateur peut échouer")
        print("(quota localStorage). Relancez avec --disciplines trot_attele,")
        print("ou avec --limite pour ne garder que les N plus récentes.")
    print("\nDans Turf Sud : Réglages → Importer → courses.json, puis onglet Suivi →")
    print("« Rejouer l'historique », puis « Apprendre les poids ».")


# ----------------------------------------------------------------------
def main():
    # options communes, acceptées avant OU après la sous-commande
    commun = argparse.ArgumentParser(add_help=False)
    commun.add_argument("--delai", type=float, default=0.35, help="pause entre requêtes (s)")
    commun.add_argument("--workers", type=int, default=3, help="téléchargements simultanés")
    commun.add_argument("--monde", action="store_true", help="inclure les hippodromes étrangers")
    commun.add_argument("--disciplines", type=lambda s: set(s.split(",")), default=None,
                        help="filtrer, ex : trot_attele,trot_monte")

    ap = argparse.ArgumentParser(description="Collecteur PMU pour Turf Sud",
                                 parents=[commun])
    sub = ap.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("estimer", parents=[commun], help="volume et durée avant de lancer")
    e.add_argument("--debut", required=True); e.add_argument("--fin", required=True)
    e.set_defaults(func=cmd_estimer)

    c = sub.add_parser("collecter", parents=[commun], help="télécharger (reprise automatique)")
    c.add_argument("--debut", required=True); c.add_argument("--fin", required=True)
    c.set_defaults(func=cmd_collecter)

    s = sub.add_parser("stats", parents=[commun], help="taux de réussite drivers / entraîneurs")
    s.add_argument("--mini", type=int, default=60, help="drives minimum pour retenir un acteur")
    s.set_defaults(func=cmd_stats)

    x = sub.add_parser("exporter", parents=[commun], help="écrire courses.json")
    x.add_argument("--avec-arrivee", action="store_true", default=True)
    x.add_argument("--limite", type=int, default=4000,
                   help="nombre maximum de courses exportées, les plus récentes")
    x.set_defaults(func=cmd_exporter)

    a = ap.parse_args()
    try:
        a.func(a)
    except KeyboardInterrupt:
        print("\n\nInterrompu. Le cache est conservé : relancez la même commande "
              "pour reprendre où vous en étiez.")


if __name__ == "__main__":
    main()
