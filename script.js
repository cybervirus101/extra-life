/**
 * ============================================================================
 * OVERLAY EXTRA LIFE - OPÉRATION ENFANT SOLEIL
 * Gestion dynamique de l'API DonorDrive, conversion USD -> CAD et animation OBS
 * ============================================================================
 */

(function () {
  'use strict';

  // --------------------------------------------------------------------------
  // 1. CONFIGURATION & PARAMÈTRES D'URL
  // --------------------------------------------------------------------------
  const urlParams = new URLSearchParams(window.location.search);

  // Décodage des remplacements de pseudonymes passés en URL : ?overrides=Nom:Pseudo,Nom2:Pseudo2
  function parseOverrides(param) {
    const overrides = {};
    if (!param) return overrides;
    param.split(',').forEach(pair => {
      const parts = pair.split(':');
      if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
        overrides[decodeURIComponent(parts[0].trim())] = decodeURIComponent(parts[1].trim());
      }
    });
    return overrides;
  }

  const rawParticipantId = urlParams.get('participantID');
  const isPlaceholderId = !rawParticipantId ||
    rawParticipantId === 'VOTRE_ID' ||
    rawParticipantId === 'null' ||
    rawParticipantId === 'undefined' ||
    rawParticipantId.trim() === '';

  const CONFIG = {
    participantID: isPlaceholderId ? null : rawParticipantId.trim(),
    teamID: (urlParams.get('teamID') && urlParams.get('teamID') !== 'null' && urlParams.get('teamID') !== 'VOTRE_ID') ? urlParams.get('teamID').trim() : null,
    mode: (urlParams.get('mode') || 'alternance').toLowerCase(), // 'alternance' (défaut), 'participant', 'team'
    alternanceIntervalMs: (parseInt(urlParams.get('interval'), 10) || 20) * 1000, // 20 secondes par défaut
    showMilestones: urlParams.get('milestones') !== 'false' && urlParams.get('milestones') !== '0',
    forcedRate: parseFloat(urlParams.get('rate')) || null,
    forcedGoal: parseFloat(urlParams.get('goal')) || null,
    pollIntervalSeconds: parseInt(urlParams.get('refresh'), 10) || 15,
    isDemo: urlParams.get('demo') === 'true' || urlParams.get('demo') === '1' || isPlaceholderId,
    theme: (urlParams.get('theme') || 'extralife-sombre').toLowerCase(), // 'extralife-sombre' (défaut prioritaire), 'extralife-clair', 'clair', 'sombre'
    logoMode: (urlParams.get('logo') || 'auto').toLowerCase(), // 'auto', 'horizontal', 'vertical'
    layoutMode: (urlParams.get('layout') || 'auto').toLowerCase(), // 'auto', 'vertical', 'horizontal'
    carouselIntervalMs: 8000, // 8 secondes pour laisser défiler les messages confortablement
    rateRefreshIntervalMs: 60 * 60 * 1000, // 1 heure
    defaultFallbackRate: 1.38, // Taux de repli de sécurité si aucune connexion
    donationsLimit: parseInt(urlParams.get('limit'), 10) || 20, // 20 derniers dons par défaut
    donorNameOverrides: parseOverrides(urlParams.get('overrides')),
  };

  // Rétrocompatibilité : conservation de l'alias de démonstration initial
  if ((CONFIG.participantID === '582063' || CONFIG.isDemo) && !urlParams.get('overrides')) {
    CONFIG.donorNameOverrides['Maxime Champeau'] = 'katastrofyk';
  }

  // Clés de stockage local pour la résilience hors-ligne
  const STORAGE_KEYS = {
    exchangeRate: 'oes_usd_cad_rate',
    exchangeRateTime: 'oes_usd_cad_rate_time',
    lastParticipantData: 'oes_last_participant_data',
    lastTeamData: 'oes_last_team_data',
    lastMilestonesData: 'oes_last_milestones_data',
    lastDonationsData: 'oes_last_donations_data',
  };

  /**
   * Gestionnaire sécurisé de stockage local (résistant aux restrictions file:/// dans OBS Studio CEF)
   */
  const safeStorage = {
    getItem: function (key) {
      try {
        return (typeof window !== 'undefined' && window.localStorage) ? window.localStorage.getItem(key) : null;
      } catch (e) {
        return null;
      }
    },
    setItem: function (key, value) {
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem(key, value);
        }
      } catch (e) {
        // Ignorer silencieusement si l'accès au stockage est refusé par la sandbox OBS
      }
    }
  };

  /**
   * Requête JSONP résiliente pour contourner tout blocage CORS ou protocole file:/// dans OBS
   */
  function fetchJSONP(url) {
    return new Promise((resolve, reject) => {
      const cbName = 'dd_cb_' + Math.random().toString(36).substring(2, 9);
      const script = document.createElement('script');
      const sep = url.includes('?') ? '&' : '?';
      script.src = `${url}${sep}callback=${cbName}`;

      let timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Délai d'attente JSONP dépassé pour ${url}`));
      }, 10000);

      function cleanup() {
        if (timer) clearTimeout(timer);
        delete window[cbName];
        if (script.parentNode) script.remove();
      }

      window[cbName] = (data) => {
        cleanup();
        resolve(data);
      };

      script.onerror = () => {
        cleanup();
        reject(new Error(`Échec du script JSONP pour ${url}`));
      };

      document.head.appendChild(script);
    });
  }

  /**
   * Effectue un appel API standard ultra-résilient :
   * - Envoi d'une requête GET simple (sans en-tête complexe pour éviter tout rejet pré-vol CORS dans OBS Studio CEF)
   * - Ajout d'un paramètre timestamp (_t) pour forcer le rafraîchissement temps réel des nouveaux dons
   * - Replis multiples sur les différents domaines DonorDrive officiels
   */
  async function fetchWithFallback(url) {
    const sep = url.includes('?') ? '&' : '?';
    const noCacheUrl = `${url}${sep}_t=${Date.now()}`;

    // 1. Essai direct standard (CORS Simple Request, auto-autorisé par Access-Control-Allow-Origin: *)
    try {
      const res = await fetch(noCacheUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });
      if (res.ok) {
        return await res.json();
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (fetchErr) {
      console.warn(`[API] Appel direct avec horodatage échoué (${fetchErr.message}). Tentative sur l'URL brute:`, url);
    }

    // 2. Deuxième essai direct sans paramètre de requête supplémentaire
    try {
      const res2 = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });
      if (res2.ok) {
        return await res2.json();
      }
      throw new Error(`HTTP ${res2.status}`);
    } catch (err2) {
      console.warn(`[API] Appel direct brut échoué (${err2.message}) pour ${url}`);
    }

    // 3. Dernier repli de secours : JSONP si supporté par le navigateur
    try {
      return await fetchJSONP(url);
    } catch (jsonpErr) {
      console.warn(`[API] Repli JSONP non disponible (${jsonpErr.message})`);
    }

    throw new Error(`Impossible de contacter l'API Extra Life pour ${url}`);
  }

  // État local de l'application
  const state = {
    exchangeRate: CONFIG.defaultFallbackRate,
    participant: null,
    team: null,
    milestones: [],
    donations: [],
    lastSeenDonationId: null,
    currentCarouselIndex: 0,
    carouselTimer: null,
    currentAlternanceView: 'participant', // 'participant' ou 'team'
    alternanceTimer: null,
  };

  // Éléments du DOM
  const elements = {
    container: document.getElementById('overlay-container'),
    brandLogo: document.getElementById('brand-logo'),
    labelRaisedHeading: document.getElementById('label-raised-heading'),
    amountRaisedText: document.getElementById('amount-raised-text'),
    labelGoalHeading: document.getElementById('label-goal-heading'),
    amountGoalText: document.getElementById('amount-goal-text'),
    milestoneBadge: document.getElementById('milestone-badge'),
    milestoneText: document.getElementById('milestone-text'),
    progressPercentContainer: document.getElementById('progress-percent-container'),
    progressPercent: document.getElementById('progress-percent'),
    progressBarFill: document.getElementById('progress-bar-fill'),
    latestDonorBox: document.querySelector('.box-latest-donor'),
    latestDonorName: document.getElementById('latest-donor-name'),
    latestDonorAmount: document.getElementById('latest-donor-amount'),
    latestDonorTime: document.getElementById('latest-donor-time'),
    latestDonorMessage: document.getElementById('latest-donor-message'),
    latestDonorMessageLine: document.getElementById('latest-donor-message-line'),
    feedSlider: document.getElementById('feed-slider'),
  };

  /**
   * Résout le nom d'affichage d'un donateur (prise en compte des alias / remplacements personnalisés)
   * @param {string} rawName - Nom brut retourné par l'API
   * @returns {string} - Nom d'affichage corrigé
   */
  function resolveDonorDisplayName(rawName) {
    if (!rawName || !rawName.trim()) {
      return 'Donateur anonyme';
    }
    const trimmed = rawName.trim();
    if (CONFIG.donorNameOverrides) {
      if (CONFIG.donorNameOverrides[trimmed]) {
        return CONFIG.donorNameOverrides[trimmed];
      }
      const lower = trimmed.toLowerCase();
      for (const [key, val] of Object.entries(CONFIG.donorNameOverrides)) {
        if (key.trim().toLowerCase() === lower) {
          return val;
        }
      }
    }
    return trimmed;
  }

  /**
   * Nettoie et applique les alias sur la liste des dons
   * @param {Array} donations - Liste brute de dons
   * @returns {Array} - Liste avec noms d'affichage résolus
   */
  function processDonations(donations) {
    if (!Array.isArray(donations)) return [];
    return donations.map(d => ({
      ...d,
      displayName: resolveDonorDisplayName(d.displayName),
    }));
  }

  // --------------------------------------------------------------------------
  // 2. CONVERSION ET FORMATAGE DES DEVISES (USD -> CAD)
  // --------------------------------------------------------------------------

  /**
   * Formate les montants convertis en CAD uniquement : "750 $ CAD"
   * (Affichage exclusif en CAD sans symbole d'approximation selon la demande de l'utilisateur)
   * @param {number} usdAmount - Montant en USD reçu de DonorDrive
   * @param {boolean} isGoal - Indique s'il s'agit du montant de l'objectif de collecte
   */
  function formatBothCurrenciesHTML(usdAmount, isGoal = false) {
    const usd = Number(usdAmount) || 0;
    let cad = usd * state.exchangeRate;

    if (isGoal) {
      if (CONFIG.forcedGoal && !isNaN(CONFIG.forcedGoal)) {
        cad = CONFIG.forcedGoal;
      } else {
        // Pour l'objectif : Extra Life enregistre en USD entier lors de l'inscription (ex: 200 CAD -> 143 USD).
        // Si reconverti à 199.75 $ CAD, on recale sur le palier rond habituel (multiples de 5, 10, 50, 100) si l'écart est <= 1.50 $.
        const step = 5;
        const nearest = Math.round(cad / step) * step;
        if (Math.abs(cad - nearest) <= 1.50) {
          cad = nearest;
        }
      }
    } else {
      // Ajustement de précision pour corriger les micro-écarts d'arrondi (CAD -> USD lors du paiement -> CAD)
      // Ex: Un don de 20 $ CAD converti en 14.31 USD par Extra Life donne 19.99 $ CAD avec le taux en direct.
      // Si l'écart avec un montant entier est inférieur ou égal à 0.08 $, on rétablit le montant entier exact (ex: 20 $ CAD, 75 $ CAD).
      const rounded = Math.round(cad);
      if (Math.abs(cad - rounded) <= 0.08) {
        cad = rounded;
      }
    }

    const cadFormatted = cad.toLocaleString('fr-CA', {
      minimumFractionDigits: cad % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    });

    return `<span class="cur-cad">${cadFormatted}&nbsp;$ CAD</span>`;
  }

  /**
   * Récupère le taux USD -> CAD avec mise en mémoire locale de 1 heure
   */
  async function updateExchangeRate() {
    // Si l'utilisateur a forcé un taux dans l'URL (?rate=1.40)
    if (CONFIG.forcedRate && !isNaN(CONFIG.forcedRate)) {
      state.exchangeRate = CONFIG.forcedRate;
      console.log(`[Devise] Taux forcé via URL: 1 USD = ${state.exchangeRate} CAD`);
      return;
    }

    const now = Date.now();
    const cachedRate = parseFloat(safeStorage.getItem(STORAGE_KEYS.exchangeRate));
    const cachedTime = parseInt(safeStorage.getItem(STORAGE_KEYS.exchangeRateTime), 10);

    // Utilise la mémoire locale si moins d'une heure s'est écoulée
    if (cachedRate && cachedTime && (now - cachedTime < CONFIG.rateRefreshIntervalMs)) {
      state.exchangeRate = cachedRate;
      console.log(`[Devise] Taux en cache (il y a ${Math.round((now - cachedTime)/60000)} min): 1 USD = ${cachedRate} CAD`);
      return;
    }

    try {
      // 1er essai : Open Exchange Rate API (sans clé, direct CORS)
      const res = await fetch('https://open.er-api.com/v6/latest/USD');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data && data.rates && data.rates.CAD) {
        state.exchangeRate = data.rates.CAD;
        safeStorage.setItem(STORAGE_KEYS.exchangeRate, state.exchangeRate);
        safeStorage.setItem(STORAGE_KEYS.exchangeRateTime, now.toString());
        console.log(`[Devise] Nouveau taux en direct: 1 USD = ${state.exchangeRate} CAD`);
        return;
      }
    } catch (err) {
      console.warn('[Devise] 1re API de change inaccessible, tentative de repli...', err.message);
    }

    try {
      // 2e essai : Frankfurter API
      const res = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=CAD');
      if (res.ok) {
        const data = await res.json();
        if (data && data.rates && data.rates.CAD) {
          state.exchangeRate = data.rates.CAD;
          safeStorage.setItem(STORAGE_KEYS.exchangeRate, state.exchangeRate);
          safeStorage.setItem(STORAGE_KEYS.exchangeRateTime, now.toString());
          console.log(`[Devise] Taux récupéré via Frankfurter: 1 USD = ${state.exchangeRate} CAD`);
          return;
        }
      }
    } catch (err) {
      console.warn('[Devise] 2e API de change inaccessible.', err.message);
    }

    // Si tout échoue, on conserve le cache existant ou le taux de repli
    if (cachedRate) {
      state.exchangeRate = cachedRate;
    } else {
      state.exchangeRate = CONFIG.defaultFallbackRate;
    }
    console.log(`[Devise] Utilisation du taux de repli: 1 USD = ${state.exchangeRate} CAD`);
  }

  // --------------------------------------------------------------------------
  // 3. RÉCUPÉRATION DES DONNÉES DONORDRIVE (SOLO, ÉQUIPE & JALONS)
  // --------------------------------------------------------------------------

  /**
   * Récupère le profil du participant (somme totale, objectif)
   */
  async function fetchParticipant(participantID = CONFIG.participantID) {
    if (CONFIG.isDemo) {
      return getDemoParticipant();
    }
    if (!participantID) return null;

    const endpoints = [
      `https://dd.extra-life.org/api/participants/${participantID}`,
      `https://extra-life.donordrive.com/api/participants/${participantID}`,
      `https://www.extra-life.org/api/participants/${participantID}`
    ];

    let lastError = null;
    for (const url of endpoints) {
      try {
        const data = await fetchWithFallback(url);
        if (data && typeof data.fundraisingGoal !== 'undefined') {
          safeStorage.setItem(STORAGE_KEYS.lastParticipantData, JSON.stringify(data));
          return data;
        }
      } catch (err) {
        lastError = err;
        console.warn(`[Participant] Échec sur ${url}:`, err.message);
      }
    }

    throw lastError || new Error('Impossible de contacter l’API Extra Life pour le participant');
  }

  /**
   * Récupère le profil de l'équipe (somme totale, objectif global)
   */
  async function fetchTeam(teamID = CONFIG.teamID) {
    if (CONFIG.isDemo) {
      return getDemoTeam();
    }
    const targetTeamId = teamID || CONFIG.teamID;
    if (!targetTeamId) return null;

    const endpoints = [
      `https://dd.extra-life.org/api/teams/${targetTeamId}`,
      `https://extra-life.donordrive.com/api/teams/${targetTeamId}`,
      `https://www.extra-life.org/api/teams/${targetTeamId}`
    ];

    let lastError = null;
    for (const url of endpoints) {
      try {
        const data = await fetchWithFallback(url);
        if (data && typeof data.fundraisingGoal !== 'undefined') {
          safeStorage.setItem(STORAGE_KEYS.lastTeamData, JSON.stringify(data));
          return data;
        }
      } catch (err) {
        lastError = err;
        console.warn(`[Équipe] Échec sur ${url}:`, err.message);
      }
    }
    return null;
  }

  /**
   * Récupère les jalons officiels Extra Life (milestones)
   */
  async function fetchMilestones(participantID = CONFIG.participantID) {
    if (CONFIG.isDemo) {
      return getDemoMilestones();
    }
    if (!participantID) return [];

    const endpoints = [
      `https://dd.extra-life.org/api/participants/${participantID}/milestones`,
      `https://extra-life.donordrive.com/api/participants/${participantID}/milestones`,
      `https://www.extra-life.org/api/participants/${participantID}/milestones`
    ];

    for (const url of endpoints) {
      try {
        const data = await fetchWithFallback(url);
        if (Array.isArray(data)) {
          safeStorage.setItem(STORAGE_KEYS.lastMilestonesData, JSON.stringify(data));
          return data;
        }
      } catch (err) {
        // Ignorer silencieusement si les jalons ne sont pas configurés
      }
    }
    return [];
  }

  /**
   * Récupère les dons récents (Solo ou Équipe selon le mode choisi)
   */
  async function fetchDonations() {
    if (CONFIG.isDemo) {
      return getDemoDonations();
    }

    let donationEndpoints = [];
    if (CONFIG.mode === 'team' && CONFIG.teamID) {
      donationEndpoints = [
        `https://dd.extra-life.org/api/teams/${CONFIG.teamID}/donations?limit=${CONFIG.donationsLimit}`,
        `https://extra-life.donordrive.com/api/teams/${CONFIG.teamID}/donations?limit=${CONFIG.donationsLimit}`,
        `https://www.extra-life.org/api/teams/${CONFIG.teamID}/donations?limit=${CONFIG.donationsLimit}`
      ];
    } else if (CONFIG.participantID) {
      donationEndpoints = [
        `https://dd.extra-life.org/api/participants/${CONFIG.participantID}/donations?limit=${CONFIG.donationsLimit}`,
        `https://extra-life.donordrive.com/api/participants/${CONFIG.participantID}/donations?limit=${CONFIG.donationsLimit}`,
        `https://www.extra-life.org/api/participants/${CONFIG.participantID}/donations?limit=${CONFIG.donationsLimit}`
      ];
      // Si on est en alternance avec une équipe, on ajoute aussi l'endpoint équipe en repli
      if (CONFIG.mode === 'alternance' && CONFIG.teamID) {
        donationEndpoints.push(`https://dd.extra-life.org/api/teams/${CONFIG.teamID}/donations?limit=${CONFIG.donationsLimit}`);
      }
    } else if (CONFIG.teamID) {
      donationEndpoints = [
        `https://dd.extra-life.org/api/teams/${CONFIG.teamID}/donations?limit=${CONFIG.donationsLimit}`,
        `https://extra-life.donordrive.com/api/teams/${CONFIG.teamID}/donations?limit=${CONFIG.donationsLimit}`
      ];
    }

    let lastError = null;
    for (const url of donationEndpoints) {
      try {
        const data = await fetchWithFallback(url);
        if (Array.isArray(data) && data.length > 0) {
          safeStorage.setItem(STORAGE_KEYS.lastDonationsData, JSON.stringify(data));
          return data;
        } else if (Array.isArray(data)) {
          // Tableau vide reçu, on garde en mémoire si aucun autre endpoint ne fournit de dons
          return data;
        }
      } catch (err) {
        lastError = err;
        console.warn(`[Dons] Échec sur ${url}:`, err.message);
      }
    }

    throw lastError || new Error('Impossible de récupérer la liste des dons');
  }

  // --------------------------------------------------------------------------
  // 4. RENDU VISUEL & MISE À JOUR DE L'INTERFACE
  // --------------------------------------------------------------------------

  /**
   * Vérifie si deux listes de dons sont identiques pour éviter les re-rendus inutiles du carrousel
   */
  function areDonationsIdentical(arr1, arr2) {
    if (!Array.isArray(arr1) || !Array.isArray(arr2)) return false;
    if (arr1.length !== arr2.length) return false;
    for (let i = 0; i < arr1.length; i++) {
      if (arr1[i].donationID !== arr2[i].donationID || arr1[i].amount !== arr2[i].amount) {
        return false;
      }
    }
    return true;
  }

  /**
   * Déclenche une animation festive lumineuse (aux couleurs officielles) sur le dernier donateur
   */
  let alertTimer = null;
  function triggerNewDonationAlert() {
    if (!elements.latestDonorBox) return;

    elements.latestDonorBox.classList.remove('has-new-donation');
    void elements.latestDonorBox.offsetWidth; // Forcer le reflow du navigateur pour relancer l'animation
    elements.latestDonorBox.classList.add('has-new-donation');

    if (alertTimer) clearTimeout(alertTimer);
    alertTimer = setTimeout(() => {
      if (elements.latestDonorBox) {
        elements.latestDonorBox.classList.remove('has-new-donation');
      }
    }, 4500);
  }

  /**
   * Met à jour le badge du prochain jalon (milestone)
   */
  function updateMilestoneBadge() {
    if (!elements.milestoneBadge || !elements.milestoneText) return;
    if (!CONFIG.showMilestones || !state.milestones || state.milestones.length === 0) {
      elements.milestoneBadge.style.display = 'none';
      return;
    }
    const currentRaised = (state.participant ? state.participant.sumDonations : 0);
    const nextMilestone = state.milestones
      .filter(m => (m.fundraisingGoal > currentRaised && !m.isComplete))
      .sort((a, b) => a.fundraisingGoal - b.fundraisingGoal)[0];

    if (nextMilestone) {
      const cadGoal = nextMilestone.fundraisingGoal * state.exchangeRate;
      const roundedCad = Math.round(cadGoal);
      elements.milestoneText.textContent = `Palier ${roundedCad} $ : ${nextMilestone.description || 'Défi'}`;
      elements.milestoneBadge.style.display = 'inline-flex';
    } else {
      elements.milestoneBadge.style.display = 'none';
    }
  }

  /**
   * Met à jour l'affichage de la barre de progression (Solo ou Équipe)
   */
  function updateProgressDisplay() {
    let raisedUSD = 0;
    let goalUSD = 1000;
    const isTeamView = (CONFIG.mode === 'team') || 
      (CONFIG.mode === 'alternance' && state.currentAlternanceView === 'team' && (state.team || CONFIG.isDemo));

    if (isTeamView) {
      const teamData = state.team || (CONFIG.isDemo ? getDemoTeam() : null);
      raisedUSD = teamData ? (teamData.sumDonations || 0) : 0;
      goalUSD = teamData ? (teamData.fundraisingGoal || 5000) : 5000;

      if (elements.labelRaisedHeading) {
        const teamName = teamData && teamData.name ? teamData.name : 'Équipe';
        elements.labelRaisedHeading.textContent = `Équipe : ${teamName}`;
      }
      if (elements.labelGoalHeading) {
        elements.labelGoalHeading.textContent = 'Objectif Équipe';
      }
    } else {
      raisedUSD = state.participant ? (state.participant.sumDonations || 0) : 0;
      goalUSD = state.participant ? (state.participant.fundraisingGoal || 1000) : 1000;

      if (elements.labelRaisedHeading) {
        elements.labelRaisedHeading.textContent = (CONFIG.mode === 'alternance') ? 'Mon total' : 'Total amassé';
      }
      if (elements.labelGoalHeading) {
        elements.labelGoalHeading.textContent = (CONFIG.mode === 'alternance') ? 'Mon objectif' : 'Objectif';
      }
    }

    // Calculs en CAD
    let cadRaised = raisedUSD * state.exchangeRate;
    const roundedRaised = Math.round(cadRaised);
    if (Math.abs(cadRaised - roundedRaised) <= 0.08) {
      cadRaised = roundedRaised;
    }

    let cadGoal = goalUSD * state.exchangeRate;
    if (!isTeamView && CONFIG.forcedGoal && !isNaN(CONFIG.forcedGoal)) {
      cadGoal = CONFIG.forcedGoal;
    } else {
      const step = 5;
      const nearestGoal = Math.round(cadGoal / step) * step;
      if (Math.abs(cadGoal - nearestGoal) <= 1.50) {
        cadGoal = nearestGoal;
      }
    }

    const percentage = cadGoal > 0 ? Math.min(100, Math.round((cadRaised / cadGoal) * 100)) : 0;

    if (elements.amountRaisedText) elements.amountRaisedText.innerHTML = formatBothCurrenciesHTML(raisedUSD, false, isTeamView);
    if (elements.amountGoalText) elements.amountGoalText.innerHTML = formatBothCurrenciesHTML(goalUSD, true, isTeamView);
    if (elements.progressPercent) elements.progressPercent.textContent = `${percentage}%`;
    if (elements.progressBarFill) elements.progressBarFill.style.width = `${Math.min(100, Math.max(0, percentage))}%`;
    if (elements.progressPercentContainer) {
      elements.progressPercentContainer.style.setProperty('--progress-pct', `${Math.min(100, Math.max(0, percentage))}%`);
    }

    updateMilestoneBadge();
  }

  /**
   * Gestion de l'alternance douce entre l'objectif Solo et l'objectif d'Équipe
   */
  function startAlternanceTimer() {
    if (state.alternanceTimer) {
      clearInterval(state.alternanceTimer);
      state.alternanceTimer = null;
    }
    if (CONFIG.mode !== 'alternance') return;

    state.alternanceTimer = setInterval(() => {
      if (!state.team && !CONFIG.isDemo) return;

      state.currentAlternanceView = (state.currentAlternanceView === 'participant') ? 'team' : 'participant';

      const animTargets = [
        elements.amountRaisedText,
        elements.amountGoalText,
        elements.labelRaisedHeading,
        elements.labelGoalHeading
      ].filter(Boolean);

      animTargets.forEach(el => el.classList.add('fade-out'));

      setTimeout(() => {
        updateProgressDisplay();
        animTargets.forEach(el => {
          el.classList.remove('fade-out');
          el.classList.add('fade-in');
          setTimeout(() => el.classList.remove('fade-in'), 350);
        });
      }, 350);
    }, CONFIG.alternanceIntervalMs);
  }

  function updateUI(donationsChanged = true) {
    // Si aucune donnée active, tentative de restauration depuis le cache ou les données de démo
    if (!state.participant && !state.team) {
      if (CONFIG.isDemo) {
        state.participant = getDemoParticipant();
        if (CONFIG.mode === 'alternance' || CONFIG.mode === 'team') {
          state.team = getDemoTeam();
        }
      } else {
        try {
          const cachedPart = safeStorage.getItem(STORAGE_KEYS.lastParticipantData);
          const cachedTeam = safeStorage.getItem(STORAGE_KEYS.lastTeamData);
          if (cachedPart) state.participant = JSON.parse(cachedPart);
          if (cachedTeam) state.team = JSON.parse(cachedTeam);
        } catch (e) {}
      }

      if (!state.participant && !state.team) {
        state.participant = getDemoParticipant();
        if (CONFIG.mode === 'alternance' || CONFIG.mode === 'team') {
          state.team = getDemoTeam();
        }
      }
    }

    // 1. Mise à jour de la barre et des compteurs
    updateProgressDisplay();

    // 2. Dernier donateur
    if (state.donations && state.donations.length > 0) {
      const latest = state.donations[0];
      const donorName = resolveDonorDisplayName(latest.displayName);
      
      if (elements.latestDonorName) elements.latestDonorName.textContent = donorName;
      if (elements.latestDonorAmount) elements.latestDonorAmount.innerHTML = formatBothCurrenciesHTML(latest.amount);
      if (elements.latestDonorTime) elements.latestDonorTime.textContent = formatRelativeTime(latest.createdDateUTC);

      if (elements.latestDonorMessageLine) {
        if (latest.message && latest.message.trim()) {
          renderMessageContent(elements.latestDonorMessageLine, latest.message.trim());
        } else {
          elements.latestDonorMessageLine.innerHTML = '';
          elements.latestDonorMessageLine.style.display = 'none';
        }
      }
    } else {
      if (elements.latestDonorName) elements.latestDonorName.textContent = 'En attente du premier don';
      if (elements.latestDonorAmount) elements.latestDonorAmount.innerHTML = '<span class="cur-cad">Soyez le premier ! 🎮</span>';
      if (elements.latestDonorTime) elements.latestDonorTime.textContent = 'Campagne active';
      if (elements.latestDonorMessageLine) {
        elements.latestDonorMessageLine.innerHTML = '';
        elements.latestDonorMessageLine.style.display = 'none';
      }
    }

    // 3. Mise à jour du carrousel si les dons ont changé OU si le carrousel contient encore le texte d'attente
    const hasActiveDonationsRendered = elements.feedSlider && elements.feedSlider.querySelectorAll('.feed-item[data-index]').length > 0;
    if (donationsChanged || !hasActiveDonationsRendered) {
      renderDonationsCarousel();
    }
  }

  /**
   * Met à jour une ligne de message de façon intelligente :
   * - Si le message loge dans la largeur disponible -> affichage fixe et statique.
   * - Si le message est trop long -> défilement fluide infini (Marquee).
   */
  function renderMessageContent(container, messageText) {
    if (!container) return;
    if (!messageText || !messageText.trim()) {
      container.innerHTML = '';
      container.style.display = 'none';
      return;
    }

    const clean = escapeHTML(messageText.trim());
    container.style.display = 'block';

    // 1. Injecte un élément statique pour mesurer son encombrement réel
    container.innerHTML = `<span class="feed-message static-message">«&nbsp;${clean}&nbsp;»</span>`;

    // 2. Mesure du débordement dans la prochaine animation frame
    requestAnimationFrame(() => {
      if (!container) return;
      const span = container.querySelector('.feed-message');
      if (!span) return;

      // Détection de débordement réel
      const isOverflowing = span.scrollWidth > (container.clientWidth + 2);

      if (isOverflowing) {
        // Trop long -> Défilement continu infini
        const unit = `<span class="feed-message">«&nbsp;${clean}&nbsp;»</span><span class="marquee-bullet" aria-hidden="true">☀️</span>`;
        container.innerHTML = `
          <div class="marquee-track">
            ${unit}${unit}${unit}${unit}
          </div>
        `;
        container.classList.add('is-marquee');
      } else {
        // Loge entièrement -> Message statique fixe
        container.innerHTML = `<span class="feed-message static-message">«&nbsp;${clean}&nbsp;»</span>`;
        container.classList.remove('is-marquee');
      }
    });
  }

  /**
   * Évalue le message de l'élément de carrousel actuellement visible
   */
  function evaluateActiveCarouselMessage() {
    if (!elements.feedSlider) return;
    const activeItem = elements.feedSlider.querySelector('.feed-item.active');
    if (!activeItem) return;
    const msgLine = activeItem.querySelector('.message-line');
    const rawMsg = activeItem.getAttribute('data-raw-message');
    if (msgLine && rawMsg) {
      renderMessageContent(msgLine, rawMsg);
    }
  }

  /**
   * Génère les cartes du carrousel de dons récents
   */
  function renderDonationsCarousel() {
    if (!elements.feedSlider) return;

    if (!state.donations || state.donations.length === 0) {
      elements.feedSlider.innerHTML = `
        <div class="feed-item active">
          <div class="donor-line">
            <span class="feed-donor">Merci pour votre soutien !</span>
          </div>
          <div class="amount-line">
            <span class="feed-amount">Tous unis pour Extra Life 🎮</span>
          </div>
        </div>
      `;
      return;
    }

    elements.feedSlider.innerHTML = state.donations.map((d, index) => {
      const name = resolveDonorDisplayName(d.displayName);
      const formattedHTML = formatBothCurrenciesHTML(d.amount);
      const rawMsg = (d.message && d.message.trim()) ? d.message.trim() : '';
      const msgHTML = rawMsg ? `<div class="message-line marquee-line"><span class="feed-message static-message">«&nbsp;${escapeHTML(rawMsg)}&nbsp;»</span></div>` : '';

      return `
        <div class="feed-item ${index === 0 ? 'active' : ''}" data-index="${index}" data-raw-message="${escapeHTML(rawMsg)}">
          <div class="donor-line">
            <span class="feed-donor">${escapeHTML(name)}</span>
          </div>
          <div class="amount-line">
            <span class="feed-amount">${formattedHTML}</span>
          </div>
          ${msgHTML}
        </div>
      `;
    }).join('');

    // Évalue le message de la première carte active
    evaluateActiveCarouselMessage();

    // Démarre la rotation automatique
    startCarouselRotation();
  }

  /**
   * Fait alterner les dons récents en douceur
   */
  function startCarouselRotation() {
    if (state.carouselTimer) {
      clearInterval(state.carouselTimer);
    }

    const items = elements.feedSlider.querySelectorAll('.feed-item');
    if (items.length <= 1) return;

    state.currentCarouselIndex = 0;

    state.carouselTimer = setInterval(() => {
      const allItems = elements.feedSlider.querySelectorAll('.feed-item');
      if (allItems.length <= 1) return;

      allItems[state.currentCarouselIndex].classList.remove('active');
      state.currentCarouselIndex = (state.currentCarouselIndex + 1) % allItems.length;
      allItems[state.currentCarouselIndex].classList.add('active');

      // Met à jour intelligemment le message du nouvel élément actif
      evaluateActiveCarouselMessage();
    }, CONFIG.carouselIntervalMs);
  }

  // --------------------------------------------------------------------------
  // 5. FONCTIONS UTILITAIRES
  // --------------------------------------------------------------------------

  function formatRelativeTime(dateString) {
    if (!dateString) return '';
    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffSec = Math.floor((now - date) / 1000);

      if (diffSec < 60) return "À l'instant";
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return `Il y a ${diffMin} min`;
      const diffHours = Math.floor(diffMin / 60);
      if (diffHours < 24) return `Il y a ${diffHours} h`;
      const diffDays = Math.floor(diffHours / 24);
      return `Il y a ${diffDays} j`;
    } catch {
      return '';
    }
  }

  function escapeHTML(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // --------------------------------------------------------------------------
  // 6. DONNÉES DE DÉMONSTRATION (TEST & APERÇU OBS)
  // Accessible via ?demo=true dans l'URL
  // --------------------------------------------------------------------------

  function getDemoParticipant() {
    return {
      displayName: "cybervirus_101",
      sumDonations: 107.16,
      fundraisingGoal: 142.0,
      numDonations: 7,
      eventName: "Extra Life 2026",
      participantID: 582063,
      teamID: 75345,
      teamName: "Les alliés du soleil",
    };
  }

  function getDemoTeam() {
    return {
      name: "Les alliés du soleil",
      sumDonations: 107.16,
      fundraisingGoal: 500.0,
      numDonations: 7,
      teamID: 75345,
    };
  }

  function getDemoMilestones() {
    return [
      { milestoneID: 1, fundraisingGoal: 50, description: "Stream découverte", isComplete: true },
      { milestoneID: 2, fundraisingGoal: 142, description: "Objectif Extra Life 2026", isComplete: false },
      { milestoneID: 3, fundraisingGoal: 250, description: "Live spécial 12h", isComplete: false },
    ];
  }

  function getDemoDonations() {
    const now = new Date();
    return [
      {
        donationID: "892C161F64A1EE81",
        displayName: "billy_camaros",
        amount: 10.70,
        createdDateUTC: new Date(now - 15 * 60 * 1000).toISOString(),
        message: ""
      },
      {
        donationID: "F918B3575FA4ED96",
        displayName: "Mathieu Gingras",
        amount: 7.16,
        createdDateUTC: new Date(now - 45 * 60 * 1000).toISOString(),
        message: ""
      },
      {
        donationID: "4E88F74455C86F54",
        displayName: null, // Anonyme
        amount: 35.75,
        createdDateUTC: new Date(now - 120 * 60 * 1000).toISOString(),
        message: "Pour les enfants !"
      },
      {
        donationID: "4F369B3F65C59D33",
        displayName: "Alain-Pier Lafond",
        amount: 7.14,
        createdDateUTC: new Date(now - 240 * 60 * 1000).toISOString(),
        message: ""
      },
      {
        donationID: "8AE65BED0FF921D5",
        displayName: "Yancy Gauthier",
        amount: 14.28,
        createdDateUTC: new Date(now - 360 * 60 * 1000).toISOString(),
        message: ""
      },
      {
        donationID: "17CF5907313AC7F4",
        displayName: "Maxime Champeau",
        amount: 17.85,
        createdDateUTC: new Date(now - 480 * 60 * 1000).toISOString(),
        message: ""
      },
      {
        donationID: "CC29895067BC0D25",
        displayName: "cybervirus_101",
        amount: 14.28,
        createdDateUTC: new Date(now - 600 * 60 * 1000).toISOString(),
        message: "Pour les enfants 🚸"
      }
    ];
  }

  // --------------------------------------------------------------------------
  // 7. ÉCOUTEUR DU SIMULATEUR DE TEST (PILIER 6)
  // Permet de déclencher un don test depuis le configurateur web
  // --------------------------------------------------------------------------

  function setupSimulatorListener() {
    const processedSimIds = new Set();

    function handleTestDonation(eventData) {
      if (!eventData || eventData.type !== 'TEST_DONATION') return;
      const dedupKey = (eventData.donationID || '') + '_' + (eventData.amount || '') + '_' + (eventData.displayName || '');
      if (processedSimIds.has(dedupKey)) return;
      processedSimIds.add(dedupKey);
      setTimeout(() => processedSimIds.delete(dedupKey), 8000);

      const testItem = {
        donationID: eventData.donationID || ('test_' + Date.now()),
        displayName: resolveDonorDisplayName(eventData.displayName || 'Donateur Test Solaire'),
        amount: parseFloat(eventData.amount) || 25,
        message: eventData.message || 'Bravo pour votre stream au profit d\'Enfant Soleil ! ☀️',
        createdDateUTC: new Date().toISOString(),
      };

      console.log('[Overlay] Don de test reçu en direct:', testItem);
      state.donations = [testItem, ...state.donations];
      triggerNewDonationAlert();
      updateUI(true);
    }

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        const bus = new BroadcastChannel('extra_life_overlay_bus');
        bus.onmessage = (e) => handleTestDonation(e.data);
      } catch (err) {
        console.warn('[Overlay] BroadcastChannel non supporté:', err);
      }
    }

    window.addEventListener('storage', (e) => {
      if (e.key === 'oes_test_donation_trigger' && e.newValue) {
        try {
          const data = JSON.parse(e.newValue);
          handleTestDonation(data);
        } catch (err) {}
      }
    });
  }

  // --------------------------------------------------------------------------
  // 8. CYCLE PRINCIPAL D'ACTUALISATION
  // --------------------------------------------------------------------------

  async function refreshData() {
    try {
      const isTeamMode = (CONFIG.mode === 'team');

      // 1. Préparation des requêtes indépendantes avec capture d'erreur locale
      const pDonations = fetchDonations().catch(err => {
        console.warn('[Overlay] Dons non récupérés via API:', err.message);
        return null;
      });

      const pParticipant = (!isTeamMode && CONFIG.participantID)
        ? fetchParticipant(CONFIG.participantID).catch(err => {
            console.warn('[Overlay] Participant non récupéré via API:', err.message);
            return null;
          })
        : (isTeamMode ? Promise.resolve(null) : Promise.resolve(CONFIG.isDemo ? getDemoParticipant() : null));

      const targetTeamId = isTeamMode ? (CONFIG.teamID || null) : CONFIG.teamID;
      const pTeam = ((isTeamMode && targetTeamId) || (CONFIG.mode === 'alternance' && targetTeamId))
        ? fetchTeam(targetTeamId).catch(err => {
            console.warn('[Overlay] Équipe non récupérée via API:', err.message);
            return null;
          })
        : Promise.resolve(null);

      const pMilestones = (CONFIG.showMilestones && !isTeamMode && CONFIG.participantID)
        ? fetchMilestones(CONFIG.participantID).catch(() => [])
        : Promise.resolve(CONFIG.isDemo ? getDemoMilestones() : []);

      const [donationsRes, partRes, teamRes, milesRes] = await Promise.all([
        pDonations,
        pParticipant,
        pTeam,
        pMilestones
      ]);

      // 2. Gestion du participant & auto-association de son équipe
      if (partRes) {
        state.participant = partRes;
        if (state.participant.teamID && !CONFIG.teamID) {
          CONFIG.teamID = state.participant.teamID;
          if (CONFIG.mode === 'alternance' && !state.team) {
            fetchTeam(state.participant.teamID).then(teamData => {
              if (teamData) {
                state.team = teamData;
                updateUI(false);
              }
            }).catch(() => {});
          }
        }
      } else if (!state.participant) {
        try {
          const cachedPart = safeStorage.getItem(STORAGE_KEYS.lastParticipantData);
          if (cachedPart) state.participant = JSON.parse(cachedPart);
        } catch (e) {}
      }

      // 3. Gestion de l'équipe
      if (teamRes) {
        state.team = teamRes;
      } else if (!state.team && (isTeamMode || CONFIG.mode === 'alternance')) {
        try {
          const cachedTeam = safeStorage.getItem(STORAGE_KEYS.lastTeamData);
          if (cachedTeam) state.team = JSON.parse(cachedTeam);
        } catch (e) {}
      }

      // 4. Jalons
      if (Array.isArray(milesRes) && milesRes.length > 0) {
        state.milestones = milesRes;
      } else if (!state.milestones || state.milestones.length === 0) {
        try {
          const cachedMiles = safeStorage.getItem(STORAGE_KEYS.lastMilestonesData);
          if (cachedMiles) state.milestones = JSON.parse(cachedMiles);
        } catch (e) {}
      }

      // 5. Filet de sécurité ultime si aucune connexion et aucun cache (mode démo de secours)
      if (!state.participant && !state.team) {
        console.warn('[Overlay] Aucune donnée API ni cache, utilisation des données démo de secours');
        state.participant = getDemoParticipant();
        if (CONFIG.mode === 'alternance' || CONFIG.mode === 'team') {
          state.team = getDemoTeam();
        }
      }

      // 6. Traitement des dons
      let rawDonations = donationsRes;
      if (!rawDonations && (!state.donations || state.donations.length === 0)) {
        try {
          const cachedDons = safeStorage.getItem(STORAGE_KEYS.lastDonationsData);
          if (cachedDons) rawDonations = JSON.parse(cachedDons);
        } catch (e) {}
      }
      if (!rawDonations && CONFIG.isDemo) {
        rawDonations = getDemoDonations();
      }

      const processedDonations = processDonations(rawDonations || state.donations || []);
      const isFirstLoad = state.donations.length === 0 && state.lastSeenDonationId === null;
      const latestDonation = processedDonations.length > 0 ? processedDonations[0] : null;
      const latestId = latestDonation ? latestDonation.donationID : null;

      const hasDonationsChanged = !areDonationsIdentical(state.donations, processedDonations);

      // Détection d'un nouveau don en direct pendant le live
      if (!isFirstLoad && latestId && state.lastSeenDonationId && latestId !== state.lastSeenDonationId) {
        console.log(`[Overlay] ☀️ Nouveau don détecté ! De: ${latestDonation.displayName} (${latestDonation.amount} USD)`);
        triggerNewDonationAlert();
      }

      state.donations = processedDonations;
      if (latestId) {
        state.lastSeenDonationId = latestId;
      }

      updateUI(hasDonationsChanged);
    } catch (err) {
      console.warn('[Overlay] Erreur générale lors du rafraîchissement:', err.message);
      if (!state.participant && !state.team) {
        state.participant = getDemoParticipant();
        if (CONFIG.mode === 'alternance' || CONFIG.mode === 'team') {
          state.team = getDemoTeam();
        }
      }
      updateUI(true);
    }
  }

  // --------------------------------------------------------------------------
  // 9. INITIALISATION
  // --------------------------------------------------------------------------

  function applyThemeAndLogo() {
    // Détection du mode de disposition (forcé par URL ou auto-détecté selon les dimensions de la fenêtre OBS)
    let layout = CONFIG.layoutMode;
    if (layout === 'twotier' || layout === 'two_tier' || layout === '2-tier' || layout === '2_tier' || layout === '2etage' || layout === '2etages' || layout === '2étage' || layout === '2étages') {
      layout = 'two-tier';
    }

    if (layout === 'auto') {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (w <= 760 || (h > w)) {
        layout = 'vertical';
      } else if (w <= 1050 && h >= 180) {
        layout = 'two-tier';
      } else {
        layout = 'horizontal';
      }
    }

    const isVertical = (layout === 'vertical');
    const isTwoTier = (layout === 'two-tier');

    // Application de la classe de layout
    if (elements.container) {
      elements.container.classList.remove('layout-vertical', 'layout-two-tier', 'layout-horizontal');
      if (isVertical) {
        elements.container.classList.add('layout-vertical');
      } else if (isTwoTier) {
        elements.container.classList.add('layout-two-tier');
      } else {
        elements.container.classList.add('layout-horizontal');
      }

      // Application du thème (clair, sombre, extralife-clair, extralife-sombre)
      const isExtraLife = CONFIG.theme.includes('extralife');
      const isDark = CONFIG.theme === 'sombre' || CONFIG.theme === 'dark' || CONFIG.theme.includes('sombre');

      elements.container.classList.remove('theme-light', 'theme-dark', 'theme-extralife');
      if (isDark) {
        elements.container.classList.add('theme-dark');
      } else {
        elements.container.classList.add('theme-light');
      }
      if (isExtraLife) {
        elements.container.classList.add('theme-extralife');
      }
    }

    // Gestion du logo officiel (Extra Life pour les thèmes Extra Life, Enfant Soleil pour les thèmes Enfant Soleil)
    if (elements.brandLogo) {
      if (isExtraLife) {
        elements.brandLogo.src = isDark ? 'assets/logo-extra-life-white.svg' : 'assets/logo-extra-life-color.svg';
        elements.brandLogo.alt = 'Extra Life — Au profit d\'Enfant Soleil';
      } else {
        if (CONFIG.logoMode === 'horizontal') {
          elements.brandLogo.src = 'assets/logo-enfant-soleil-horizontal.png';
        } else if (CONFIG.logoMode === 'vertical') {
          elements.brandLogo.src = 'assets/logo-enfant-soleil-vertical.png';
        } else if (isVertical) {
          elements.brandLogo.src = 'assets/logo-enfant-soleil-vertical.png';
        } else {
          elements.brandLogo.src = 'assets/logo-enfant-soleil-horizontal.png';
        }
        elements.brandLogo.alt = 'Au profit de enfant soleil';
      }
    }
  }

  async function init() {
    console.log(`[Overlay] Initialisation Extra Life (Mode: ${CONFIG.mode}, Participant: ${CONFIG.participantID})`);
    if (CONFIG.isDemo) {
      console.log('[Overlay] Mode DÉMO activé');
    }

    // 0. Configuration visuelle & Écouteur simulateur
    applyThemeAndLogo();
    setupSimulatorListener();

    // Rendu synchrone immédiat (0 ms) avec données locales ou démo pour éliminer tout temps de chargement visible
    try {
      const cachedPart = safeStorage.getItem(STORAGE_KEYS.lastParticipantData);
      const cachedTeam = safeStorage.getItem(STORAGE_KEYS.lastTeamData);
      const cachedDons = safeStorage.getItem(STORAGE_KEYS.lastDonationsData);
      const cachedMiles = safeStorage.getItem(STORAGE_KEYS.lastMilestonesData);

      if (cachedPart) state.participant = JSON.parse(cachedPart);
      if (cachedTeam) state.team = JSON.parse(cachedTeam);
      if (cachedMiles) state.milestones = JSON.parse(cachedMiles);
      if (cachedDons) {
        const parsed = JSON.parse(cachedDons);
        if (Array.isArray(parsed) && parsed.length > 0) {
          state.donations = processDonations(parsed);
        }
      }
    } catch (e) {}

    // Si aucune donation n'est en mémoire (ex: premier chargement), on initialise avec la liste connue
    if (!state.donations || state.donations.length === 0) {
      state.donations = processDonations(getDemoDonations());
    }

    if (!state.participant && !state.team) {
      state.participant = getDemoParticipant();
      if (CONFIG.mode === 'alternance' || CONFIG.mode === 'team') {
        state.team = getDemoTeam();
      }
    }

    // Affiche immédiatement l'interface avec les données de départ
    updateUI(true);

    window.addEventListener('resize', () => {
      applyThemeAndLogo();
      evaluateActiveCarouselMessage();
      if (state.donations && state.donations.length > 0 && state.donations[0].message) {
        renderMessageContent(elements.latestDonorMessageLine, state.donations[0].message);
      }
    });

    // 1. Première récupération immédiate des données réelles
    refreshData();

    // 2. Récupération du taux de change en parallèle
    updateExchangeRate().then(() => {
      if (state.participant || state.team) {
        updateUI();
      }
    }).catch(err => {
      console.warn('[Devise] Taux par défaut conservé:', err.message);
    });

    // 3. Démarrage de l'alternance douce si activée
    if (CONFIG.mode === 'alternance') {
      startAlternanceTimer();
    }

    // 4. Boucle de rafraîchissement des dons (15-20 secondes)
    setInterval(refreshData, CONFIG.pollIntervalSeconds * 1000);

    // 5. Boucle de rafraîchissement du taux de change (1 heure)
    setInterval(updateExchangeRate, CONFIG.rateRefreshIntervalMs);
  }

  // Lancement dès que le DOM est prêt
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
