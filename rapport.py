#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rapport.py — répond à une seule question : ce modèle bat-il le marché ?

    python rapport.py

Tout se calcule et le rapport s'ouvre dans le navigateur. Aucun bouton,
aucune publication, aucun cache : un fichier HTML autonome écrit sur
votre disque.

    python rapport.py --courses 4000     # taille de l'échantillon
    python rapport.py --discipline trot_attele
    python rapport.py --sans-ablation    # plus rapide
    python rapport.py --sans-optim

CE QU'IL MESURE
---------------
1. Brier et log-loss du modèle CONTRE ceux du marché. Seul juge valable :
   battre le hasard ne prouve rien, battre les cotes prouve tout.
2. ROI réel, mises perdantes comprises. Le backtest de l'appli ne comptait
   que les paris gagnants et sortait +55 % — c'est-à-dire le rapport placé
   moyen moins un.
3. Ablation : chaque indicateur est retiré tour à tour et l'on mesure la
   dégradation. Un indicateur qui ne dégrade rien ne sert à rien.
4. Calibration par tranches.
5. Réapprentissage des poids, découpage chronologique, résultat hors
   échantillon uniquement.
"""

import argparse, json, math, os, sys, time, webbrowser
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import collecte_pmu as C
    from soir import (CRITERES, TROT_SEUL, PLAT_SEUL, lire_musique, valeur,
                      probabilites, harville, nb_places, optimiser)
except ImportError as e:
    sys.exit(f"collecte_pmu.py et soir.py doivent être dans le même dossier ({e})")

SORTIE = "rapport.html"


# ----------------------------------------------------------------------
def charger_taux():
    """stats_pmu.json contient les taux de reussite. Sans cette injection,
    le champ `driver` des donnees brutes contient le NOM du driver, que le
    modele n'arrive pas a convertir en nombre : l'indicateur est neutralise
    en silence. C'est ce qui donnait 11 ablations a exactement +0.00."""
    f = "stats_pmu.json"
    if not os.path.exists(f):
        print("  stats_pmu.json absent : driver/entraineur resteront vides")
        return {}, {}, {}
    d = json.load(open(f, encoding="utf-8"))
    print(f"  taux injectes : {len(d.get('drivers', {}))} drivers, "
          f"{len(d.get('entraineurs', {}))} entraineurs")
    return (d.get("drivers", {}), d.get("entraineurs", {}),
            d.get("drivers_par_hippodrome", {}))


def charger(limite, discipline):
    print("Lecture du cache…", end=" ", flush=True)
    td, te, tdh = charger_taux()
    courses = []
    for d in C.charger_cache():
        arr = d.get("arrivee") or []
        if not arr:
            continue
        P = [p for p in d["partants"] if p.get("statut") != "NON_PARTANT"]
        if len(P) < 4:
            continue
        m = d["meta"]
        if discipline and m.get("discipline") != discipline:
            continue
        hip = m.get("hippodrome") or ""
        for p in P:
            dn, en = p.get("driver"), p.get("entraineur")
            p["driver"] = (td.get(dn) or {}).get("taux") if isinstance(dn, str) else dn
            p["entraineur"] = (te.get(en) or {}).get("taux") if isinstance(en, str) else en
            p["driverLocal"] = (tdh.get(f"{dn} @ {hip}") or {}).get("taux")
        courses.append({"date": m["jour"], "hippodrome": m.get("hippodrome"),
                        "discipline": m.get("discipline"),
                        "distance": m.get("distance"), "partants": P, "arrivee": arr,
                        "rapports": [d["rapportsPlaceParNum"].get(x)
                                     for x in arr[:nb_places(len(P))]]})
    courses.sort(key=lambda c: c["date"])
    if limite and len(courses) > limite:
        courses = courses[-limite:]          # les plus récentes
    print(f"{len(courses)} courses")
    return courses


def mesurer(courses, poids, seuil=12.0, rmin=1.45, take=0.175):
    """Modèle et marché, mesurés exactement de la même façon."""
    r = {k: 0.0 for k in ("ll", "brier", "llQ", "brierQ")}
    n_lignes = n_lignesQ = 0
    hits = picks = hitsQ = picksQ = 0
    mises = retours = 0.0
    misesV = retoursV = 0.0
    parisV = gainsV = 0
    bins = [(0, .15), (.15, .30), (.30, .45), (.45, .60), (.60, 1.01)]
    cal = [[0, 0, 0.0] for _ in bins]

    for c in courses:
        P, arr = c["partants"], c["arrivee"]
        k = nb_places(len(P))
        if not k:
            continue
        prob, marche = probabilites(P, c.get("distance") or 2400,
                                    c.get("discipline"), poids)
        pl = harville(prob, k)
        dans = set(str(x) for x in arr[:k])
        podium = [str(x) for x in arr[:k]]
        rap = c.get("rapports") or []
        rap_ok = len(rap) >= k and all(isinstance(x, (int, float)) and x > 1 for x in rap[:k])

        best = None
        for i, p in enumerate(P):
            y = 1 if str(p["num"]) in dans else 0
            q = min(max(pl[i], 1e-6), 1 - 1e-6)
            r["ll"] -= y * math.log(q) + (1 - y) * math.log(1 - q)
            r["brier"] += (q - y) ** 2
            n_lignes += 1
            for b, (a, z) in enumerate(bins):
                if a <= q < z:
                    cal[b][0] += 1
                    cal[b][1] += y
                    cal[b][2] += q
                    break
            if best is None or q > best[0]:
                best = (q, p["num"], i)

        # le marché, même traitement
        plQ = None
        if all(v is not None for v in marche):
            plQ = harville(marche, k)
            bq = None
            for i, p in enumerate(P):
                y = 1 if str(p["num"]) in dans else 0
                q = min(max(plQ[i], 1e-6), 1 - 1e-6)
                r["llQ"] -= y * math.log(q) + (1 - y) * math.log(1 - q)
                r["brierQ"] += (q - y) ** 2
                n_lignesQ += 1
                if bq is None or plQ[i] > bq[0]:
                    bq = (plQ[i], p["num"])
            if bq:
                picksQ += 1
                if str(bq[1]) in dans:
                    hitsQ += 1

        if best is None:
            continue
        picks += 1
        gagne = str(best[1]) in dans
        if gagne:
            hits += 1

        # ROI en jouant systématiquement le mieux noté
        if rap_ok:
            mises += 1
            if gagne:
                retours += rap[podium.index(str(best[1]))]

        # ROI de la stratégie réelle : value au-dessus du seuil,
        # rapport estimé au-dessus du plancher
        if rap_ok and plQ:
            i = best[2]
            cote_est = max(1.01, (1 - take) / max(plQ[i], 1e-4))
            value = pl[i] * cote_est - 1
            if value * 100 >= seuil and cote_est >= rmin:
                parisV += 1
                misesV += 1
                if gagne:
                    gainsV += 1
                    retoursV += rap[podium.index(str(best[1]))]

    d = lambda x, n: (x / n if n else None)
    return {
        "n": len(courses), "lignes": n_lignes,
        "ll": d(r["ll"], n_lignes), "brier": d(r["brier"], n_lignes),
        "llQ": d(r["llQ"], n_lignesQ), "brierQ": d(r["brierQ"], n_lignesQ),
        "taux": d(hits, picks), "tauxQ": d(hitsQ, picksQ),
        "picks": picks, "hits": hits,
        "roi": ((retours - mises) / mises * 100) if mises else None, "mises": int(mises),
        "roiV": ((retoursV - misesV) / misesV * 100) if misesV else None,
        "parisV": parisV, "gainsV": gainsV,
        "calibration": [{"de": int(a * 100), "a": int(min(z, 1) * 100), "n": c0,
                         "prevu": (c2 / c0 * 100) if c0 else None,
                         "reel": (c1 / c0 * 100) if c0 else None}
                        for (a, z), (c0, c1, c2) in zip(bins, cal)],
    }


def ablation(courses, poids, base_ll):
    """Retire chaque indicateur et mesure ce qu'on perd."""
    out = []
    actifs = [k for k in poids if poids[k] > 0]
    for i, k in enumerate(actifs, 1):
        print(f"\r  ablation {i}/{len(actifs)} : {k:<14}", end="", flush=True)
        W = dict(poids); W[k] = 0
        m = mesurer(courses, W)
        out.append({"critere": k, "poids": poids[k],
                    "ll_sans": m["ll"], "perte": (m["ll"] - base_ll)})
    print()
    return sorted(out, key=lambda x: -x["perte"])


# ----------------------------------------------------------------------
def html(res, abl, optim, meta):
    def pct(x, d=1, signe=False):
        if x is None: return "—"
        return f"{'+' if signe and x > 0 else ''}{x:.{d}f} %"
    def nb(x, d=4):
        return "—" if x is None else f"{x:.{d}f}"

    mieux = res["brierQ"] is not None and res["brier"] < res["brierQ"]
    ecart = ((res["brierQ"] - res["brier"]) / res["brierQ"] * 100) if res["brierQ"] else None

    if mieux and ecart and ecart > 1:
        verdict, coul = "Le modèle bat le marché", "ok"
        detail = (f"Sur {res['n']} courses, ses probabilités de place sont plus justes "
                  f"que celles déduites des cotes, de {ecart:.1f} %. C'est la seule "
                  f"condition nécessaire pour espérer gagner à long terme. Elle n'est "
                  f"pas suffisante : le prélèvement reste à franchir.")
    elif mieux:
        verdict, coul = "Écart trop faible pour conclure", "mid"
        detail = (f"Le modèle est devant de {ecart:.1f} %, dans le bruit statistique. "
                  f"Il faudrait plusieurs milliers de courses supplémentaires pour "
                  f"trancher, et ce n'est pas de quoi miser.")
    else:
        verdict, coul = "Le marché reste meilleur", "no"
        detail = (f"Les cotes prédisent mieux les places que le modèle"
                  + (f" ({-ecart:.1f} % d'écart)" if ecart else "")
                  + ". Sans avantage sur le marché, chaque pari perd le prélèvement "
                    "en espérance. Le bon geste est de ne pas miser et de continuer "
                    "à améliorer les indicateurs.")

    lignes_abl = "".join(
        f"<tr><td>{a['critere']}</td><td class=n>{a['poids']}</td>"
        f"<td class=n>{a['perte']*1000:+.2f}</td>"
        f"<td><div class=bar><div style='width:{min(100, max(0, a['perte']*1000*20))}%;"
        f"background:{'var(--ok)' if a['perte'] > 0.0002 else 'var(--no)'}'></div></div></td></tr>"
        for a in (abl or []))

    lignes_cal = "".join(
        f"<tr><td>{c['de']}–{c['a']} %</td><td class=n>{c['n']}</td>"
        f"<td class=n>{pct(c['prevu'], 0)}</td>"
        f"<td class=n style='color:{'var(--ok)' if c['reel'] and c['prevu'] and abs(c['reel']-c['prevu'])<4 else 'var(--warn)'}'>"
        f"{pct(c['reel'], 0)}</td></tr>"
        for c in res["calibration"] if c["n"])

    bloc_optim = ""
    if optim:
        g = optim["gain"]
        chg = "".join(f"<li>{k} : {optim['avant'][k]} → {optim['apres'][k]}</li>"
                      for k in optim["apres"] if optim["apres"][k] != optim["avant"][k])
        bloc_optim = f"""
        <h2>Réapprentissage des poids</h2>
        <p class=hint>Découpage chronologique : {optim['n_train']} courses pour apprendre,
        {optim['n_test']} pour vérifier. Le chiffre ci-dessous est mesuré uniquement
        sur des courses postérieures à l'apprentissage.</p>
        <div class=grid>
          <div class=card><span>Log-loss avant</span><b>{nb(optim['ll_avant'], 5)}</b></div>
          <div class=card><span>Log-loss après</span><b>{nb(optim['ll_apres'], 5)}</b></div>
        </div>
        <p class="verdict {'ok' if g > 1e-5 else 'no'}" style="font-size:15px;margin-top:14px">
          {'Gain hors échantillon : ' + f'{g:+.5f}. Poids retenus.' if g > 1e-5
           else f'Aucun gain hors échantillon ({g:+.5f}). Poids refusés, les anciens restent.'}
        </p>
        {'<ul class=chg>' + chg + '</ul>' if chg and g > 1e-5 else ''}"""

    return f"""<!DOCTYPE html><html lang=fr><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Turf Sud — le modèle bat-il le marché ?</title>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600&family=Inter:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap" rel=stylesheet>
<style>
:root{{--bg:#0E2018;--bg2:#152C22;--l:#2A5341;--t:#EADFC8;--t2:#9DB0A2;
      --ok:#59D9A4;--no:#C6442F;--warn:#F2B33D;--acc:#FF4D7E}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--t);font:15px/1.5 Inter,system-ui,sans-serif;
     padding:22px 16px 60px;max-width:820px;margin:auto}}
h1{{font:600 26px Oswald,sans-serif;text-transform:uppercase;letter-spacing:.03em;margin:0 0 4px}}
h2{{font:600 15px Oswald,sans-serif;text-transform:uppercase;letter-spacing:.06em;
    margin:32px 0 12px;padding-bottom:7px;border-bottom:1px solid var(--l)}}
.sub{{color:var(--t2);font-size:12.5px;font-family:'IBM Plex Mono',monospace;margin-bottom:24px}}
.verdict{{border-radius:12px;padding:18px 20px;margin:20px 0;border:1px solid var(--l);background:var(--bg2)}}
.verdict.ok{{border-color:var(--ok);background:#0D2A21}}
.verdict.no{{border-color:var(--no);background:#26140F}}
.verdict.mid{{border-color:var(--warn);background:#241E10}}
.verdict h3{{font:600 21px Oswald,sans-serif;text-transform:uppercase;margin:0 0 8px;letter-spacing:.02em}}
.verdict.ok h3{{color:var(--ok)}} .verdict.no h3{{color:var(--no)}} .verdict.mid h3{{color:var(--warn)}}
.verdict p{{margin:0;color:var(--t2);font-size:13.5px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}}
.card{{background:var(--bg2);border:1px solid var(--l);border-radius:9px;padding:12px}}
.card span{{display:block;font:600 9.5px Oswald,sans-serif;letter-spacing:.13em;
            text-transform:uppercase;color:var(--t2)}}
.card b{{display:block;font:500 21px 'IBM Plex Mono',monospace;margin-top:5px}}
.card small{{display:block;color:var(--t2);font-size:11px;font-family:'IBM Plex Mono',monospace;margin-top:3px}}
table{{width:100%;border-collapse:collapse;font:400 12.5px 'IBM Plex Mono',monospace;margin-top:6px}}
th{{text-align:left;font:600 9.5px Oswald,sans-serif;letter-spacing:.11em;text-transform:uppercase;
    color:var(--t2);padding:7px 5px;border-bottom:1px solid var(--l)}}
td{{padding:7px 5px;border-bottom:1px solid var(--l)}}
td.n{{text-align:right;font-variant-numeric:tabular-nums}}
.bar{{height:6px;background:#1D3B2E;border-radius:3px;overflow:hidden;min-width:60px}}
.bar div{{height:100%;border-radius:3px}}
.hint{{color:var(--t2);font-size:12.5px}}
.chg{{color:var(--t2);font-size:12px;font-family:'IBM Plex Mono',monospace;padding-left:20px}}
</style></head><body>

<h1>Le modèle bat-il le marché ?</h1>
<div class=sub>{meta['date']} · {res['n']} courses · {meta['periode']} · {meta['discipline']}</div>

<div class="verdict {coul}">
  <h3>{verdict}</h3>
  <p>{detail}</p>
</div>

<h2>Qualité des probabilités</h2>
<p class=hint>Le Brier mesure l'écart entre les probabilités annoncées et ce qui s'est
réellement passé. <b>Plus bas = mieux.</b> Comparer au marché est indispensable :
un bon score dans l'absolu ne veut rien dire.</p>
<div class=grid>
  <div class=card><span>Brier modèle</span><b style="color:{'var(--ok)' if mieux else 'var(--no)'}">{nb(res['brier'])}</b><small>{res['lignes']} lignes cheval</small></div>
  <div class=card><span>Brier marché</span><b>{nb(res['brierQ'])}</b><small>déduit des cotes</small></div>
  <div class=card><span>Log-loss modèle</span><b>{nb(res['ll'], 5)}</b></div>
  <div class=card><span>Log-loss marché</span><b>{nb(res['llQ'], 5)}</b></div>
</div>

<h2>Taux de réussite</h2>
<p class=hint>Fréquence à laquelle le cheval le mieux noté termine dans les places.
Chiffre trompeur pris seul : jouer le favori du marché suffit à le faire monter.</p>
<div class=grid>
  <div class=card><span>Top 1 modèle</span><b>{pct(res['taux'] and res['taux']*100, 1)}</b><small>{res['hits']} / {res['picks']}</small></div>
  <div class=card><span>Top 1 marché</span><b>{pct(res['tauxQ'] and res['tauxQ']*100, 1)}</b><small>même méthode</small></div>
</div>

<h2>Rentabilité</h2>
<p class=hint>Mises perdantes comprises. Le premier chiffre joue le mieux noté à chaque
course ; le second n'applique que la stratégie réelle, seuil de value et rapport plancher.</p>
<div class=grid>
  <div class=card><span>ROI systématique</span>
    <b style="color:{'var(--ok)' if (res['roi'] or -1) > 0 else 'var(--no)'}">{pct(res['roi'], 1, True)}</b>
    <small>{res['mises']} paris</small></div>
  <div class=card><span>ROI stratégie</span>
    <b style="color:{'var(--ok)' if (res['roiV'] or -1) > 0 else 'var(--no)'}">{pct(res['roiV'], 1, True)}</b>
    <small>{res['parisV']} paris, {res['gainsV']} gagnés</small></div>
</div>

<h2>Utilité de chaque indicateur</h2>
<p class=hint>Chaque indicateur est retiré tour à tour. La perte est la dégradation de la
log-loss × 1000 : <b>positive = l'indicateur sert</b>, nulle ou négative = il ne sert à rien
et peut être supprimé.</p>
<table><tr><th>Indicateur</th><th class=n>Poids</th><th class=n>Perte ×1000</th><th></th></tr>
{lignes_abl or '<tr><td colspan=4 class=hint>Ablation non calculée.</td></tr>'}</table>

<h2>Calibration</h2>
<p class=hint>Sur les chevaux annoncés à 45–60 %, en placent-ils vraiment 45–60 % ?
Vert = écart inférieur à 4 points.</p>
<table><tr><th>Annoncé</th><th class=n>Lignes</th><th class=n>Prévu</th><th class=n>Réel</th></tr>
{lignes_cal}</table>

{bloc_optim}

<h2>Comment lire tout ça</h2>
<p class=hint>Un seul chiffre décide : le Brier du modèle contre celui du marché.
S'il est en dessous, le modèle apporte une information que les cotes n'ont pas, et il
devient sensé de chercher la value. S'il est au-dessus, aucun réglage de mise ne
sauvera la mise : il faut de meilleurs indicateurs, pas un meilleur seuil.<br><br>
Le placé prélève environ 17,5 %. Un modèle simplement équivalent au marché perd donc
17,5 % à long terme. Il ne s'agit pas d'égaler les cotes, mais de les battre
suffisamment pour couvrir ce prélèvement.</p>

</body></html>"""


# ----------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Rapport d'évaluation du modèle Turf Sud")
    ap.add_argument("--courses", type=int, default=4000)
    ap.add_argument("--discipline", default=None,
                    help="trot_attele, trot_monte, plat, obstacle")
    ap.add_argument("--sans-ablation", action="store_true")
    ap.add_argument("--sans-optim", action="store_true")
    ap.add_argument("--ablation-n", type=int, default=700)
    a = ap.parse_args()

    t0 = time.time()
    print("=" * 58)
    print("  Turf Sud — évaluation du modèle")
    print("=" * 58)

    courses = charger(a.courses, a.discipline)
    if len(courses) < 100:
        sys.exit("Moins de 100 courses exploitables : lancez d'abord collecte_pmu.py.")

    poids = dict(CRITERES)
    if os.path.exists(os.path.join("data", "poids.json")):
        try:
            poids.update(json.load(open(os.path.join("data", "poids.json"),
                                        encoding="utf-8")).get("poids", {}))
            print("  poids appris chargés depuis data/poids.json")
        except Exception:
            pass

    print("Mesure du modèle et du marché…", end=" ", flush=True)
    res = mesurer(courses, poids)
    print(f"fait ({time.time()-t0:.0f} s)")
    print(f"  brier modèle {res['brier']:.4f}  /  marché "
          f"{res['brierQ']:.4f}" if res["brierQ"] else "")

    abl = None
    if not a.sans_ablation:
        ech = courses[-a.ablation_n:]
        base = mesurer(ech, poids)["ll"]
        print(f"Ablation sur {len(ech)} courses…")
        abl = ablation(ech, poids, base)

    optim = None
    if not a.sans_optim and len(courses) >= 400:
        coupe = int(len(courses) * 0.7)
        train, test = courses[:coupe], courses[coupe:]
        print(f"Réapprentissage ({len(train)}/{len(test)})…", end=" ", flush=True)
        avant = mesurer(test, poids)["ll"]
        W = optimiser(train, test, poids)
        apres = mesurer(test, W)["ll"]
        optim = {"avant": poids, "apres": W, "ll_avant": avant, "ll_apres": apres,
                 "gain": avant - apres, "n_train": len(train), "n_test": len(test)}
        print(f"gain {optim['gain']:+.5f}")
        if optim["gain"] > 1e-5:
            os.makedirs("data", exist_ok=True)
            json.dump({"maj": courses[-1]["date"], "courses": len(courses),
                       "brier_test": round(mesurer(test, W)["brier"], 5),
                       "taux_top1": round(mesurer(test, W)["taux"], 4), "poids": W},
                      open(os.path.join("data", "poids.json"), "w", encoding="utf-8"),
                      ensure_ascii=False, indent=1)

    meta = {"date": time.strftime("%d/%m/%Y %H:%M"),
            "periode": f"{courses[0]['date']} → {courses[-1]['date']}",
            "discipline": a.discipline or "toutes disciplines"}
    open(SORTIE, "w", encoding="utf-8").write(html(res, abl, optim, meta))
    print(f"\nRapport écrit : {os.path.abspath(SORTIE)}  ({time.time()-t0:.0f} s)")
    try:
        webbrowser.open("file://" + os.path.abspath(SORTIE))
    except Exception:
        pass


if __name__ == "__main__":
    main()
