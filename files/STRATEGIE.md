# Votre stratégie — réglages appliqués et raisonnement

Valeurs désormais chargées par défaut (elles écrasent une fois vos anciens réglages) :

| Réglage | Valeur | Rôle |
|---|---|---|
| Mode | **Value** | Ne parie que si l'espérance est positive |
| Rapport placé mini | **1,45** | Garde-fou : élimine les rapports indéfendables |
| Proba de place mini | **50 %** | Évite les coups de poker |
| Seuil de value | **12 %** | Marge d'erreur du modèle — c'est lui qui décide vraiment |
| Fraction Kelly | 0,25 | Quart de Kelly, prudent |
| Mise max | 3 % de bankroll | Plafond dur |

---

## 1. Le point mort n'est pas un chiffre fixe

**Point mort = 1 ÷ probabilité de place.** Il change à chaque cheval.

| Rapport | Point mort | Avec 12 % de marge |
|---|---|---|
| 1,30 | 77 % | 86 % — inatteignable |
| 1,45 | 69 % | 77 % |
| 1,60 | 63 % | 70 % |
| 1,80 | 56 % | 62 % |
| 2,00 | 50 % | 56 % |
| 2,50 | 40 % | 45 % |

Le 1,45 ne garantit rien : il dit seulement qu'à ce rapport, il vous faut un cheval
à 69 % de place minimum. Sur un champ de 8 partants (3 places payées), un cheval
tiré au hasard place 37,5 % du temps. 69 %, c'est presque le double du hasard.

---

## 2. Pourquoi la marge de 12 %

Votre modèle annonce 73 %. Supposons que la vérité soit 68 % — une erreur de 5 points,
tout à fait ordinaire avec 40 courses d'historique.

- Ce que vous croyez : 0,73 × 1,50 − 1 = **+9,5 %**
- La réalité : 0,68 × 1,50 − 1 = **+2 %**

Une erreur de 5 points a mangé les trois quarts de votre avantage. Sur des rapports
courts, l'erreur d'estimation pèse plus que l'avantage lui-même. Le seuil de 12 %
existe pour que seuls les écarts assez gros pour survivre à une erreur passent le
filtre.

Corollaire : **peu de paris**. Sur une réunion de 7 courses à Grenade, attendez-vous
à 0, 1 ou 2 sélections. Zéro sélection est un résultat normal, pas un bug.

---

## 3. Où se trouve réellement la value

Contre-intuitif mais solide : **la zone rentable au placé se situe entre 1,80 et 2,50**,
soit le 3ᵉ ou 4ᵉ choix du marché — pas le favori.

Deux raisons.

**a) Mécanique.** Sous 1,45, le point mort exige un taux de place que presque aucun
cheval n'atteint. Ces paris sont mathématiquement fermés, quelle que soit la qualité
de votre modèle.

**b) Comportementale.** L'argent du placé se concentre massivement sur les deux
premiers du marché. Ce que tout le monde mise est trop cher ; ce que personne ne
regarde est trop payé. Le biais est documenté depuis longtemps sur les paris
mutuels : les cotes courtes sont sous-payées, les cotes moyennes correctement ou
sur-payées.

Résultat attendu de votre configuration : un taux de réussite autour de **50-60 %**,
pas 75 %. Vous perdrez plus souvent qu'avec la stratégie du favori — et c'est
précisément dans cette zone que le gain est possible.

---

## 4. Le piège spécifique à Grenade

Grenade tourne en **PMH** : pool placé d'environ 1 200 €. Vous n'êtes pas face à un
bookmaker qui encaisse votre pari, vous entrez dans un pot que vous vous partagez
ensuite.

Exemple concret :

- Rapport annoncé : **1,50** — pool 1 200 €, 3 places
- Enjeu déjà placé sur ce cheval : (1 − 0,175) × 1 200 ÷ (3 × 1,50) ≈ **220 €**
- Vous ajoutez **30 €**
- Nouveau rapport : 0,825 × 1 230 ÷ (3 × 250) = **1,35**

Votre value de +12 % vient de tomber à +1 %. Vous avez fait le travail d'analyse et
c'est votre propre argent qui l'a annulé.

L'appli calcule ce rapport dilué, l'affiche à côté du rapport annoncé, et **annule la
mise** si la dilution mange plus de la moitié de la value. Depuis cette version, le
plancher de 1,45 s'applique au **rapport dilué**, pas au rapport annoncé.

Conséquence pratique : sur un pool de 1 200 €, ne dépassez pas 15 à 20 € par pari.
Au-delà, vous pariez contre vous-même. Ajustez le champ « Pool placé estimé » selon
ce que vous constatez aux guichets — c'est le paramètre le plus important de l'onglet
Course, et personne d'autre que vous ne peut le renseigner.

---

## 5. Ce qu'il faut regarder dans l'appli

Sur chaque cheval, la ligne sous le nom affiche maintenant :

```
placé 1,80 · point mort 1,61 au-dessus
```

Vert « au-dessus » = le rapport dépasse le point mort, le pari a un sens.
Rouge « en dessous » = même si le cheval est le meilleur de la course, ce rapport
vous fait perdre.

Le taux de réussite seul ne dit rien. Le couple **taux de réussite + ROI**, dans
l'onglet Suivi, dit tout.
