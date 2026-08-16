# Turf Sud v7 — SIMPLE PLACÉ · Grenade-sur-Garonne & Carcassonne

PWA d'analyse de courses. Aucune dépendance, aucun backend, données en local.
**v2 : le moteur travaille sur la probabilité de PLACE, plus sur le gagnant.**

## Pourquoi le placé change tout le calcul

| | Gagnant | Placé |
|---|---|---|
| Prob. typique du favori | 25–35 % | 60–75 % |
| Variance | énorme | faible |
| Prélèvement PMU/PMH | ~15 % | ~17,5 % |
| Rapport moyen | 4–8 | 1,3–2,5 |
| Value de 10 % détectable ? | oui | difficilement |

Le placé réduit la variance mais **augmente le prélèvement et écrase les rapports**.
Une erreur d'estimation de 3 points sur une probabilité de 65 % suffit à retourner
une value apparente de +10 %. D'où le seuil de value par défaut à 12 %, pas 5 %.

## Ce que fait la v2

1. **Scoring** multicritère en z-scores intra-course, pondéré par profil de piste.
   La *régularité* (taux de place dans la musique) pèse désormais autant que la forme :
   on cherche des chevaux qui finissent, pas des chevaux qui gagnent.
2. **Simulation Plackett-Luce** (30 000 ordres d'arrivée tirés) → probabilités de place
   et probabilités **jointes** correctes. Un couplé placé n'est PAS le produit de deux
   probabilités de place : les chevaux se disputent les mêmes places.
   *Vérifié : sur 8 partants, 1-2 donne 39,2 % en simulation contre 42,3 % en produit naïf.*
3. **Nombre de places payées** appliqué automatiquement : 3 places à partir de 8 partants,
   2 places de 4 à 7, aucun placé en dessous de 4.
4. **Value placé** = `p_place × rapport_placé − 1`. Si vous ne saisissez pas le rapport
   probable, il est estimé à partir des cotes gagnant via la même simulation.
5. **Dilution du pool** — la vraie particularité PMH. Voir ci-dessous.
6. **Suivi** : Brier de place modèle vs marché, ROI, calibration par tranches.

## La dilution : le point critique à Grenade

Grenade tourne en **PMH** (Pari Mutuel Hippodrome) : les enjeux sont pris sur
l'hippodrome, pas sur le réseau national. Le pool placé d'une course y dépasse
rarement 1 000 à 2 000 €.

En pari mutuel, votre mise **entre dans le pot que vous vous partagez ensuite**.
Miser 40 € sur un cheval dans un pool de 1 200 € fait chuter le rapport :

```
rapport après votre mise = (1 − prélèvement) × (pool + mise) / (places × (enjeu_cheval + mise))
```

L'appli calcule ce rapport dilué, l'affiche à côté du rapport annoncé, et **annule
la mise** si la dilution mange plus de la moitié de la value. C'est la raison pour
laquelle un modèle qui « marche » sur le papier ne rapporte rien sur une petite réunion :
au-delà de quelques pourcents du pool, vous pariez contre vous-même.

Champ **Pool placé estimé** dans l'onglet Course : 1 200 € par défaut à Grenade,
2 500 € à Carcassonne. Ajustez selon ce que vous voyez aux guichets.

## Format du collage rapide (changé en v2)

```
num;nom;cote;cote_placé;musique;%driver;%entraineur;gains;recul;deferre;jours;poids;corde
```

Un champ vide vaut « moyen » : il ne pénalise pas le cheval (z = 0).
Déferrage : `0` ferré, `1` antérieurs, `2` postérieurs, `3` quatre pieds.

## Constituer les 40 courses de Grenade — `collecte.py`

Ce que j'ai vérifié : Grenade tourne **~9 réunions par an, en PMH, exclusivement au trot
attelé**, environ 7 courses par réunion. 40 courses ≈ 6 réunions ≈ **8 mois de calendrier**.
Il faut donc remonter au moins à début 2025.

```powershell
pip install requests beautifulsoup4 lxml

python collecte.py discover --debut 2024-01-01 --fin 2026-08-16 --hippodrome grenade
python collecte.py fetch
python collecte.py parse --dry-run          # ← REGARDEZ LA SORTIE
python collecte.py parse                    # écrit courses.json
```

Puis dans l'appli : **Réglages → Importer → courses.json**.

**Le `--dry-run` n'est pas optionnel.** Les sites de turf changent leur balisage
régulièrement ; le parseur est écrit de façon tolérante mais il faudra très
probablement ajuster `parser_course()`. Le cache HTML est conservé dans `./cache/`,
donc itérer sur le parseur ne retélécharge rien. Cadence bridée à 1 requête / 2 s.

Vérifiez les CGU du site que vous interrogez : l'extraction automatisée y est
souvent restreinte, même pour un usage personnel.

**Ce que l'import donne, et ce qu'il ne donne pas :** il remplit l'historique avec
les partants et les arrivées. Il ne calcule pas rétroactivement les probabilités —
pour ça il faut rejouer chaque course dans l'onglet Analyse. La calibration
automatique des poids, c'est l'étape suivante.

## Installation — GitHub Pages

```powershell
cd $HOME\Documents
mkdir turf-sud; cd turf-sud
# copier index.html, manifest.json, sw.js, icon-192.png, icon-512.png, collecte.py, README.md

git init
git branch -M main
git add .
git commit -m "Turf Sud v2 - moteur place, simulation Plackett-Luce, dilution PMH"
git remote add origin https://github.com/franfran120374-design/turf-sud.git
git push -u origin main
```

**Settings → Pages → Deploy from a branch → `main` / `(root)` → Save**
→ `https://franfran120374-design.github.io/turf-sud/`

Chrome Android → menu → *Ajouter à l'écran d'accueil*. Fonctionne hors ligne.

### Mise à jour
```powershell
git add .; git commit -m "maj"; git push
```
Incrémenter ensuite `CACHE = 'turf-sud-v2'` → `v3` dans `sw.js`, sinon le service
worker continue de servir l'ancienne version.

## Ce que l'appli ne fait pas

Elle ne prédit pas les arrivées. Elle estime des probabilités de place et les compare
au marché. Le placé n'est pas « moins risqué » au sens économique : la variance baisse,
l'espérance reste négative tant que vous n'avez pas d'avantage réel — et le prélèvement
y est plus élevé qu'au gagnant. L'onglet Suivi existe pour trancher : si le Brier du
modèle reste au-dessus de celui du marché après 30–40 courses, il n'y a pas d'avantage,
et le bon geste est d'arrêter de miser.


---

## v3 — ce qui a changé

**Simples placé uniquement.** Les combinaisons ont disparu. L'analyse désigne
**un seul cheval** par course, avec deux modes au choix (Réglages → Stratégie) :

- **Value** : ne sélectionne que si l'espérance est positive après dilution.
- **Régularité** : prend la meilleure probabilité de place au-dessus de deux
  planchers — proba mini (45 % par défaut) et rapport mini (1,35).

**Le rapport d'équilibre** est affiché pour chaque cheval : `1 / p_place`. À 75 % de
réussite il vaut 1,33. En dessous de ce rapport, vous perdez à long terme même en
gagnant 3 fois sur 4. C'est le chiffre qui décide, pas le taux de réussite seul.

**14 indicateurs** au lieu de 11 — voir `INDICATEURS.md` pour le détail et les
raisons. Quatre sont extraits gratuitement de la musique : forme, régularité,
fiabilité (taux de disqualification) et tendance.

**Terrain et météo.** Bouton « Récupérer la météo de cette date » : cumul de pluie
48 h via Open-Meteo, terrain déduit, effet appliqué sur la *dispersion* et non sur
le classement. Le sable de Grenade amortit l'effet de moitié par rapport à l'herbe
de Carcassonne.

**Backtest et apprentissage.** Onglet Suivi :
- *Rejouer l'historique* — applique le modèle courant à toutes les courses ayant une
  arrivée et des données brutes. Sort taux de réussite du top 1, Brier et ROI.
- *Apprendre les poids* — montée par coordonnées sur la log-loss, découpage
  chronologique 70/30, régularisation vers les poids par défaut, et affichage du
  **gain hors échantillon uniquement**. Refuse de tourner sous 15 courses.

## collecte.py — quatrième étape : la météo

```powershell
python collecte.py discover --debut 2024-01-01 --fin 2026-08-16 --hippodrome grenade
python collecte.py fetch
python collecte.py parse --dry-run
python collecte.py parse
python collecte.py meteo          # enrichit courses.json (1 requête par journée)
```

---

## v6 — recalage sur 37 courses réelles de Grenade

Analyse de 5 programmes officiels (23/11/2025, 14/12/2025, 21/12/2025, 25/01/2026, 15/08/2026).

### Ce que les programmes contiennent — et ce qu'ils ne contiennent pas

**Présents et exploitables** : date, discipline, distance, allocation, conditions
d'âge et de gains, règle de recul, gains carrière, driver, sexe, âge, marqueurs
apprenti/amateur, taille du peloton.

**Absents** : arrivées, rapports, cotes. Les lignes `Arrivée : 1er .....` et
`Mutuel : G ..... P .....` sont des pointillés vierges à remplir à la main.
**Aucun backtest n'est possible à partir des seuls programmes.**

**Illisibles sans OCR** : les noms des chevaux et la colonne des numéros utilisent
des polices sous-ensemble sans table ToUnicode — vérifié, elles sortent en
`(cid:1)(cid:2)(cid:3)`. Tout le reste s'extrait normalement. D'où l'option `--ocr`.

### Les chiffres qui changent le modèle

| Mesure | Valeur | Conséquence |
|---|---|---|
| Courses analysées | 37 sur 5 réunions | ~7,4 courses par réunion |
| **Peloton médian** | **14 partants** | Le hasard place à 21 %, pas à 37 % |
| Champs ≥ 8 partants | **92 %** | 3 places payées presque toujours |
| Courses avec recul | 20 / 37 (54 %) | L'indicateur recul est central |
| Amateurs / apprentis | 1 à 2 par réunion | Niveau de dispersion plus élevé |
| Disciplines | 35 attelé, 2 monté | Grenade est du trot attelé |

**Le peloton médian de 14 est le chiffre le plus important.** Tous les seuils
avaient été calibrés sur 8 partants. Avec 14 chevaux et 3 places :

- un cheval au hasard place **21 %** du temps (contre 37 % à 8 partants) ;
- très peu de chevaux dépassent 50 % de probabilité de place ;
- les rapports placés sont mécaniquement **plus longs** — la zone rentable
  remonte vers 2,00–4,00 au lieu de 1,80–2,50 ;
- le plancher de 1,45 ne bloque presque plus rien : c'est le seuil de value
  à 12 % qui fait tout le travail.

**Réglage corrigé** : proba de place minimale ramenée de 50 % à **35 %**.
À 50 % le mode Régularité ne se serait quasiment jamais déclenché.

### Drivers de Grenade

Relevé de présence sur les 37 courses, consultable dans Réglages :
F. CLOZIER (25 drives), M. CRIADO (24), X. CHARLOT (22), D. LAISIS (21),
B. GOETZ (21), J. CHAVATTE (21), V. FOUCAULT (20)…

Les 7 premiers assurent environ un tiers des drives. Ce n'est pas un taux de
réussite — c'est la connaissance de la piste, qui justifie le coefficient ×1,35
sur l'indicateur « driver sur cet hippodrome ».

### Outils ajoutés

- `parse_programme.py` — convertit les programmes PDF en JSON et en format de collage
- `drivers-grenade.json` — le relevé brut
- `push.ps1` — publication GitHub en une commande, incrémente le cache du service worker

---

## v7 — base d'entraînement PMU, toutes disciplines

### Pourquoi une base extérieure à Grenade

Vérifié sur l'API PMU : le 23/11/2025, Grenade **n'y figure pas du tout**
(réunion 100 % PMH). Le 15/08/2026, une seule course sur sept y apparaît —
celle qui portait le Quarté. L'API PMU ne peut donc pas fournir l'historique
de Grenade.

Mais 37 courses n'entraîneront jamais 14 poids. L'API PMU donne accès à des
milliers de courses aux **variables strictement identiques** : musique, gains,
driver, entraîneur, cotes, arrivée, rapports placés définitifs. On entraîne
là-dessus, on applique à Grenade avec ses multiplicateurs de piste propres.

### collecte_pmu.py

```powershell
pip install requests

python collecte_pmu.py estimer   --debut 2024-08-01 --fin 2026-08-15
python collecte_pmu.py collecter --debut 2024-08-01 --fin 2026-08-15
python collecte_pmu.py stats
python collecte_pmu.py exporter --limite 4000
```

Mesuré : **~52 courses par jour** en France, toutes disciplines. Sur 2 ans,
~38 000 courses et ~77 000 requêtes, soit **2 à 3 heures** avec 3 threads.
Cache disque, reprise automatique après Ctrl-C ou coupure réseau.

**L'étape `stats` est celle qui justifie le volume.** L'API ne donne pas les
taux de réussite : ils se calculent. Sur 3 000 courses on obtient un taux de
place fiable par driver, par entraîneur, et par couple driver × hippodrome —
exactement les colonnes `%driver`, `%driver_ici` et `%entraîneur` du collage.
Un taux calculé sur 20 drives ne vaut rien, sur 400 il devient un indicateur.

`exporter` limite à 4 000 courses par défaut, les plus récentes : au-delà, le
JSON dépasse la capacité de stockage du navigateur.

### Backtest passé en calcul analytique

Rejouer 3 000 courses en Monte-Carlo aurait figé le navigateur, et
l'optimiseur — 192 évaluations du jeu d'entraînement — aurait tourné des
heures. Le backtest et l'optimiseur utilisent désormais la **formule de
Harville**, exacte et déterministe.

Mesuré : **3 000 courses rejouées en 52 ms**. Écart avec le Monte-Carlo à
30 000 tirages : moins de 0,6 point sur chaque probabilité — c'est le bruit
de la simulation, pas une erreur de la formule.

Le Monte-Carlo reste utilisé pour l'analyse d'une course en direct, où il
fournit aussi les probabilités jointes.

L'optimiseur sous-échantillonne au-delà de 900 courses d'entraînement : le
gain de précision y est nul et le coût, lui, ne l'est pas.


---

## Calendrier de Grenade — ce qu'il faut savoir

L'hippodrome de Marianne annonce **9 réunions de trot par an**, et le relevé des
réunions passées montre une saison très concentrée :

    25/10 · 02/11 · 23/11 · 07/12 · 14/12 · 21/12 · 25/01 · … · 15/08

Autrement dit : **d'octobre à fin janvier**, plus la grande réunion d'été du
15 août. Entre février et septembre, la piste est quasiment muette.

Conséquence pratique : après le 15 août, il faut attendre **fin octobre** pour
la reprise. Ce n'est pas une saison où l'on accumule des données vite — raison
de plus pour entraîner le modèle sur la base PMU (`collecte_pmu.py`) plutôt que
d'attendre Grenade.

Les deux sources à surveiller pour les dates :
- `hippodromegrenade.com/les-courses/` — la société de courses elle-même
- `letrot.com/hippodromes/grenade-sur-garonne/3102` — fiche officielle LeTROT
- `fnch.fr/federation-sud-ouest/programme-des-courses` — programmes PDF téléchargeables
