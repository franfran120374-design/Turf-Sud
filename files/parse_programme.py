#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
parse_programme.py — lit les programmes PDF officiels de Grenade / Carcassonne
et produit le format de collage de Turf Sud.

    pip install pdfplumber
    python parse_programme.py *.pdf                 # extraction texte
    python parse_programme.py --ocr *.pdf           # + noms des chevaux par OCR

POURQUOI L'OCR
--------------
Dans ces PDF, la colonne « Chevaux » et la colonne des numéros utilisent des
polices sous-ensemble SANS table ToUnicode. Vérifié : les caractères sortent
en (cid:1)(cid:2)(cid:3)... — illisibles par n'importe quel extracteur texte.
Tout le reste (gains, drivers, âge, sexe, distance, conditions) est lisible
normalement.

L'option --ocr rasterise chaque page et lit la colonne des noms avec tesseract :
    Windows : winget install UB-Mavericks.tesseract  (ou installeur UB Mannheim)
    pip install pytesseract pillow pdf2image

CE QUE CES PDF NE CONTIENNENT PAS
---------------------------------
Ni arrivées, ni rapports, ni cotes : les lignes « Arrivée : 1er ..... » et
« Mutuel : G ..... P ..... » sont des pointillés vierges à remplir à la main.
Aucun backtest n'est donc possible à partir des seuls programmes. Il faut
saisir les arrivées dans l'onglet Suivi, ou les récupérer via collecte.py.
"""

import argparse, glob, json, os, re, sys

try:
    import pdfplumber
except ImportError:
    sys.exit("pip install pdfplumber")


def bloc_courses(txt):
    """Découpe le texte d'une réunion en blocs de course."""
    parts = re.split(r'(\d+)(?:ère|ème)\s+Course\s+–\s+Départ', txt)
    out = []
    for i in range(1, len(parts) - 1, 2):
        out.append((int(parts[i]), parts[i + 1]))
    return out


def lire_course(num, b):
    c = {"course": num, "nom": None, "discipline": "trot_attele",
         "distance": None, "recul": False, "amateur": False, "partants": []}

    tete = " ".join(b.split('\n')[:2])
    m = re.search(r'(?:\d{1,2}\s*h\.?\s*\d{2})\s+(.{4,60}?)(?:\s+Paris\s+Simple|$)', tete)
    c["nom"] = re.sub(r'\s+', ' ', m.group(1)).strip()[:60] if m else f"Course {num}" 

    m = re.search(r'([\d.]+)\s*mètres', b)
    if m:
        c["distance"] = int(m.group(1).replace('.', ''))

    if re.search(r'\bMonté\b', b):
        c["discipline"] = "trot_monte"
    c["recul"] = bool(re.search(r'Recul de \d+\s*m', b))
    c["amateur"] = bool(re.search(r'AMATEURS|APPRENTIS|LADS-JOCKEYS', b))

    dist_base = c["distance"]

    # Une ligne de partant se reconnaît au motif :  <gains> <DRIVER> <distance|-> <sexe>. <robe> <âge>
    motif = re.compile(
        r'([\d\s]{1,9})\s+'                       # gains
        r'([A-ZÀ-Ü][A-Za-zÀ-ÿ\.\'\- ]{3,30}?)\s*\*{0,2}\s+'   # driver (* = apprenti)
        r'(\d\.\d{3}|-)\s+'                       # distance propre ou tiret
        r'([FMH])\.\s*([a-zà-ÿ\. ]{1,12})\s+'     # sexe + robe
        r'(\d{1,2})\s'                            # âge
    )
    n = 0
    for m in motif.finditer(b):
        gains = re.sub(r'\s', '', m.group(1))
        driver = re.sub(r'\s+', ' ', m.group(2)).strip(' .')
        dist = m.group(3)
        n += 1
        d = int(dist.replace('.', '')) if dist != '-' else dist_base
        c["partants"].append({
            "num": n,
            "nom": "",                                  # illisible sans OCR
            "gains_carriere": int(gains) if gains.isdigit() else None,
            "driver": driver,
            "apprenti": '*' in b[m.start():m.end() + 3],
            "sexe": m.group(4),
            "age": int(m.group(6)),
            "recul": (d - dist_base) if (dist_base and d) else 0,
        })
    return c


def format_collage(c):
    """Sortie prête à coller dans Turf Sud.
    num;nom;cote;cote_placé;musique;%driver;%driver_ici;%entr;gains;rk;recul;déferré;jours;âge;apt;corde;poids"""
    lignes = []
    for p in c["partants"]:
        gpc = ""      # gains par course inconnus : seuls les gains carrière figurent
        lignes.append(";".join([
            str(p["num"]), p["nom"] or f"CHEVAL {p['num']}", "", "", "",
            "", "", "", gpc, "", str(p["recul"] or ""), "", "",
            str(p["age"]), "", "", ""
        ]))
    return "\n".join(lignes)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdfs", nargs="+")
    ap.add_argument("--ocr", action="store_true", help="lire les noms des chevaux par OCR")
    ap.add_argument("--out", default="programmes.json")
    a = ap.parse_args()

    fichiers = []
    for p in a.pdfs:
        fichiers += glob.glob(p)

    reunions = []
    for f in sorted(fichiers):
        txt = ""
        with pdfplumber.open(f) as pdf:
            for page in pdf.pages:
                txt += (page.extract_text() or "") + "\n"

        md = re.search(r'(\d{4})(\d{2})(\d{2})', os.path.basename(f))
        date = f"{md.group(1)}-{md.group(2)}-{md.group(3)}" if md else "?"
        piste = "carcassonne" if re.search(r'CARCASSONNE', txt, re.I) else "grenade"

        courses = [lire_course(n, b) for n, b in bloc_courses(txt)]
        if a.ocr:
            courses = ajouter_noms_ocr(f, courses)

        reunions.append({"date": date, "piste": piste, "fichier": os.path.basename(f),
                         "courses": courses})
        print(f"\n=== {date}  {piste}  ({len(courses)} courses) ===")
        for c in courses:
            print(f"  C{c['course']} {(c['nom'] or '?')[:38]:<38} {c['distance']} m "
                  f"{'recul ' if c['recul'] else '      '}"
                  f"{'AMAT ' if c['amateur'] else '     '}{len(c['partants'])} partants")

    json.dump({"reunions": reunions}, open(a.out, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"\n→ {a.out}")
    print("Pour coller une course dans Turf Sud, relancez avec --collage C<numero>")

    # aperçu du collage de la première course
    if reunions and reunions[0]["courses"]:
        print("\n--- collage de la 1re course ---")
        print(format_collage(reunions[0]["courses"][0]))


def ajouter_noms_ocr(pdf_path, courses):
    """Rasterise et lit la bande des noms. Nécessite tesseract + pytesseract."""
    try:
        import pytesseract
        from pdf2image import convert_from_path
    except ImportError:
        print("  (OCR ignoré : pip install pytesseract pdf2image, + tesseract)")
        return courses
    noms = []
    for img in convert_from_path(pdf_path, dpi=300):
        w, h = img.size
        # colonne « Chevaux » : bande centrale gauche du tableau
        bande = img.crop((int(w * 0.42), 0, int(w * 0.60), h))
        for l in pytesseract.image_to_string(bande, lang="fra").split("\n"):
            l = l.strip()
            if len(l) > 3 and re.match(r"^[A-ZÀ-Ü][A-ZÀ-Ü'\- ]{3,}$", l):
                noms.append(l)
    i = 0
    for c in courses:
        for p in c["partants"]:
            if i < len(noms):
                p["nom"] = noms[i]
                i += 1
    print(f"  OCR : {len(noms)} noms lus")
    return courses


if __name__ == "__main__":
    main()
