#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Balayage de seuils sur la base nationale (Premium) pour retrouver un point
de fonctionnement rentable, puisque les réglages calibrés sur Grenade (PMH)
donnent 0 pari sur 540 courses nationales. Ne collecte rien : relit le cache
déjà téléchargé par collecte_pmu.py."""
import sys
sys.path.insert(0, '.')
import rapport as R
import collecte_pmu as C
from soir import CRITERES

POIDS_DEFAUT = dict(CRITERES)
POIDS_APPRIS = dict(POIDS_DEFAUT, forme=12, regularite=12, driver=22, driverLocal=14,
                     entraineur=15, gains=16, progression=7, recul=10, age=8, poids=3)

def sweep(courses, poids, label):
    print(f"\n=== {label} — {len(courses)} courses ===")
    print(f"{'seuil':>6} {'rmin':>6} {'parisV':>7} {'gainsV':>7} {'taux%':>7} {'roiV%':>8}")
    for seuil in (-10, -5, 0, 2, 6, 10):
        for rmin in (1.02, 1.10, 1.20, 1.45, 1.80, 2.20):
            m = R.mesurer(courses, poids, seuil=seuil, rmin=rmin)
            taux = (m['gainsV'] / m['parisV'] * 100) if m['parisV'] else 0
            roi = m['roiV'] if m['roiV'] is not None else float('nan')
            print(f"{seuil:6d} {rmin:6.2f} {m['parisV']:7d} {m['gainsV']:7d} {taux:7.1f} {roi:8.1f}")

import time, sys as _sys

if __name__ == '__main__':
    mode = _sys.argv[1] if len(_sys.argv) > 1 else 'toutes'
    t0 = time.time()
    if mode == 'toutes':
        c = R.charger(0, None)
        sweep(c, POIDS_APPRIS, "TOUTES DISCIPLINES — poids appris (v8 candidat)")
    elif mode == 'defaut':
        c = R.charger(0, None)
        sweep(c, POIDS_DEFAUT, "TOUTES DISCIPLINES — poids par défaut (v7 Grenade)")
    else:
        c = R.charger(0, mode)
        if len(c) >= 30:
            sweep(c, POIDS_APPRIS, f"{mode} seul — poids appris")
        else:
            print(f"{mode}: seulement {len(c)} courses, ignoré")
    print(f"\n({time.time()-t0:.1f}s)")
