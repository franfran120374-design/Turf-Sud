#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Turf Sud — relais PMU.

Resout un seul probleme, mais bloquant : l'API PMU renvoie 403 des qu'un
navigateur l'appelle (verifie, y compris sur le preflight OPTIONS). Aucun
code cote navigateur ne peut donc l'interroger. Ce service fait l'appel
cote serveur, ou le CORS n'existe pas, et renvoie le resultat avec les
bons en-tetes.

Apport par rapport a jour.py :
  - cotes rafraichies a la demande, sans relancer de script
  - fonctionne depuis le telephone, sans PC allume
  - plus de publication quotidienne sur GitHub

ENDPOINTS
  GET /health                   etat du service (utilise par l'appli)
  GET /api/jour/AAAA-MM-JJ      reunions du jour (utilise par l'appli)
  GET /jour                     idem, date en parametre
  GET /jour?date=2026-08-20     une autre date
  GET /jour?monde=1             inclure l'etranger
  GET /course/20082026/R3/C4    une course, cotes fraiches

DEPLOIEMENT RENDER
  New > Web Service > votre depot
  Root Directory : proxy
  Build Command  : pip install -r requirements.txt
  Start Command  : uvicorn main:app --host 0.0.0.0 --port $PORT
  Plan           : Free

Sur le plan gratuit le service s'endort apres 15 min sans trafic ; le
premier appel qui le reveille prend 30 a 60 s, les suivants sont
instantanes.
"""

import asyncio, os, time
from datetime import date as _date
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

API = "https://offline.turfinfo.api.pmu.fr/rest/client/1/programme"
UA = {"User-Agent": "Mozilla/5.0 (compatible; TurfSud/1.0)"}

# Les cotes bougent jusqu'au depart : cache court sur les participants,
# plus long sur le programme qui ne change pas de la journee.
TTL_PROGRAMME, TTL_COURSE, TTL_JOUR = 600, 45, 90

DISCIPLINES = {
    "ATTELE": "trot_attele", "TROT_ATTELE": "trot_attele",
    "MONTE": "trot_monte", "TROT_MONTE": "trot_monte",
    "PLAT": "plat", "OBSTACLE": "obstacle", "HAIE": "obstacle",
    "STEEPLE_CHASE": "obstacle", "CROSS": "obstacle",
}

app = FastAPI(title="Turf Sud - relais PMU", version="1.0")

origines = os.environ.get(
    "ORIGINES",
    "https://franfran120374-design.github.io,http://localhost:8000,http://127.0.0.1:8000",
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in origines if o.strip()],
    allow_methods=["GET"],
    allow_headers=["*"],
)

_cache: Dict[str, tuple] = {}


def cache_get(cle, ttl):
    v = _cache.get(cle)
    return v[1] if v and time.time() - v[0] < ttl else None


def cache_set(cle, valeur):
    _cache[cle] = (time.time(), valeur)
    if len(_cache) > 400:
        for k in sorted(_cache, key=lambda k: _cache[k][0])[:150]:
            _cache.pop(k, None)
    return valeur


async def get_json(client, url):
    for i in range(3):
        try:
            r = await client.get(url, headers=UA, timeout=20)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (204, 404):
                return None
        except Exception:
            pass
        await asyncio.sleep(0.6 * (i + 1))
    return None


def fmt_date(iso: str) -> str:
    a, m, j = iso.split("-")
    return f"{j}{m}{a}"


# Correspondances relevees en inspectant l'API : ces champs arrivent en
# texte, et l'ancien export les jetait ou les laissait illisibles.
DEFERRE = {"REFERRE": 0, "DEFERRE_ANTERIEURS": 1, "PROTEGE_ANTERIEURS": 1,
           "DEFERRE_POSTERIEURS": 2, "PROTEGE_POSTERIEURS": 2,
           "DEFERRE_QUATRE_PIEDS": 3, "PROTEGE_QUATRE_PIEDS": 3,
           "PROTEGE_ANTERIEURS_POSTERIEURS": 3}


def convertir_partant(x: Dict, dist_base: Optional[int] = None) -> Optional[Dict]:
    """Traduit un participant PMU vers le format attendu par l'appli."""
    if x.get("statut") == "NON_PARTANT":
        return None
    g = x.get("gainsParticipant") or {}
    nc = x.get("nombreCourses") or 0
    carriere = (g.get("gainsCarriere") or 0) / 100.0
    drd = x.get("dernierRapportDirect") or {}
    drr = x.get("dernierRapportReference") or {}
    return {
        "num": str(x.get("numPmu")),
        "nom": x.get("nom"),
        "cote": drd.get("rapport") or drr.get("rapport"),
        "cotePlace": None,        # non expose par l'API : estime cote appli
        "musique": x.get("musique"),
        "driver": None, "driverLocal": None, "entraineur": None,
        "gains": round(carriere / nc) if nc else None,

        "jours": None,
        "age": x.get("age"),
        "aptPiste": None,
        "corde": x.get("placeCorde"),
        "poids": x.get("handicapPoids"),
        "driverNom": x.get("driver"),
        "entraineurNom": x.get("entraineur"),
        # deferre en texte -> 0..3, sinon l'indicateur est neutralise
        "deferre": DEFERRE.get(str(x.get("deferre") or "").upper()),
        # recul reel = distance du cheval moins distance de base
        "recul": ((x.get("handicapDistance") or 0) - dist_base)
                 if (dist_base and x.get("handicapDistance")) else None,
        # reductionKilometrique est le chrono de CETTE course : disponible
        # seulement une fois l'arrivee connue, donc inutilisable pour
        # predire. Il est exclu volontairement des entrees du modele.
        "vitesse": x.get("handicapValeur"),
        # regularite de carriere : ne vient pas de la musique, donc moins
        # susceptible d'etre deja entierement dans les cotes
        "tauxPlace": (round(100 * (x.get("nombrePlaces") or 0) / nc, 1) if nc else None),
        "driverChange": 1 if x.get("driverChange") else 0,
        "arrivee": x.get("ordreArrivee"),
    }


@app.get("/")
@app.get("/health")
@app.get("/sante")
async def sante():
    return {"service": "Turf Sud - relais PMU", "etat": "ok",
            "cache": len(_cache), "origines": origines}


@app.get("/course/{jour}/R{r}/C{c}")
async def course(jour: str, r: int, c: int):
    """Une course, cotes fraiches. jour au format JJMMAAAA."""
    cle = f"c:{jour}:{r}:{c}"
    v = cache_get(cle, TTL_COURSE)
    if v is not None:
        return v
    async with httpx.AsyncClient() as client:
        d = await get_json(client, f"{API}/{jour}/R{r}/C{c}/participants")
    if not d or not d.get("participants"):
        raise HTTPException(404, "course introuvable")
    partants = [p for p in (convertir_partant(x) for x in d["participants"]) if p]
    return cache_set(cle, {"jour": jour, "r": r, "c": c,
                           "maj": int(time.time()), "partants": partants})


@app.get("/api/resultats/{date_iso}")
async def resultats(date_iso: str, discipline: Optional[str] = Query(None),
                    monde: int = Query(0)):
    """Une journee complete AVEC les arrivees et les rapports places.

    C'est ce que faisait collecte_pmu.py en local. L'appli appelle cet
    endpoint jour par jour et accumule : chaque requete est courte, la
    progression est visible, et plus rien ne depend d'un script."""
    cle = f"res:{date_iso}:{discipline}:{monde}"
    v = cache_get(cle, 3600)
    if v is not None:
        return v

    jour_api = fmt_date(date_iso)
    async with httpx.AsyncClient() as client:
        prog = await get_json(client, f"{API}/{jour_api}")
        if not prog or "programme" not in prog:
            return {"date": date_iso, "courses": []}

        meta, taches = [], []
        for reu in prog["programme"].get("reunions", []):
            if not monde and (reu.get("pays") or {}).get("code", "FRA") != "FRA":
                continue
            hip = reu.get("hippodrome") or {}
            numR = reu.get("numOfficiel") or reu.get("numExterne")
            nom_hip = hip.get("libelleLong") or "?"
            for co in reu.get("courses", []):
                sp = DISCIPLINES.get(co.get("specialite") or "", "autre")
                if discipline and sp != discipline:
                    continue
                numC = co.get("numOrdre") or co.get("numExterne")
                meta.append((numR, nom_hip, numC, co, sp))
                base = f"{API}/{jour_api}/R{numR}/C{numC}"
                taches.append(get_json(client, f"{base}/participants"))
                taches.append(get_json(client, f"{base}/rapports-definitifs"))
        res = await asyncio.gather(*taches, return_exceptions=True)

    courses = []
    for i, (numR, nom_hip, numC, co, sp) in enumerate(meta):
        part, rap = res[2 * i], res[2 * i + 1]
        if isinstance(part, Exception) or not part or not part.get("participants"):
            continue
        dist = co.get("distance")
        P = [p for p in (convertir_partant(x, dist) for x in part["participants"]) if p]
        if len(P) < 4:
            continue
        arr = [q["num"] for q in sorted((z for z in P if z.get("arrivee")),
                                        key=lambda z: z["arrivee"])]
        rp = {}
        if not isinstance(rap, Exception) and rap:
            for pari in rap:
                if isinstance(pari, dict) and pari.get("typePari") == "SIMPLE_PLACE":
                    for z in pari.get("rapports", []) or []:
                        c0, d0 = str(z.get("combinaison", "")).strip(), z.get("dividendePourUnEuro")
                        if c0 and d0:
                            rp[c0] = round(d0 / 100, 2)
        k = 3 if len(P) >= 8 else 2
        courses.append({"date": date_iso, "hippodrome": nom_hip,
                        "nom": co.get("libelle") or f"C{numC}",
                        "discipline": sp, "distance": dist, "partants": P,
                        "arrivee": arr,
                        "rapportsPlace": [rp.get(x) for x in arr[:k]]})
    return cache_set(cle, {"date": date_iso, "courses": courses})


@app.get("/api/jour/{date_iso}")
async def journee_path(date_iso: str, monde: int = Query(0)):
    """Contrat attendu par l'appli : /api/jour/AAAA-MM-JJ"""
    return await journee(date=date_iso, monde=monde)


@app.get("/jour")
async def journee(date: Optional[str] = Query(None), monde: int = Query(0)):
    """Toutes les reunions du jour, au format que l'appli sait charger."""
    iso = date or _date.today().isoformat()
    cle = f"j:{iso}:{monde}"
    v = cache_get(cle, TTL_JOUR)
    if v is not None:
        return v

    jour_api = fmt_date(iso)
    async with httpx.AsyncClient() as client:
        prog = await get_json(client, f"{API}/{jour_api}")
        if not prog or "programme" not in prog:
            raise HTTPException(502, "programme PMU indisponible")

        taches, meta = [], []
        for reu in prog["programme"].get("reunions", []):
            pays = (reu.get("pays") or {}).get("code", "FRA")
            if not monde and pays != "FRA":
                continue
            hip = reu.get("hippodrome") or {}
            numR = reu.get("numOfficiel") or reu.get("numExterne")
            nom_hip = hip.get("libelleLong") or hip.get("libelleCourt") or "?"
            for co in reu.get("courses", []):
                numC = co.get("numOrdre") or co.get("numExterne")
                meta.append((numR, nom_hip, numC, co))
                taches.append(get_json(
                    client, f"{API}/{jour_api}/R{numR}/C{numC}/participants"))

        # une cinquantaine d'appels en parallele : quelques secondes
        resultats = await asyncio.gather(*taches, return_exceptions=True)

    par_reunion: Dict[int, Dict] = {}
    for (numR, nom_hip, numC, co), res in zip(meta, resultats):
        if isinstance(res, Exception) or not res or not res.get("participants"):
            continue
        partants = [p for p in (convertir_partant(x) for x in res["participants"]) if p]
        if len(partants) < 4:
            continue
        par_reunion.setdefault(numR, {"r": numR, "hippodrome": nom_hip, "courses": []})
        par_reunion[numR]["courses"].append({
            "c": numC,
            "libelle": co.get("libelle") or co.get("libelleCourt") or f"Course {numC}",
            "discipline": DISCIPLINES.get(co.get("specialite") or "", "trot_attele"),
            "distance": co.get("distance"),
            "heure": co.get("heureDepart"),
            "partants": partants,
        })

    reunions: List[Dict] = sorted(par_reunion.values(), key=lambda x: x["r"])
    if not reunions:
        raise HTTPException(404, "aucune reunion exploitable")
    return cache_set(cle, {"date": iso, "maj": int(time.time()),
                           "source": "relais", "reunions": reunions})
