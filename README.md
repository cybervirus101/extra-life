# 🎮 Kit Streamer Extra Life — Overlays & Alertes OBS

Boîte à outils complète pour streamers Twitch et YouTube afin d'afficher leurs résultats de dons en direct dans OBS Studio et Streamlabs, au profit d'**Opération Enfant Soleil (Extra Life)**.

---

## 🌟 Fonctionnalités Principales

1. **Zéro-Code & Auto-Détection** :
   - Le streamer saisit uniquement son **ID Extra Life** (ou colle son lien) sur le configurateur web : `https://cybervirus101.github.io/extra-life/`
   - L'outil interroge automatiquement l'API DonorDrive pour auto-compléter son pseudo, avatar, objectif, cagnotte d'équipe et défis/jalons officiels.

2. **3 Modes de Collecte au choix** :
   - **Solo** : Affiche uniquement la jauge et l'objectif individuel du streamer.
   - **Équipe** : Affiche la cagnotte globale de l'équipe (`teamID`).
   - **Alternance douce (Recommandé)** : Bascule fluide toutes les 12-20 secondes entre l'objectif personnel et l'objectif global de l'équipe avec animation douce.

3. **Source Alerte de Don Indépendante (`alert.html`)** :
   - Pop-up lumineux festif avec rayonnement solaire / néon gamer et logo officiel.
   - Jingle carillon doux généré automatiquement via Web Audio API (aucun risque de fichier manquant).
   - Positionnable n'importe où dans OBS indépendamment de la barre.
   - Gestion de file d'attente (aucun don superposé ou manqué lors d'afflux de dons).

4. **Jalons Extra Life Intégrés (*Milestones*)** :
   - Affiche automatiquement le prochain palier de défi à atteindre (ex: *« Palier 500 $ CAD : Défi piment »*).

5. **Simulateur de Dons OBS en direct** :
   - Bouton de test sur la page d'accueil pour déclencher un don fictif instantané et calibrer le cadrage et le volume dans OBS sans attendre un vrai don.

6. **Kit Twitch 100% Liens & Panneaux** :
   - Texte Markdown prêt à coller dans Twitch avec les liens de don insérés.
   - Générateur de bannière d'en-tête Twitch 320x210 conforme aux normes.
   - Commandes pour chatbots (`!don`, `!equipe`).

---

## 🚀 Utilisation dans OBS Studio / Streamlabs

### Méthode Web (Recommandée — Zéro installation)

1. Ouvrez le configurateur web :  
   👉 **`https://cybervirus101.github.io/extra-life/`**
2. Entrez votre ID de participant Extra Life et personnalisez vos options.
3. Copiez les liens générés et collez-les dans OBS en ajoutant des **Sources Navigateur (Browser Source)** :

| Source | Fichier | Dimensions recommandées | Description |
| :--- | :--- | :--- | :--- |
| **Barre de dons** | `overlay.html` | **`1920 x 140`** *(ou 850 x 240)* | Jauge, conversion CAD, dernier don et carrousel |
| **Alerte Pop-up** | `alert.html` | **`800 x 400`** *(Centré)* | Pop-up sonore et visuel lors d'un nouveau don |

---

## ⚙️ Paramètres d'URL avancés pour `overlay.html`

| Paramètre | Valeurs | Description |
| :--- | :--- | :--- |
| `participantID` | `582063`, etc. | Identifiant du participant Extra Life |
| `teamID` | `12345`, etc. | Identifiant de l'équipe (auto-détecté si le participant est en équipe) |
| `mode` | `alternance` (défaut), `participant`, `team` | Mode d'affichage de la barre |
| `interval` | `12`, `15`, `20` | Intervalle en secondes lors de l'alternance douce |
| `theme` | `clair` (défaut), `sombre` | Thème Blanc chaud (#FAF7F0) ou Noir velours (#252625) |
| `layout` | `auto`, `horizontal`, `vertical` | Forcer l'agencement horizontal ou colonne verticale |
| `milestones`| `true` (défaut), `false` | Afficher ou masquer le badge du prochain défi |
| `demo` | `true`, `1` | Activer le mode démo avec faux dons pour prévisualiser |

---

## 📁 Structure des fichiers

```text
overlay-enfant-soleil/
├── index.html                             # Configurateur web & hub streamer (Page d'accueil)
├── overlay.html                           # Overlay barre de progression OBS
├── alert.html                             # Source alerte pop-up de don OBS (audio + visuel)
├── style.css                              # Charte graphique officielle Enfant Soleil
├── script.js                              # Logique DonorDrive API, alternance, conversion CAD
├── assets/
│   ├── logo-enfant-soleil-horizontal.png  # Logo officiel partenaire horizontal
│   └── logo-enfant-soleil-vertical.png    # Logo officiel partenaire vertical
└── README.md                              # Guide complet
```
