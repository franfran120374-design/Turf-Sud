# Turf Sud — guide complet

De la première ouverture au premier ticket. Tout ce qui se passe dans l'appli,
et pourquoi.

---

## Sommaire

1. [Première ouverture](#1-première-ouverture)
2. [Comment l'appli raisonne](#2-comment-lappli-raisonne)
3. [Les quatre onglets](#3-les-quatre-onglets)
4. [Avant la réunion : préparer une course](#4-avant-la-réunion--préparer-une-course)
5. [Lire l'écran d'analyse](#5-lire-lécran-danalyse)
6. [Au guichet](#6-au-guichet)
7. [Après la course](#7-après-la-course)
8. [Entraîner le modèle](#8-entraîner-le-modèle)
9. [Les réglages, un par un](#9-les-réglages-un-par-un)
10. [Erreurs fréquentes](#10-erreurs-fréquentes)
11. [Aide-mémoire](#11-aide-mémoire)

---

## 1. Première ouverture

**Adresse** : `https://franfran120374-design.github.io/Turf-Sud/`
(majuscules comprises, l'URL est sensible à la casse)

**Installer sur le téléphone** — Chrome Android → menu ⋮ → *Ajouter à l'écran
d'accueil*. L'appli s'ouvre alors en plein écran, sans barre d'adresse, et
fonctionne **hors ligne**. Ce n'est pas un gadget : la couverture réseau sur
l'hippodrome de Marianne est mauvaise, et vous préparerez vos courses avant
d'y aller.

**Vos données restent sur votre appareil.** Aucun serveur, aucun compte.
Corollaire : si vous videz les données du navigateur, tout disparaît. Faites
un export de temps en temps (Réglages → Exporter).

En haut, deux boutons : **Grenade** et **Carcassonne**. Le choix change les
coefficients du modèle. Choisissez avant de saisir quoi que ce soit.

---

## 2. Comment l'appli raisonne

Six étapes, dans cet ordre. Vous n'avez rien à faire, mais savoir ce qui se
passe change la façon de lire les résultats.

### Étape 1 — Comparer les chevaux entre eux

Pour chaque indicateur (forme, régularité, gains…), l'appli calcule un
**z-score** : à combien d'écarts-types ce cheval se situe de la moyenne **de
cette course-là**.

C'est le point clé : rien n'est comparé dans l'absolu. Un cheval avec 1 800 €
de gains par course est excellent dans une course d'amateurs et faible dans un
Grand Prix. Le z-score règle ça tout seul.

**Conséquence pratique : un champ vide ne pénalise jamais un cheval.** Il reçoit
simplement z = 0, la moyenne. Vous pouvez donc remplir 3 colonnes sur 17 et
obtenir un résultat utilisable.

### Étape 2 — Additionner selon les poids

Chaque z-score est multiplié par son poids, puis par le coefficient de piste.
Exemple à Grenade : le recul compte ×1,45, parce que sur une piste de 1 175 m,
25 mètres de retard représentent 2 % du parcours.

### Étape 3 — Transformer en probabilités

Le total passe dans une fonction *softmax* : les scores deviennent des
probabilités qui font 100 % ensemble.

Le réglage **Tranchant (T)** commande l'écartement. Bas = le favori écrase.
Haut = tout le monde se tient.

### Étape 4 — Mélanger avec le marché

Les cotes contiennent le travail de milliers de parieurs. Les ignorer serait
prétentieux. L'appli mélange votre modèle et le marché selon **λ** (0,40 par
défaut : 40 % modèle, 60 % marché).

### Étape 5 — Simuler des arrivées

La probabilité de **place** ne se déduit pas d'une formule simple. L'appli tire
30 000 ordres d'arrivée complets (méthode Plackett-Luce) et compte combien de
fois chaque cheval finit dans les places.

Pourquoi ce détour : deux chevaux se disputent **les mêmes places**. Multiplier
deux probabilités donnerait un résultat faux — vérifié, l'écart atteint 3 points
sur un couplé placé.

### Étape 6 — Décider

Pour chaque cheval :

```
point mort = 1 ÷ probabilité de place
value      = probabilité × rapport − 1
```

Le pari n'est proposé que si le rapport dépasse le point mort d'une marge
suffisante (le seuil de value, 12 % par défaut).

---

## 3. Les quatre onglets

| Onglet | À quoi il sert | Quand |
|---|---|---|
| **Course** | Saisir les partants | Avant la réunion |
| **Analyse** | Lire la sélection | Juste avant le départ |
| **Suivi** | Arrivées, résultats, backtest | Après, et le soir |
| **Réglages** | Stratégie, poids, données | Une fois, puis rarement |

---

## 4. Avant la réunion : préparer une course

### 4.1 Le cadre

Onglet **Course**, bloc *La course* :

- **Date** — sert aussi à récupérer la météo
- **Discipline** — Grenade ne propose que le trot, c'est normal
- **Distance** — 2 125 ou 2 725 m à Grenade la plupart du temps
- **Pool placé estimé** — laissez 1 200 € ; sans effet si vous misez 3 €

### 4.2 Terrain et météo

Bouton **Récupérer la météo de cette date**. L'appli interroge Open-Meteo,
calcule le cumul de pluie sur 48 h et en déduit l'état du terrain.

**Ce que ça change** : rien au classement, tout à la dispersion. Terrain lourd
= plus de surprises = probabilités aplaties = moins de paris déclenchés.
C'est voulu : quand une course devient imprévisible, on parie moins.

Le sable de Grenade encaisse la pluie deux fois mieux que l'herbe de
Carcassonne — l'effet y est divisé par deux.

Si vous voyez la piste de vos yeux, corrigez à la main. Votre œil vaut mieux
qu'une estimation à partir de millimètres de pluie.

### 4.3 Saisir les partants

**Format du collage rapide**, une ligne par cheval, séparateur `;` :

```
num;nom;cote;cote_placé;musique;%driver;%driver_ici;%entraineur;gains;réduc_km;recul;déferré;jours;âge;apt_piste;corde;poids
```

Exemple :

```
3;TOSCANE DU LAURAGAIS;3.1;1.5;1a1a4a2a2a;24;27;19;3300;73.9;25;3;18;5;3;;
```

Le bouton **Exemple** remplit la zone avec 8 chevaux fictifs : servez-vous-en
pour voir le format avant de saisir les vrais.

**Où trouver chaque champ**

| Champ | Source | Indispensable ? |
|---|---|---|
| num, nom | Programme | Oui |
| **musique** | Programme, colonne Performances | **Le plus important** |
| cote, cote placé | Écrans du totalisateur, sur place | Oui pour la value |
| %driver, %entraîneur | `stats_pmu.json` après la collecte | Très utile |
| %driver ici | idem, colonne « driver × hippodrome » | Utile |
| gains | Programme ÷ nombre de courses | Utile |
| réduction km | Presse spécialisée | Secondaire |
| recul | Programme : 2 750 au lieu de 2 725 → 25 | Important à Grenade |
| déferré | 0 ferré, 1 antérieurs, 2 postérieurs, 3 quatre pieds | Utile |
| jours, âge | Programme | Secondaire |
| apt_piste | Vos notes : places déjà réalisées ici | Utile |
| corde, poids | Plat et obstacle uniquement | Selon discipline |

**Si vous n'avez que la musique et les cotes, saisissez ça.** Le résultat sera
moins fin, pas faux.

Collez, cliquez **Charger les partants**. L'appli affiche le nombre de partants
et le nombre de places payées : **3 places dès 8 partants**, 2 places de 4 à 7,
aucun placé en dessous de 4.

Cliquez sur un cheval pour corriger un champ. Puis **Analyser →**.

---

## 5. Lire l'écran d'analyse

### 5.1 Le bloc vert du haut — la sélection

C'est la réponse. Un cheval, ou rien.

```
n°3  TOSCANE DU LAURAGAIS
rapport 1,80 · mise 3,00 €

Chance de place   62 %
Rapport d'équilibre   1,61
```

**Le rapport d'équilibre est le chiffre qui décide.** À 62 % de chance de place,
il faut au moins 1,61 pour ne rien perdre à long terme. Le rapport proposé est
1,80 : au-dessus, le pari a un sens.

Si le rapport avait été 1,50, vous auriez gagné 62 % du temps **et perdu de
l'argent**. Le taux de réussite seul ne dit rien.

### 5.2 « Aucune sélection »

Ce n'est pas une panne. C'est le cas le plus fréquent.

Sur une réunion de 7 courses à Grenade, attendez-vous à **0, 1 ou 2 paris**.
Le seuil de 12 % ne laisse passer que les écarts assez gros pour survivre à une
erreur du modèle.

Passer une course est une décision, pas un échec.

### 5.3 Le classement

Chaque cheval affiche une barre à deux étages :

- **haut, vert** : la probabilité de place selon le modèle
- **bas, gris** : la même selon le marché (déduite des cotes)

Vert plus long que gris = le modèle estime le cheval sous-évalué. C'est là que
se trouve la value.

Le **trait vertical** marque la probabilité de place d'un cheval tiré au hasard.
Sur 14 partants et 3 places : 21 %. Tout ce qui est à gauche du trait fait moins
bien que le hasard.

Sous chaque nom :

```
placé 1,80 · point mort 1,61 au-dessus
```

**Vert « au-dessus »** = le rapport dépasse le point mort.
**Rouge « en dessous »** = même si c'est le meilleur cheval de la course, ce
rapport vous fait perdre.

### 5.4 Enregistrer

Bouton **Enregistrer** en bas. À faire **avant** la course, systématiquement,
même sans pari.

Cela conserve les données brutes : le backtest pourra rejouer cette course avec
un modèle amélioré. Sans ça, la course est perdue pour l'apprentissage.

---

## 6. Au guichet

Vous demandez : *« Simple placé, cheval numéro 3, 3 euros. »*

C'est tout. Pas de couplé, pas de trio — l'appli ne les calcule plus, c'est un
choix assumé : le simple placé maximise la fréquence des gains.

**Misez tard.** Dans les deux dernières minutes, les rapports probables sont
quasi définitifs. Un rapport annoncé à 1,90 vingt minutes avant peut finir à
1,55 au départ, et votre pari n'a alors plus de sens. Vérifiez le rapport réel
avant de valider.

---

## 7. Après la course

Onglet **Suivi**, section *Historique*. Deux champs par course :

- **Arrivée** : `3-1-7`
- **Rapports** (facultatif) : `1.80/2.40/3.10`, dans le même ordre

Les rapports réels rendent le calcul de ROI exact. Sans eux, l'appli utilise le
rapport probable enregistré — une approximation.

### Ce que le bloc *Résultats réels* vous dit

| Chiffre | Signification |
|---|---|
| **Taux de réussite** | Fréquence des gains |
| **ROI réel** | Ce que vous gagnez ou perdez |
| **Brier modèle / marché** | Qualité des probabilités — **plus bas = mieux** |

Le Brier est le juge de paix. **Si le vôtre reste au-dessus de celui du marché
après 40 courses, le modèle n'apporte rien et il ne faut pas miser.** Il s'affiche
en vert quand vous battez le marché.

Taux élevé et ROI négatif ? Vous visez juste mais vous payez trop cher : montez
le rapport plancher.

### La calibration

Sur les chevaux annoncés à 45-60 %, en placent-ils vraiment 45-60 % ?

Comptez **100 lignes par tranche** avant d'en tirer quoi que ce soit. En dessous,
c'est du bruit.

---

## 8. Entraîner le modèle

### 8.1 Charger la base

Onglet **Suivi** → bloc *Base d'entraînement* → **Charger**.

Quelques secondes, et vous avez plusieurs milliers de courses réelles avec leurs
arrivées. Elle vient de votre propre site, produite par `collecte_pmu.py`.

La base reste **en mémoire** : elle disparaît si vous fermez l'appli, et se
recharge en un clic. Vos courses à vous, elles, sont enregistrées.

**Pourquoi des courses de Vincennes pour parier à Grenade ?** Parce que 37 courses
n'entraîneront jamais 14 poids. Les variables sont identiques partout — musique,
gains, driver, cotes. On apprend les poids de base sur le volume, et les
coefficients propres à Grenade restent appliqués à Grenade seulement.

### 8.2 Rejouer l'historique

Applique le modèle actuel à toutes les courses disponibles.

| Résultat | Lecture |
|---|---|
| **Top 1 placé** | Fréquence où le mieux noté a placé |
| **Brier place** | Qualité des probabilités |
| **ROI si misé** | Ce que ça aurait rapporté |

### 8.3 Apprendre les poids

L'appli ajuste les 14 poids pour mieux coller aux arrivées. Avec des garde-fous :

- découpage **chronologique** 70 / 30 — on apprend sur le passé, on teste sur
  ce qui vient après, jamais au hasard
- seule la performance **hors échantillon** est affichée
- régularisation vers les poids par défaut
- refus de tourner sous 15 courses

**Ne regardez que le gain hors échantillon.** S'il est nul ou négatif,
**n'appliquez pas les poids** — le bouton vous le permet quand même, exprès,
mais ce serait apprendre le passé par cœur.

Si l'optimisation n'améliore rien, la conclusion n'est pas « il faut plus
d'indicateurs » mais « il faut plus de courses ».

---

## 9. Les réglages, un par un

### Stratégie

| Réglage | Défaut | Effet |
|---|---|---|
| **Mode** | Value | Ne parie que si l'espérance est positive |
| **Proba de place mini** | 35 % | Recalé sur les pelotons de 14 de Grenade |
| **Rapport placé mini** | 1,45 | Garde-fou contre les rapports indéfendables |

Le mode **Régularité** existe si vous voulez privilégier la fréquence : il prend
la meilleure probabilité de place au-dessus des deux planchers, sans exiger de
value. Vous gagnerez plus souvent, et probablement moins.

### Modèle

| Réglage | Défaut | Effet |
|---|---|---|
| **λ** | 0,40 | 0 = recopier les cotes, 1 = ignorer le marché |
| **Tranchant T** | 1,2 | Bas = probabilités contrastées |
| **Simulations** | 30 000 | Plus = moins de bruit, un peu plus lent |

Au-delà de λ = 0,5 vous pariez contre une foule mieux informée que vous.

### Mises

| Réglage | Défaut |
|---|---|
| **Mise fixe** | 3 € — même montant à chaque fois |
| **Seuil de value** | 12 % — c'est lui qui fait tout le travail |

Mettez 0 en mise fixe pour repasser en mise proportionnelle (Kelly), dans les
réglages avancés.

### Données

**Exporter** régulièrement. C'est votre seule sauvegarde.

---

## 10. Erreurs fréquentes

**« Aucune sélection » à chaque course**
Normal. Si ça dure sur 20 courses, baissez le seuil de value à 8 % — mais
surveillez le ROI, vous entrez dans la zone où l'erreur d'estimation domine.

**Le classement paraît absurde**
Vérifiez la musique. C'est le premier indicateur en poids, et une colonne
décalée dans le collage fausse tout. Ouvrez un cheval et regardez ses champs.

**Les rapports placés affichés sont bizarres**
Si vous n'avez pas saisi les rapports probables, ils sont **estimés** à partir
des cotes gagnant — mention « est. » à côté. Ce sont des estimations, pas des
rapports.

**« Rejouer l'historique » ne trouve rien**
Il faut des courses avec une arrivée **et** des données brutes. Les courses
enregistrées depuis l'onglet Analyse en ont ; charger la base d'entraînement
en apporte des milliers.

**L'appli ne se met pas à jour après un push**
Le service worker sert l'ancienne version en cache. `push.ps1` incrémente sa
version automatiquement. Sinon : Chrome → menu → recharger en forçant.

**Le taux de réussite est bon mais le ROI est négatif**
Le cas le plus instructif. Vous choisissez bien les chevaux et vous les payez
trop cher. Montez le rapport plancher à 1,60 ou 1,80.

---

## 11. Aide-mémoire

**Avant la réunion**
Choisir la piste → date, distance → météo → coller les partants → Analyser →
Enregistrer.

**Au guichet**
Vérifier le rapport réel dans les 2 dernières minutes → simple placé, 3 €.

**Le soir**
Saisir arrivée et rapports → regarder le Brier.

**Une fois par mois**
Charger la base → Rejouer → Apprendre les poids → appliquer seulement si le
gain hors échantillon est positif → Exporter.

---

## Ce que l'appli ne fait pas

Elle ne prédit pas les arrivées. Elle estime des probabilités et les compare au
marché.

Le placé réduit la variance, il ne supprime pas l'espérance négative — et le
prélèvement y est **plus élevé** qu'au gagnant : environ 17,5 % contre 15 %.
Sans avantage réel sur le marché, la perte à long terme est arithmétique.

L'onglet Suivi existe pour trancher cette question, pas pour l'éluder. Si après
40 courses le Brier du modèle reste au-dessus de celui du marché, l'outil vous
aura rendu son plus grand service : vous dire d'arrêter.
