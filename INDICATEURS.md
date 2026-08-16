# Les indicateurs — ce qui est implémenté, ce qui reste à faire

Cadre de réflexion pour le simple placé au trot attelé, à Grenade (PMH, sable,
corde à gauche) et Carcassonne (herbe, corde à droite, finale de 240 m).

**Principe de tri** : un indicateur mérite une place s'il est (1) disponible avant
la course, (2) pas déjà contenu dans la cote, (3) discriminant pour la PLACE et pas
seulement pour la victoire. Beaucoup d'indicateurs classiques échouent au test (2) :
le marché les connaît déjà.

---

## Niveau 1 — implémenté (v3)

### Dérivés gratuitement de la musique
Aucune saisie supplémentaire, quatre signaux extraits d'une seule chaîne.

| Indicateur | Poids | Ce qu'il capte |
|---|---|---|
| **Forme récente** | 18 | Moyenne pondérée décroissante (0,78^i) des 8 dernières |
| **Régularité** | 20 | % de top 3. **Le plus important en mode placé** — un cheval qui finit 2e-3e-2e vaut mieux qu'un cheval qui fait 1er-8e-D |
| **Fiabilité** | 12 | Taux de D/A/T. Spécifique au trot : un cheval qui galope ne place jamais. Un dérapeur à 20 % perd 1 chance sur 5 avant même de courir |
| **Tendance** | 8 | Moyenne des 2 dernières moins les 3 précédentes. Détecte les chevaux en progrès et ceux qui régressent |

*Vérifié : `8a7a2a1a1a` sort une tendance de −70 — le cheval a bien régressé, même si sa musique « a l'air » bonne.*

### Homme
| Indicateur | Poids | Note |
|---|---|---|
| **Réussite driver** | 10 | % de places sur 12 mois glissants |
| **Driver sur cet hippodrome** | 8 | ×1,35 à Grenade, ×0,7 à Carcassonne. Une piste de 1 175 m corde à gauche se connaît ; 2 réunions par an à Carcassonne, personne ne la connaît |
| **Réussite entraîneur** | 7 | |

### Cheval
| Indicateur | Poids | Note |
|---|---|---|
| **Gains par course (log)** | 11 | Meilleur proxy de niveau que les gains bruts |
| **Réduction kilométrique** | 8 | Pointe de vitesse. Volontairement dégradé de 20/12 → 8 en mode placé : la vitesse gagne, la régularité place |
| **Distance de recul** | 9 | ×1,45 à Grenade — sur 1 175 m, 25 m de recul c'est 2 % du parcours à rattraper |
| **Déferrage** | 6 | 0/1/2/3. Les 4 pieds pèsent le plus |
| **Fraîcheur** | 6 | Cloche log centrée sur 22 jours |
| **Âge** | 5 | Parabole centrée sur 6,5 ans, écart-type 2,6 |
| **Références sur l'hippodrome** | 7 | Nb de places déjà réalisées sur place. ×1,30 à Grenade |

### Contexte — ne classe pas, disperse
Le terrain ne désigne pas un gagnant, il change la **variance**. C'est modélisé
comme un facteur sur la température du softmax :

| Terrain | T | Effet |
|---|---|---|
| Bon | ×1,00 | — |
| Souple | ×1,10 | régularité +10 %, vitesse −10 % |
| Collant | ×1,22 | régularité +20 %, vitesse −20 %, gains +10 % |
| Lourd | ×1,38 | régularité +30 %, vitesse −30 %, gains +20 %, fiabilité +25 % |

**Amortissement sable** : à Grenade, l'effet terrain est divisé par deux. Le sable
draine, l'herbe non. Terrain lourd → probabilités aplaties → moins de paris
déclenchés. C'est voulu : quand la course est plus imprévisible, on parie moins.

Météo récupérée automatiquement via **Open-Meteo** (gratuit, sans clé, sans
restriction d'usage), cumul de pluie sur 48 h, dans l'appli comme dans `collecte.py`.

---

## Niveau 2 — à ajouter quand vous aurez les données

Classés par rapport signal/coût de collecte.

**Fort signal, collecte facile**
1. **Driver amateur vs professionnel** — très discriminant en PMH, où beaucoup de
   drives sont amateurs. Binaire, lisible sur le programme.
2. **Changement de driver** vs sortie précédente. Un upgrade vers un meilleur driver
   est un signal d'intention de l'entraîneur.
3. **Changement de déferrage** vs sortie précédente. Déferrer pour la première fois
   depuis 3 courses = intention claire. Le déferrage absolu compte moins que sa variation.
4. **Nombre de drives du driver dans la réunion** — avec 5 montes, il a choisi. Sa
   monte sur la course la mieux dotée est un indice.
5. **Type de course** : conditions / handicap / amateurs / apprentis. Change la
   dispersion attendue.
6. **Autostart vs volte** — l'autostart réduit les fautes et augmente le poids de la corde.

**Fort signal, collecte lourde**
7. **Association driver × cheval** (historique du couple). Nécessite une base.
8. **Distance écurie → hippodrome**. Un entraîneur qui fait 300 km pour un seul
   cheval y croit. Excellent signal, calculable avec les coordonnées de l'écurie.
9. **Charge de travail** : nombre de courses sur 60 jours.
10. **Dispersion des gains dans la course** — mesure si la course est serrée ou si
    un cheval domine. Devrait moduler T comme le terrain.

**Signal douteux — à tester avant d'y croire**
- Vent : la ligne droite de Grenade fait 300 m, mais un vent de 15 km/h déplace peu un sulky.
- Température : effet réel au-delà de 32 °C seulement (le 15/08/2025 il faisait 37,4 °C à Grenade).
- Sexe, robe, pedigree : largement intégrés dans la cote.
- Casaque, numéro « porte-bonheur », statistiques de propriétaire : bruit.

---

## Le piège à connaître

**Chaque indicateur ajouté augmente le risque de surapprentissage.** Avec 40 courses
(≈ 320 lignes cheval), au-delà de 12-15 poids libres vous ajustez le bruit. C'est
pourquoi l'optimiseur de la v3 :

- découpe en 70 % entraînement / 30 % test **par ordre chronologique**, jamais au hasard ;
- affiche uniquement la log-loss **hors échantillon** ;
- régularise vers les poids par défaut (pénalité quadratique, coefficient 0,02) ;
- refuse de tourner en dessous de 15 courses ;
- vous laisse **ne pas appliquer** les poids si le gain hors échantillon est nul ou négatif.

Si l'optimisation n'améliore rien hors échantillon, la bonne conclusion n'est pas
« il faut plus d'indicateurs » mais « il faut plus de courses ».
