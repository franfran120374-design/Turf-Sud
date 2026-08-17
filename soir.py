#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
soir.py — la routine du soir, sans vous.

    python soir.py                 # journée d'aujourd'hui
    python soir.py --date 2026-08-15
    python soir.py --push          # publie dans la foulée
    python soir.py --jours 3       # rattrape les 3 derniers jours

Ce que fait le script, dans l'ordre :

  1. télécharge les courses du jour avec leurs arrivées
  2. recalcule les taux de réussite drivers / entraîneurs
  3. réapprend les poids du modèle sur l'ensemble de la base
  4. mesure le résultat SUR DES COURSES JAMAIS VUES pendant l'ajustement
  5. n'écrit les nouveaux poids que s'ils sont meilleurs hors échantillon
  6. écrit un journal dans historique_modele.csv

C'est la boucle d'apprentissage. Elle tourne seule, tous les soirs,
via le Planificateur de tâches Windows :

  schtasks /create /tn "Turf Sud soir" /tr ^
    "powershell -WindowStyle Hidden -Command \"cd 'C:\\Users\\Admin\\Documents\\Turf-Sud'; python soir.py --push\"" ^
    /sc daily /st 22:30

GARDE-FOU
---------
Le découpage entraînement / test est CHRONOLOGIQUE : on apprend sur le
passé, on vérifie sur ce qui vient après. Jamais au hasard — un tirage
aléatoire laisserait fuiter l'avenir dans l'entraînement et donnerait
des résultats flatteurs et faux.

Si les nouveaux poids ne font pas mieux hors échantillon, ils sont
REFUSÉS et les anciens restent. Un modèle qui n'apprend rien un soir
donné, c'est normal. Un modèle qui se dégrade en silence, non.
"""

import argparse, csv, json, math, os, sys, time
from collections import defaultdict
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import collecte_pmu as C
except ImportError:
    sys.exit("collecte_pmu.py doit être dans le même dossier.")

POIDS_FICHIER = os.path.join("data", "poids.json")
JOURNAL = "historique_modele.csv"

# ----------------------------------------------------------------------
# Le modèle, porté depuis l'appli. Toute modification ici doit être
# répercutée dans index.html, et réciproquement.
# ----------------------------------------------------------------------
CRITERES = {
    "forme": 18, "regularite": 20, "fautes": 12, "driver": 10,
    "driverLocal": 8, "entraineur": 7, "gains": 11, "vitesse": 8,
    "progression": 8, "recul": 9, "deferre": 6, "fraicheur": 6,
    "age": 5, "aptPiste": 7, "corde": 7, "poids": 7,
}
TROT_SEUL = {"fautes", "recul", "deferre"}
PLAT_SEUL = {"corde", "poids"}

NOTE = [0, 100, 88, 78, 54, 44, 36, 29, 23, 18, 14]


def lire_musique(m):
    """Forme, régularité, fautes et tendance, extraites d'une seule chaîne.

    Les (25) sont des séparateurs d'année, pas des places : les laisser
    passer revenait à infliger une 25e place au cheval, et d'autant plus
    souvent qu'il avait du passé."""
    vide = (None, None, None, None)
    if not m:
        return vide
    import re
    net = re.sub(r"\(\s*\d+\s*\)", " ", str(m).upper())
    tok = re.findall(r"(?:\d{1,2}|D|A|T|R)[AMHSPC]?", net)
    if not tok:
        return vide

    def note(t):
        c = t[0]
        if c in "DATR" and not c.isdigit():
            return 0
        try:
            p = int("".join(ch for ch in t if ch.isdigit()))
        except ValueError:
            return 0
        if p == 0:
            return 8
        return NOTE[min(p, 10)]

    L = tok[:8]
    s = w = pl = f = 0.0
    for i, t in enumerate(L):
        d = 0.78 ** i
        s += note(t) * d
        w += d
        num = "".join(ch for ch in t if ch.isdigit())
        if num and 1 <= int(num) <= 3:
            pl += 1
        if not num and t[0] in "DATR":
            f += 1
    moy = lambda a: (sum(note(x) for x in a) / len(a)) if a else None
    rec, anc = moy(L[:2]), moy(L[2:5])
    return (s / w, 100 * pl / len(L), -100 * f / len(L),
            (rec - anc) if (rec is not None and anc is not None) else None)


def valeur(p, k, dist):
    mu = lire_musique(p.get("musique"))
    n = lambda v: float(v) if v not in (None, "") else None
    try:
        if k == "forme":       return mu[0]
        if k == "regularite":  return mu[1]
        if k == "fautes":      return mu[2]
        if k == "progression": return mu[3]
        if k in ("driver", "driverLocal", "entraineur"): return n(p.get(k))
        if k == "gains":
            g = n(p.get("gains"));  return None if g is None else math.log10(max(g, 50))
        if k == "vitesse":
            v = n(p.get("vitesse")); return None if v is None else (-v if v > 30 else v)
        if k == "recul":
            r = n(p.get("recul"));  return None if r is None else -r / max(dist, 1000) * 1000
        if k == "deferre":
            d = n(p.get("deferre"))
            return None if d is None else [0, 1.8, 1.2, 2.6][min(max(int(d), 0), 3)]
        if k == "fraicheur":
            j = n(p.get("jours")); return None if j is None else -abs(math.log(max(j, 1) / 22))
        if k == "age":
            a = n(p.get("age"));   return None if a is None else -((a - 6.5) / 2.6) ** 2
        if k == "aptPiste":
            a = n(p.get("aptPiste")); return None if a is None else min(a, 4)
        if k == "corde":
            c = n(p.get("corde")); return None if c is None else -c
        if k == "poids":
            w = n(p.get("poids")); return None if w is None else -w
    except (TypeError, ValueError):
        return None
    return None


def probabilites(partants, dist, disc, poids, lam=0.40, temp=1.2):
    trot = str(disc).startswith("trot")
    crits = [k for k in poids
             if not (k in TROT_SEUL and not trot) and not (k in PLAT_SEUL and trot)]
    n = len(partants)
    logit = [0.0] * n
    for k in crits:
        vals = [valeur(p, k, dist) for p in partants]
        ok = [v for v in vals if v is not None]
        if len(ok) < 2:
            continue
        m = sum(ok) / len(ok)
        sd = math.sqrt(sum((x - m) ** 2 for x in ok) / len(ok))
        if sd == 0:
            continue
        for i, v in enumerate(vals):
            if v is not None:
                logit[i] += poids[k] / 100 * max(-2.5, min(2.5, (v - m) / sd))

    T = max(temp, 0.1)
    mx = max(logit)
    ex = [math.exp((l - mx) / T) for l in logit]
    se = sum(ex)
    pm = [e / se for e in ex]

    inv = []
    for p in partants:
        c = p.get("cote")
        inv.append(1 / c if (c and c > 1) else None)
    dispo = [v for v in inv if v is not None]
    if len(dispo) >= max(3, n - 2):
        si = sum(dispo)
        marche = [(v / si if v is not None else None) for v in inv]
        mix = [(pm[i] if marche[i] is None
                else pm[i] ** lam * marche[i] ** (1 - lam)) for i in range(n)]
    else:
        marche, mix = [None] * n, pm[:]
    sm = sum(mix)
    return [v / sm for v in mix], marche


def harville(p, k):
    """Probabilité de finir dans les k premiers. Exact, déterministe."""
    n = len(p)
    res = []
    for i in range(n):
        s = p[i]
        if k >= 2:
            for j in range(n):
                if j == i:
                    continue
                d1 = 1 - p[j]
                if d1 <= 1e-9:
                    continue
                s += p[j] * p[i] / d1
                if k >= 3:
                    for l in range(n):
                        if l in (i, j):
                            continue
                        d2 = 1 - p[j] - p[l]
                        if d2 <= 1e-9:
                            continue
                        s += p[j] * (p[l] / d1) * (p[i] / d2)
        res.append(min(1.0, s))
    return res


def nb_places(n):
    return 3 if n >= 8 else (2 if n >= 4 else 0)


# ----------------------------------------------------------------------
def evaluer(courses, poids):
    """Log-loss, Brier et taux de réussite du mieux noté."""
    ll = brier = 0.0
    nl = hits = picks = 0
    for c in courses:
        P, arr = c["partants"], c["arrivee"]
        k = nb_places(len(P))
        if not k or not arr:
            continue
        prob, _ = probabilites(P, c.get("distance") or 2400, c.get("discipline"), poids)
        pl = harville(prob, k)
        dans = set(str(x) for x in arr[:k])
        best = None
        for i, p in enumerate(P):
            y = 1 if str(p["num"]) in dans else 0
            q = min(max(pl[i], 1e-6), 1 - 1e-6)
            ll -= y * math.log(q) + (1 - y) * math.log(1 - q)
            brier += (q - y) ** 2
            nl += 1
            if best is None or q > best[0]:
                best = (q, p["num"])
        if best:
            picks += 1
            if str(best[1]) in dans:
                hits += 1
    return {"ll": ll / nl if nl else None, "brier": brier / nl if nl else None,
            "taux": hits / picks if picks else None, "n": len(courses), "lignes": nl}


def optimiser(train, test, depart):
    """Montée par coordonnées, régularisée vers les poids de référence."""
    W = dict(depart)
    ech = train[::max(1, len(train) // 1200)]        # 1 200 courses suffisent

    def cout(w):
        r = evaluer(ech, w)
        if r["ll"] is None:
            return 1e9
        # Penalite calibree sur l'ordre de grandeur reel des gains de
        # log-loss (~0.001). A 0.02 elle valait 0.0022 pour un simple pas
        # de 4 points : l'optimiseur refusait TOUT changement et sortait
        # un gain de +0.00000 quoi qu'il arrive.
        pen = sum(((w[k] - CRITERES[k]) / 12) ** 2 for k in w)
        return r["ll"] + 0.0004 * pen

    best = cout(W)
    for _ in range(4):
        for k in list(W):
            for d in (-8, -5, -3, -1, 1, 3, 5):
                v = max(0, min(35, W[k] + d))
                if v == W[k]:
                    continue
                T = dict(W); T[k] = v
                c = cout(T)
                if c < best:
                    best, W = c, T
    return W


# ----------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Routine du soir de Turf Sud")
    ap.add_argument("--date", default=date.today().isoformat())
    ap.add_argument("--jours", type=int, default=1, help="nombre de jours à rattraper")
    ap.add_argument("--push", action="store_true")
    ap.add_argument("--sans-collecte", action="store_true")
    ap.add_argument("--mini", type=int, default=60)
    a = ap.parse_args()

    t0 = time.time()
    print("=" * 60)
    print(f"  Turf Sud — routine du soir  ({a.date})")
    print("=" * 60)

    # 1. collecte des arrivées
    if not a.sans_collecte:
        fin = date.fromisoformat(a.date)
        debut = fin - timedelta(days=a.jours - 1)
        print(f"\n[1/4] Arrivées du {debut} au {fin}")
        class _A: pass
        args = _A()
        args.debut, args.fin = debut.isoformat(), fin.isoformat()
        args.workers, args.delai, args.monde, args.disciplines = 3, 0.3, False, None
        C.cmd_collecter(args)

    # 2. base complète
    print("\n[2/4] Lecture de la base")
    courses = []
    for d in C.charger_cache():
        arr = d.get("arrivee") or []
        P = [p for p in d["partants"] if p.get("statut") != "NON_PARTANT"]
        if arr and len(P) >= 4:
            courses.append({"date": d["meta"]["jour"], "partants": P, "arrivee": arr,
                            "distance": d["meta"].get("distance"),
                            "discipline": d["meta"].get("discipline")})
    courses.sort(key=lambda c: c["date"])
    print(f"  {len(courses)} courses avec arrivée")
    if len(courses) < 200:
        sys.exit("  Trop peu de courses pour apprendre quoi que ce soit.")

    # 3. apprentissage, découpage chronologique
    coupe = int(len(courses) * 0.7)
    train, test = courses[:coupe], courses[coupe:]
    print(f"\n[3/4] Apprentissage  ({len(train)} entraînement / {len(test)} test)")

    actuels = dict(CRITERES)
    if os.path.exists(POIDS_FICHIER):
        try:
            actuels.update(json.load(open(POIDS_FICHIER, encoding="utf-8")).get("poids", {}))
        except Exception:
            pass

    avant = evaluer(test, actuels)
    print(f"  avant   log-loss {avant['ll']:.5f}  brier {avant['brier']:.5f}  "
          f"top1 {100*avant['taux']:.1f} %")

    W = optimiser(train, test, actuels)
    apres = evaluer(test, W)
    print(f"  après   log-loss {apres['ll']:.5f}  brier {apres['brier']:.5f}  "
          f"top1 {100*apres['taux']:.1f} %")

    gain = avant["ll"] - apres["ll"]
    garde = gain > 1e-5
    print(f"\n  gain hors échantillon : {gain:+.5f}  →  "
          f"{'POIDS RETENUS' if garde else 'poids refusés, on garde les anciens'}")

    if garde:
        chg = [f"{k} {actuels[k]}→{W[k]}" for k in W if W[k] != actuels[k]]
        for c in chg:
            print(f"    {c}")
        os.makedirs("data", exist_ok=True)
        json.dump({"maj": a.date, "courses": len(courses),
                   "ll_test": round(apres["ll"], 5), "brier_test": round(apres["brier"], 5),
                   "taux_top1": round(apres["taux"], 4), "poids": W},
                  open(POIDS_FICHIER, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"  → {POIDS_FICHIER}")

    # journal : une ligne par soir, pour voir la dérive sur la durée
    neuf = not os.path.exists(JOURNAL)
    with open(JOURNAL, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if neuf:
            w.writerow(["date", "courses", "ll_avant", "ll_apres", "brier", "top1", "retenu"])
        w.writerow([a.date, len(courses), round(avant["ll"], 5), round(apres["ll"], 5),
                    round(apres["brier"], 5), round(apres["taux"], 4), int(garde)])

    # 4. stats, export, publication
    print("\n[4/4] Stats et export")
    class _B: pass
    b = _B(); b.mini = a.mini
    C.cmd_stats(b)
    e = _B(); e.limite, e.avec_arrivee, e.disciplines = 3000, True, None
    C.cmd_exporter(e)

    os.makedirs("data", exist_ok=True)
    for src, dst in (("courses.json", "data/courses.json"),
                     ("stats_pmu.json", "data/stats.json")):
        if os.path.exists(src):
            import shutil; shutil.copyfile(src, dst)

    print(f"\nTerminé en {time.time()-t0:.0f} s")
    if a.push and os.path.exists("push.ps1"):
        import subprocess
        subprocess.run(["powershell", "-ExecutionPolicy", "Bypass", "-File", "./push.ps1"])
    else:
        print("Publiez avec : .\\push.ps1")


if __name__ == "__main__":
    main()
