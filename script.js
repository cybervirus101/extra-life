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

  const CONFIG = {
    participantID: urlParams.get('participantID') || '582063',
    teamID: urlParams.get('teamID') || null,
    mode: (urlParams.get('mode') || 'participant').toLowerCase(), // 'participant', 'team', 'alternance'
    alternanceIntervalMs: (parseInt(urlParams.get('interval'), 10) || 12) * 1000,
    showMilestones: urlParams.get('milestones') !== 'false' && urlParams.get('milestones') !== '0',
    forcedRate: parseFloat(urlParams.get('rate')) || null,
    forcedGoal: parseFloat(urlParams.get('goal')) || null,
    pollIntervalSeconds: parseInt(urlParams.get('refresh'), 10) || 15,
    isDemo: urlParams.get('demo') === 'true' || urlParams.get('demo') === '1',
    theme: (urlParams.get('theme') || 'clair').toLowerCase(), // 'clair' (défaut) ou 'sombre'
    logoMode: (urlParams.get('logo') || 'auto').toLowerCase(), // 'auto', 'horizontal', 'vertical'
    layoutMode: (urlParams.get('layout') || 'auto').toLowerCase(), // 'auto', 'vertical', 'horizontal'
    carouselIntervalMs: 8000, // 8 secondes pour laisser défiler les messages confortablement
    rateRefreshIntervalMs: 60 * 60 * 1000, // 1 heure
    defaultFallbackRate: 1.38, // Taux de repli de sécurité si aucune connexion
    donationsLimit: parseInt(urlParams.get('limit'), 10) || 20, // 20 derniers dons par défaut
    donorNameOverrides: parseOverrides(urlParams.get('overrides')),
  };

  // Rétrocompatibilité : conservation de l'alias de démonstration initial
  if (CONFIG.participantID === '582063' && !urlParams.get('overrides')) {
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
   * Effectue un fetch classique en premier, puis bascule automatiquement sur JSONP si bloqué.
   * Ajoute systématiquement un paramètre anti-cache (_t) pour contourner l'en-tête 'Cache-Control: max-age=14400'
   * (4 heures !) renvoyé par DonorDrive/Cloudflare, qui empêchait OBS CEF de rafraîchir les nouveaux dons.
   */
  async function fetchWithFallback(url) {
    const sep = url.includes('?') ? '&' : '?';
    const noCacheUrl = `${url}${sep}_t=${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    try {
      const res = await fetch(noCacheUrl, {
        method: 'GET',
        cache: 'no-store',
        headers: {
          'Accept': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
        },
      });
      if (res.ok) {
        return await res.json();
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (fetchErr) {
      console.warn(`[API] Appel fetch standard rejeté (${fetchErr.message}). Bascule vers JSONP:`, noCacheUrl);
      return await fetchJSONP(noCacheUrl);
    }
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
    } else {
      donationEndpoints = [
        `https://dd.extra-life.org/api/participants/${CONFIG.participantID}/donations?limit=${CONFIG.donationsLimit}`,
        `https://extra-life.donordrive.com/api/participants/${CONFIG.participantID}/donations?limit=${CONFIG.donationsLimit}`,
        `https://www.extra-life.org/api/participants/${CONFIG.participantID}/donations?limit=${CONFIG.donationsLimit}`
      ];
    }

    let lastError = null;
    for (const url of donationEndpoints) {
      try {
        const data = await fetchWithFallback(url);
        if (Array.isArray(data)) {
          safeStorage.setItem(STORAGE_KEYS.lastDonationsData, JSON.stringify(data));
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
    if (!state.participant && !state.team) return;

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
      if (elements.latestDonorAmount) elements.latestDonorAmount.textContent = '--';
      if (elements.latestDonorTime) elements.latestDonorTime.textContent = '';
      if (elements.latestDonorMessageLine) {
        elements.latestDonorMessageLine.innerHTML = '';
        elements.latestDonorMessageLine.style.display = 'none';
      }
    }

    // 3. Mise à jour du carrousel uniquement si la liste des dons a changé
    if (donationsChanged) {
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
            <span class="feed-amount">Tous unis pour Enfant Soleil ☀️</span>
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
      displayName: "Streamer Enfant Soleil",
      sumDonations: 765.0,
      fundraisingGoal: 1000.0,
      numDonations: 14,
      eventName: "Extra Life 2026",
      participantID: 582063,
      teamID: 67890,
      teamName: "Les Soleils du Québec",
    };
  }

  function getDemoTeam() {
    return {
      name: "Les Soleils du Québec",
      sumDonations: 3840.0,
      fundraisingGoal: 5000.0,
      numDonations: 42,
      teamID: 67890,
    };
  }

  function getDemoMilestones() {
    return [
      { milestoneID: 1, fundraisingGoal: 500, description: "Défi piment fort en live", isComplete: true },
      { milestoneID: 2, fundraisingGoal: 850, description: "Stream 12h non-stop", isComplete: false },
      { milestoneID: 3, fundraisingGoal: 1000, description: "Chanson avec perruque", isComplete: false },
    ];
  }

  function getDemoDonations() {
    const now = new Date();
    return [
      {
        displayName: "cybervirus_101",
        amount: 20.0,
        createdDateUTC: new Date(now - 12 * 60 * 1000).toISOString(),
        message: "Pour les enfants 🚸"
      },
      {
        displayName: "Alexandre G.",
        amount: 50.0,
        createdDateUTC: new Date(now - 25 * 60 * 1000).toISOString(),
        message: "Bravo pour cette belle initiative pour les enfants !"
      },
      {
        displayName: null, // Anonyme
        amount: 25.0,
        createdDateUTC: new Date(now - 45 * 60 * 1000).toISOString(),
        message: "Bon stream à tous !"
      },
      {
        displayName: "Julie & Marc",
        amount: 100.0,
        createdDateUTC: new Date(now - 180 * 60 * 1000).toISOString(),
        message: "Pour les petits guerriers d'Opération Enfant Soleil ☀️"
      },
      {
        displayName: "Maxime T.",
        amount: 20.0,
        createdDateUTC: new Date(now - 300 * 60 * 1000).toISOString(),
        message: ""
      }
    ];
  }

  // --------------------------------------------------------------------------
  // 7. ÉCOUTEUR DU SIMULATEUR DE TEST (PILIER 6)
  // Permet de déclencher un don test depuis le configurateur web
  // --------------------------------------------------------------------------

  function setupSimulatorListener() {
    function handleTestDonation(eventData) {
      if (!eventData || eventData.type !== 'TEST_DONATION') return;
      const testItem = {
        donationID: 'test_' + Date.now(),
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
      // 1. Prépare les requêtes en fonction du mode choisi
      const promises = [fetchDonations()];

      if (CONFIG.mode === 'team') {
        promises.push(fetchTeam());
      } else {
        promises.push(fetchParticipant());
        if (CONFIG.showMilestones) {
          promises.push(fetchMilestones());
        }
        if (CONFIG.mode === 'alternance' && CONFIG.teamID) {
          promises.push(fetchTeam(CONFIG.teamID));
        }
      }

      const results = await Promise.allSettled(promises);
      const donationsRes = results[0].status === 'fulfilled' ? results[0].value : [];
      let mainDataRes = results[1] && results[1].status === 'fulfilled' ? results[1].value : null;

      if (CONFIG.mode === 'team') {
        state.team = mainDataRes;
      } else {
        state.participant = mainDataRes;

        // Si le participant appartient à une équipe et qu'on est en alternance, auto-associer l'équipe
        if (state.participant && state.participant.teamID && !CONFIG.teamID) {
          CONFIG.teamID = state.participant.teamID;
          if (CONFIG.mode === 'alternance' && !state.team) {
            fetchTeam(state.participant.teamID).then(teamData => {
              if (teamData) {
                state.team = teamData;
                updateUI(false);
              }
            });
          }
        }
      }

      if (results[2] && results[2].status === 'fulfilled') {
        state.milestones = results[2].value || [];
      }
      if (results[3] && results[3].status === 'fulfilled') {
        state.team = results[3].value;
      }

      const processedDonations = processDonations(donationsRes);
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
      console.warn('[Overlay] Erreur réseau, maintien des données précédentes:', err.message);

      // Résilience hors-ligne : charge la dernière sauvegarde si mémoire vide
      if (!state.participant && !state.team) {
        try {
          const cachedPart = safeStorage.getItem(STORAGE_KEYS.lastParticipantData);
          const cachedTeam = safeStorage.getItem(STORAGE_KEYS.lastTeamData);
          const cachedDons = safeStorage.getItem(STORAGE_KEYS.lastDonationsData);
          const cachedMiles = safeStorage.getItem(STORAGE_KEYS.lastMilestonesData);

          if (cachedPart) state.participant = JSON.parse(cachedPart);
          if (cachedTeam) state.team = JSON.parse(cachedTeam);
          if (cachedMiles) state.milestones = JSON.parse(cachedMiles);
          if (cachedDons) {
            state.donations = processDonations(JSON.parse(cachedDons));
            if (state.donations.length > 0) {
              state.lastSeenDonationId = state.donations[0].donationID;
            }
          }
          updateUI(true);
        } catch (e) {
          console.error('[Overlay] Erreur lecture cache:', e);
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // 9. INITIALISATION
  // --------------------------------------------------------------------------

  function applyThemeAndLogo() {
    // Détection du mode vertical (forcé ou automatique si largeur <= 760px ou ratio portrait)
    let isVertical = false;
    if (CONFIG.layoutMode === 'vertical') {
      isVertical = true;
    } else if (CONFIG.layoutMode === 'horizontal') {
      isVertical = false;
    } else {
      isVertical = window.innerWidth <= 760 || window.innerHeight > window.innerWidth;
    }

    // Application de la classe de layout
    if (elements.container) {
      if (isVertical) {
        elements.container.classList.add('layout-vertical');
      } else {
        elements.container.classList.remove('layout-vertical');
      }

      // Application du thème (clair ou sombre)
      if (CONFIG.theme === 'sombre' || CONFIG.theme === 'dark') {
        elements.container.classList.remove('theme-light');
        elements.container.classList.add('theme-dark');
      } else {
        elements.container.classList.remove('theme-dark');
        elements.container.classList.add('theme-light');
      }
    }

    // Gestion du logo officiel (horizontal ou vertical selon ratio ou paramètre d'URL)
    if (elements.brandLogo) {
      if (CONFIG.logoMode === 'horizontal') {
        elements.brandLogo.src = 'assets/logo-enfant-soleil-horizontal.png';
      } else if (CONFIG.logoMode === 'vertical') {
        elements.brandLogo.src = 'assets/logo-enfant-soleil-vertical.png';
      } else if (isVertical) {
        elements.brandLogo.src = 'assets/logo-enfant-soleil-vertical.png';
      } else {
        elements.brandLogo.src = 'assets/logo-enfant-soleil-horizontal.png';
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

    window.addEventListener('resize', () => {
      applyThemeAndLogo();
      evaluateActiveCarouselMessage();
      if (state.donations && state.donations.length > 0 && state.donations[0].message) {
        renderMessageContent(elements.latestDonorMessageLine, state.donations[0].message);
      }
    });

    // 1. Première récupération immédiate des données
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
