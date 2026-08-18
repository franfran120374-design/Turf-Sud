/* =========================================================
   AGENT VÉLÔTOULOUSE v2 — Mon Bureau
   -------------------------------------------------------
   Ce fichier contient TOUT :
     1. le moteur de données (stations en temps réel)
     2. la tuile de l'accueil (auto-injectée, aucun HTML à modifier)
     3. le panneau complet (départ / trajet / arrivée)
     4. le chronomètre de trajet avec bips sonores
     5. la surveillance de la station d'arrivée

   SOURCE DE DONNÉES
   -----------------
   Flux officiel GBFS de JCDecaux (l'exploitant de VélôToulouse) :
     https://api.cyclocity.fr/contracts/toulouse/gbfs/v2/...
   Gratuit, sans clé, ouvert aux navigateurs (CORS vérifié le 10/08/2026
   depuis franfran120374-design.github.io).
   Le backend Render sert uniquement de roue de secours si ce flux tombe.

   ZÉRO dépendance : ni carte, ni librairie externe, ni fichier son.
   Les bips sont générés par le navigateur (Web Audio).

   INSTALLATION
   ------------
   Remplacer le fichier existant :
     franfran120374-design/mon-bureau  ->  agent-velo.js  (racine, branche master)
   Rien à changer dans index.html : le script y est déjà appelé.
   ========================================================= */

const AgentVelo = (() => {
  'use strict';

  /* =======================================================
     1. RÉGLAGES
     ======================================================= */

  const JCD_V3      = 'https://api.jcdecaux.com/vls/v3/stations?contract=toulouse&apiKey=';
  /* Numero de version de la tuile. Il s'affiche dans l'onglet Plus :
     compare-le entre l'ordinateur et le telephone. S'ils different, c'est
     que l'un des deux affiche encore une ancienne copie mise en cache. */
  const VERSION = '3.1';

  const GBFS_INFO   = 'https://api.cyclocity.fr/contracts/toulouse/gbfs/v2/station_information.json';
  const GBFS_STATUS = 'https://api.cyclocity.fr/contracts/toulouse/gbfs/v2/station_status.json';

  const BACKEND_URL = window.location.hostname === 'localhost'
    ? 'http://localhost:3000'
    : 'https://mon-bureau-backend.onrender.com';

  /* Point de repli quand la géolocalisation ne répond pas.
     Ces valeurs ne sont qu'un DÉFAUT : dès que tu définis ton point de
     repère dans l'onglet Plus, c'est le tien qui est utilisé partout. */
  const HOME_LAT = 43.5720664;   // 10 rue Etienne Bacquie, 31100 Toulouse
  const HOME_LON = 1.4237031;

  const K_DOMICILE = 'velo_domicile';

  function getDomicile() {
    const d = lire(K_DOMICILE, null);
    if (d && typeof d.lat === 'number' && typeof d.lon === 'number') return d;
    return { lat: HOME_LAT, lon: HOME_LON, nom: '10 rue Étienne Bacquié, 31100 Toulouse' };
  }

  function setDomicile(lat, lon, nom) {
    ecrire(K_DOMICILE, { lat: lat, lon: lon, nom: nom || 'Point de repère' });
  }

  const RAYON_MAX      = 1500;   // mètres : au-delà, on ne propose plus la station
  const VITESSE_MARCHE = 80;     // mètres par minute
  const VITESSE_VELO   = 220;    // mètres par minute (~13 km/h en ville)
  const CACHE_MS       = 60000;  // les données GBFS sont rafraîchies toutes les minutes

  // Clés de sauvegarde locale (localStorage)
  const K_TRAJET  = 'velo_trajet_encours';
  const K_HISTO   = 'velo_historique';
  const K_FAVORIS = 'velo_favoris';
  const K_CONFIG  = 'velo_config';
  const K_CACHE   = 'velo_cache_stations';
  const K_JOUR    = 'velo_compteur_jour';
  const K_BONUS   = 'velo_bonus_manuel';
  const K_CREDIT  = 'velo_credit_minutes';
  const K_ALT     = 'velo_altitudes';

  const CONFIG_DEFAUT = {
    minutesGratuites: 30,   // durée incluse dans l'abonnement VélôToulouse
    alerteAvant: 5,         // premier avertissement X minutes avant la fin
    maxEmprunts: 7,         // nombre d'emprunts autorisés par jour
    seuilVide: 2,           // station "à renflouer" : vélos restants <= ce nombre
    seuilPleine: 2,         // station "à désengorger" : places restantes <= ce nombre
    altitudeBonus: 0,       // 0 = désactivé. Voir la note sur les stations Bonus ci-dessous.
    cleJCDecaux: 'frifk0jbxfefqqniqez09tw4jvk37wyf823b5j1i', // enrichissement v3 (n° de borne, CB)
    prioriserUtiles: true,  // remonter en tête les stations utiles au réseau
    positionManuelle: false,// true = ne plus chercher le GPS, utiliser le point de repère
    navigation: 'osm',      // 'osm' | 'geo' (appli du téléphone) | 'google'
    voix: true,             // annonces vocales pendant le trajet
    guidage: true,          // guidage tournant par tournant vers l'arrivée
    tarifTranche: 1,        // euros par demi-heure entamée au-delà du temps inclus
    dureeTranche: 30,       // minutes par tranche facturée
    tarifEmpruntSupp: 1,    // euros par emprunt au-delà du quota journalier
    alerteTranche: 3,       // minutes avant la tranche suivante -> avertissement
    son: true,
    vibration: true,
    notification: true,
    elecSeulement: false
  };

  const CREDIT_MAX = 120;   // plafond officiel du crédit Bonus : 2 heures

  /* =======================================================
     2. PETITS OUTILS
     ======================================================= */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function lire(cle, defaut) {
    try {
      const v = localStorage.getItem(cle);
      return v == null ? defaut : JSON.parse(v);
    } catch (e) { return defaut; }
  }

  function ecrire(cle, valeur) {
    try { localStorage.setItem(cle, JSON.stringify(valeur)); }
    catch (e) { console.warn('[Vélô] écriture impossible', cle, e.message); }
  }

  function getConfig() {
    return Object.assign({}, CONFIG_DEFAUT, lire(K_CONFIG, {}));
  }

  function setConfig(patch) {
    const c = Object.assign(getConfig(), patch);
    ecrire(K_CONFIG, c);
    return c;
  }

  // Distance à vol d'oiseau entre deux points GPS (formule de Haversine)
  function distance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function distanceText(m) {
    return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km';
  }

  function walkMinutes(m) { return Math.max(1, Math.ceil(m / VITESSE_MARCHE)); }
  function bikeMinutes(m) { return Math.max(1, Math.ceil(m / VITESSE_VELO)); }

  function chrono(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = n => String(n).padStart(2, '0');
    return h > 0 ? h + ':' + pad(m) + ':' + pad(r) : pad(m) + ':' + pad(r);
  }

  function ilYA(ts) {
    const d = Math.round((Date.now() - ts) / 1000);
    if (d < 60) return 'il y a ' + d + ' s';
    if (d < 3600) return 'il y a ' + Math.round(d / 60) + ' min';
    return 'il y a ' + Math.round(d / 3600) + ' h';
  }

  function notifier(msg) {
    if (typeof window.toast === 'function') { window.toast(msg); return; }
    console.log('[Vélô] ' + msg);
  }

  /* =======================================================
     3. SONS ET VIBRATIONS
     -------------------------------------------------------
     Aucun fichier .mp3 : le navigateur fabrique les bips.
     Le contexte audio est créé au premier clic (obligatoire
     sur mobile) puis réutilisé, ce qui permet aux alertes de
     sonner plus tard sans nouvelle action de ta part.
     ======================================================= */

  let audioCtx = null;

  function reveilAudio() {
    try {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    } catch (e) { return null; }
  }

  // notes = [[fréquence Hz, durée ms, pause ms], ...]
  function jouer(notes, volume) {
    if (!getConfig().son) return;
    const ctx = reveilAudio();
    if (!ctx) return;
    let t = ctx.currentTime;
    notes.forEach(([freq, dur, pause]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(volume || 0.25, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur / 1000);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t); osc.stop(t + dur / 1000 + 0.02);
      t += (dur + (pause || 0)) / 1000;
    });
  }

  function vibrer(motif) {
    if (!getConfig().vibration) return;
    try { navigator.vibrate && navigator.vibrate(motif); } catch (e) {}
  }

  const Sons = {
    depart()  { jouer([[880, 90, 40], [1175, 160, 0]], 0.3);              vibrer([60, 50, 120]); },
    arrivee() { jouer([[1175, 90, 40], [880, 90, 40], [660, 200, 0]], 0.3); vibrer([120, 60, 120]); },
    avertir() { jouer([[660, 120, 90], [660, 120, 90], [660, 200, 0]], 0.32); vibrer([100, 80, 100, 80, 100]); },
    alerte()  { jouer([[990, 140, 70], [660, 140, 70], [990, 140, 70], [660, 260, 0]], 0.4);
                vibrer([200, 100, 200, 100, 400]); },
    clic()    { jouer([[1320, 45, 0]], 0.15); }
  };

  function demanderNotifications() {
    try {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'default') Notification.requestPermission();
    } catch (e) {}
  }

  function pousserNotif(titre, corps) {
    if (!getConfig().notification) return;
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      new Notification(titre, { body: corps, icon: 'icon-192.png', tag: 'velotoulouse' });
    } catch (e) {}
  }

  /* =======================================================
     4. DONNÉES DES STATIONS
     ======================================================= */

  let stationsCache = null;
  let cacheTime = 0;
  let sourceActive = '—';
  let enCoursDeChargement = null;

  async function fetchJson(url, ms) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), ms || 8000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(to); }
  }

  // Source principale : GBFS officiel (deux fichiers à croiser)
  async function fetchGBFS() {
    const [info, status] = await Promise.all([
      fetchJson(GBFS_INFO, 8000),
      fetchJson(GBFS_STATUS, 8000)
    ]);
    const infos = {};
    info.data.stations.forEach(s => { infos[s.station_id] = s; });

    const out = [];
    status.data.stations.forEach(st => {
      const i = infos[st.station_id];
      if (!i) return;
      let meca = 0, elec = 0;
      (st.vehicle_types_available || []).forEach(v => {
        if (v.vehicle_type_id === 'electrical') elec = v.count || 0;
        else meca += v.count || 0;
      });
      out.push({
        id: st.station_id,
        name: i.name,
        address: i.address || '',
        lat: i.lat,
        lon: i.lon,
        capacity: i.capacity || 0,
        availableBikes: st.num_bikes_available || 0,
        availableDocks: st.num_docks_available || 0,
        ebikes: elec,
        mbikes: meca,
        bikesHS: st.num_bikes_disabled || 0,
        docksHS: st.num_docks_disabled || 0,
        ouverte: st.is_installed !== false,
        retrait: st.is_renting !== false,
        depot: st.is_returning !== false,
        maj: (st.last_reported || 0) * 1000
      });
    });
    // Quelques stations techniques ont des coordonnées aberrantes : on les écarte
    return out.filter(s => s.lat > 43.3 && s.lat < 43.9 && s.lon > 1.1 && s.lon < 1.8);
  }

  // Roue de secours : ton backend Render
  async function fetchBackend() {
    const d = await fetchJson(BACKEND_URL + '/velo/stations', 12000);
    if (!d || !d.success || !d.stations) throw new Error('réponse backend invalide');
    return d.stations.map((s, n) => ({
      id: 'bk' + n, name: s.name, address: '', lat: s.lat, lon: s.lon,
      capacity: (s.availableBikes || 0) + (s.availableDocks || 0),
      availableBikes: s.availableBikes || 0, availableDocks: s.availableDocks || 0,
      ebikes: 0, mbikes: s.availableBikes || 0, bikesHS: 0, docksHS: 0,
      ouverte: true, retrait: true, depot: true, maj: Date.now()
    }));
  }

  /* Enrichissement par l'API v3 de JCDecaux : elle n'apporte pas de
     disponibilités plus fiables que le GBFS, mais trois choses que le GBFS
     ignore — le NUMÉRO inscrit sur la borne, la présence d'un terminal
     CARTE BANCAIRE, et le drapeau BONUS officiel.

     Note sur les stations Bonus : le drapeau existe dans l'API mais aucune
     station de Toulouse ne le porte actuellement (vérifié : 0 sur 441). Le
     programme des 15 minutes offertes semble donc à l'arrêt. La détection par
     altitude est désactivée par défaut ; si tu vois un logo Bonus sur une
     borne, marque-la à la main avec le bouton ⛰️ et Mon Bureau la respectera. */
  let v3Cache = null, v3Time = 0;

  async function enrichirV3(stations) {
    const cle = getConfig().cleJCDecaux;
    if (!cle) return stations;
    try {
      if (!v3Cache || Date.now() - v3Time > 300000) {
        v3Cache = await fetchJson(JCD_V3 + encodeURIComponent(cle), 9000);
        v3Time = Date.now();
      }
      const parNom = {};
      v3Cache.forEach(x => {
        // Le nom v3 est préfixé du numéro : "00055 - ST-SERNIN - GATIEN-ARNOULT"
        const m = /^(\d+)\s*-\s*(.*)$/.exec(x.name || '');
        const nom = (m ? m[2] : (x.name || '')).trim().toUpperCase();
        parNom[nom] = x;
      });
      stations.forEach(s => {
        const x = parNom[(s.name || '').trim().toUpperCase()];
        if (!x) return;
        s.numero = x.number;
        s.cb = !!x.banking;
        s.bonusOfficiel = !!x.bonus;
        if (x.connected === false) s.horsLigne = true;
      });
    } catch (e) {
      console.warn('[Vélô] enrichissement v3 indisponible :', e.message);
    }
    return stations;
  }

  async function fetchStations(force) {
    const now = Date.now();
    if (!force && stationsCache && now - cacheTime < CACHE_MS) return stationsCache;
    if (enCoursDeChargement) return enCoursDeChargement;

    enCoursDeChargement = (async () => {
      try {
        let s = await fetchGBFS();
        if (s.length) {
          s = await enrichirV3(s);
          stationsCache = s; cacheTime = Date.now(); sourceActive = 'GBFS direct';
          ecrire(K_CACHE, { t: cacheTime, s: s });
          return s;
        }
        throw new Error('GBFS vide');
      } catch (e1) {
        console.warn('[Vélô] GBFS indisponible :', e1.message);
        try {
          const s = await fetchBackend();
          stationsCache = s; cacheTime = Date.now(); sourceActive = 'backend Render';
          return s;
        } catch (e2) {
          console.warn('[Vélô] backend indisponible :', e2.message);
          const c = lire(K_CACHE, null);
          if (c && c.s) {
            stationsCache = c.s; cacheTime = c.t;
            sourceActive = 'hors ligne (' + ilYA(c.t) + ')';
            return c.s;
          }
          sourceActive = 'aucune donnée';
          return stationsCache || [];
        }
      } finally {
        enCoursDeChargement = null;
      }
    })();

    return enCoursDeChargement;
  }

  async function getStationsProches(lat, lon, nb, options) {
    const o = options || {};
    const stations = await fetchStations();
    let liste = stations
      .map(s => Object.assign({}, s, { dist: distance(lat == null ? HOME_LAT : lat, lon == null ? HOME_LON : lon, s.lat, s.lon) }))
      .filter(s => s.dist < (o.rayon || RAYON_MAX))
      .filter(s => s.ouverte !== false);

    if (o.pourPartir) {
      liste = liste.filter(s => s.retrait !== false);
      if (getConfig().elecSeulement) liste = liste.filter(s => s.ebikes > 0);
    }
    if (o.pourArriver) liste = liste.filter(s => s.depot !== false);

    return liste.sort((a, b) => a.dist - b.dist).slice(0, nb || 3);
  }

  /* =======================================================
     4 zéro. ARGENT
     -------------------------------------------------------
     Tarif : les N premières minutes sont incluses, puis
     1 € par demi-heure ENTAMÉE (pas au prorata : une minute
     de dépassement coûte la tranche entière).
     Au-delà du quota journalier d'emprunts, chaque emprunt
     supplémentaire coûte également 1 €.
     ======================================================= */

  function euros(v) {
    return (Math.round(v * 100) / 100).toFixed(2).replace('.', ',') + ' €';
  }

  // Coût d'un trajet, en euros, d'après sa durée en secondes
  function coutTrajet(sec, gratuitMin) {
    const c = getConfig();
    const g = gratuitMin == null ? c.minutesGratuites : gratuitMin;
    const depassement = (sec / 60) - g;
    if (depassement <= 0) return 0;
    return Math.ceil(depassement / c.dureeTranche) * c.tarifTranche;
  }

  // Secondes restantes avant que la facture augmente d'une tranche
  function secondesAvantTranche(sec, gratuitMin) {
    const c = getConfig();
    const g = gratuitMin == null ? c.minutesGratuites : gratuitMin;
    const seuilSec = g * 60;
    if (sec < seuilSec) return seuilSec - sec;
    const dans = (sec - seuilSec) % (c.dureeTranche * 60);
    return (c.dureeTranche * 60) - dans;
  }

  // Numéro de la tranche facturée en cours (0 = encore gratuit)
  function trancheActuelle(sec, gratuitMin) {
    const c = getConfig();
    const g = gratuitMin == null ? c.minutesGratuites : gratuitMin;
    const d = (sec / 60) - g;
    return d <= 0 ? 0 : Math.ceil(d / c.dureeTranche);
  }

  // Total dépensé aujourd'hui : dépassements + emprunts hors quota
  function coutDuJour() {
    const c = getConfig();
    const jour = aujourdhui();
    const histo = lire(K_HISTO, []);
    let total = 0, nb = 0;
    histo.forEach(h => {
      const d = new Date(h.debut);
      const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      if (k !== jour) return;
      nb++;
      total += (h.cout != null) ? h.cout : coutTrajet(h.duree, h.gratuit);
    });
    // trajet en cours compris dans le décompte
    const t = getTrajet();
    if (t) { nb++; total += coutTrajet(tempsEcoule(), t.gratuit); }
    const supp = Math.max(0, compteurJour().n - c.maxEmprunts);
    total += supp * c.tarifEmpruntSupp;
    return { total: total, trajets: nb, empruntsSupp: supp };
  }

  /* =======================================================
     4 bis. COMPTEUR D'EMPRUNTS DU JOUR (limite 7)
     -------------------------------------------------------
     Un "emprunt" = un vélo sorti d'une borne. Attention :
     l'astuce "Relancer" (reposer puis reprendre pour remettre
     les 30 min à zéro) consomme un emprunt de plus.
     Le compteur se remet à zéro tout seul à minuit.
     ======================================================= */

  function aujourdhui() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function compteurJour() {
    const c = lire(K_JOUR, null);
    if (!c || c.date !== aujourdhui()) return { date: aujourdhui(), n: 0 };
    return c;
  }

  function incrementerJour() {
    const c = compteurJour();
    c.n += 1;
    ecrire(K_JOUR, c);
    return c;
  }

  function empruntsRestants() {
    return Math.max(0, getConfig().maxEmprunts - compteurJour().n);
  }

  /* =======================================================
     4 ter. STATIONS BONUS (+15 min) ET UTILITÉ RÉSEAU
     -------------------------------------------------------
     Les stations Bonus sont "sur les hauteurs de la ville" et
     portent un logo sur la borne. Le flux GBFS ne les signale
     pas : on les DEVINE par l'altitude du terrain (API gratuite
     Open-Meteo, mise en cache 30 jours), et tu peux confirmer
     ou corriger chaque station d'un clic — ta correction est
     conservée et prime toujours sur la devinette.
     ======================================================= */

  let altitudes = null;

  function chargerAltitudesCache() {
    const c = lire(K_ALT, null);
    if (c && c.t && Date.now() - c.t < 30 * 24 * 3600 * 1000 && c.a) { altitudes = c.a; return true; }
    return false;
  }

  async function chargerAltitudes(stations) {
    if (!getConfig().altitudeBonus) return {};   // devinette désactivée
    if (altitudes) return altitudes;
    if (chargerAltitudesCache()) return altitudes;
    try {
      const a = {};
      for (let i = 0; i < stations.length; i += 100) {
        const lot = stations.slice(i, i + 100);
        const url = 'https://api.open-meteo.com/v1/elevation?latitude=' +
          lot.map(s => s.lat).join(',') + '&longitude=' + lot.map(s => s.lon).join(',');
        const r = await fetchJson(url, 10000);
        (r.elevation || []).forEach((m, k) => { if (lot[k]) a[lot[k].id] = m; });
      }
      altitudes = a;
      ecrire(K_ALT, { t: Date.now(), a: a });
    } catch (e) {
      console.warn('[Vélô] altitudes indisponibles :', e.message);
      altitudes = {};
    }
    return altitudes;
  }

  // true / false confirmés à la main, sinon devinette par altitude
  function estBonus(s) {
    // 1. Le drapeau officiel de l'API JCDecaux fait foi
    if (s.bonusOfficiel === true) return true;
    // 2. Sinon, ta propre confirmation (bouton ⛰️)
    const manuel = lire(K_BONUS, {});
    if (Object.prototype.hasOwnProperty.call(manuel, s.id)) return manuel[s.id];
    // 3. En dernier recours, la devinette par altitude — désactivée par défaut
    const seuil = getConfig().altitudeBonus;
    if (!seuil || !altitudes) return false;
    const alt = altitudes[s.id];
    return alt != null && alt >= seuil;
  }

  function marquerBonus(id, valeur) {
    const m = lire(K_BONUS, {});
    if (valeur === null) delete m[id]; else m[id] = valeur;
    ecrire(K_BONUS, m);
  }

  // Ton geste sert-il le rééquilibrage du réseau ?
  //   'partir'  : prendre un vélo là où la station déborde
  //   'arriver' : déposer un vélo là où la station est à sec
  function utiliteReseau(s, mode) {
    const c = getConfig();
    if (mode === 'partir') {
      if (s.availableDocks === 0) return { niveau: 2, texte: 'Station saturée — la vider aide beaucoup' };
      if (s.availableDocks <= c.seuilPleine) return { niveau: 1, texte: 'Station quasi pleine — prendre ici aide' };
    } else {
      if (s.availableBikes === 0) return { niveau: 2, texte: 'Station à sec — déposer ici aide beaucoup' };
      if (s.availableBikes <= c.seuilVide) return { niveau: 1, texte: 'Station presque vide — déposer ici aide' };
    }
    return null;
  }

  function trierUtiles(liste, mode) {
    if (!getConfig().prioriserUtiles) return liste;
    return liste.slice().sort((a, b) => {
      const ua = utiliteReseau(a, mode), ub = utiliteReseau(b, mode);
      const na = (ua ? ua.niveau : 0) + (estBonus(a) && mode === 'arriver' ? 3 : 0);
      const nb = (ub ? ub.niveau : 0) + (estBonus(b) && mode === 'arriver' ? 3 : 0);
      if (na !== nb) return nb - na;
      return a.dist - b.dist;
    });
  }

  /* --- Crédit de temps Bonus cumulé --- */
  function getCredit() { return Math.min(CREDIT_MAX, lire(K_CREDIT, 0) || 0); }
  function setCredit(m) { ecrire(K_CREDIT, Math.max(0, Math.min(CREDIT_MAX, Math.round(m)))); }
  function ajouterCredit(m) { setCredit(getCredit() + m); return getCredit(); }

  /* =======================================================
     5. GÉOLOCALISATION
     ======================================================= */

  let dernierePosition = lire('velo_derniere_position', null);
  let derniereErreurGeo = null;   // dernier échec, pour pouvoir l'expliquer

  const MESSAGES_GEO = {
    0: "La géolocalisation n'est pas disponible sur cet appareil.",
    1: "L'accès à ta position a été refusé.",
    2: "Impossible de déterminer ta position (pas de signal, pas de Wi-Fi reconnu).",
    3: "Ta position met trop de temps à arriver.",
    4: "La page doit être en HTTPS pour accéder à ta position.",
    5: "La localisation du téléphone est éteinte."
  };

  /* Une tentative de géolocalisation.

     On utilise watchPosition plutôt que getCurrentPosition. La différence
     compte beaucoup sur téléphone : getCurrentPosition ne rend qu'une seule
     réponse, et si le GPS met du temps à accrocher, elle n'arrive jamais.
     watchPosition, lui, remonte les positions au fur et à mesure — d'abord
     une estimation grossière par le réseau, puis des mesures de plus en plus
     précises. On garde la meilleure et on coupe dès qu'elle est assez bonne,
     ou à l'expiration du délai.

     precisionVoulue : en mètres. Dès qu'une mesure fait mieux, on s'arrête. */
  function tentativePosition(options, timeoutMs, precisionVoulue) {
    return new Promise(resolve => {
      if (!navigator.geolocation) {
        resolve({ ok: false, code: 0, message: MESSAGES_GEO[0] });
        return;
      }
      if (window.isSecureContext === false) {
        resolve({ ok: false, code: 4, message: MESSAGES_GEO[4] });
        return;
      }

      let fini = false;
      let meilleure = null;
      let veille = null;

      const terminer = (resultat) => {
        if (fini) return;
        fini = true;
        clearTimeout(minuteur);
        if (veille != null) {
          try { navigator.geolocation.clearWatch(veille); } catch (e) {}
        }
        resolve(resultat);
      };

      const minuteur = setTimeout(() => {
        // Delai ecoule : on rend la meilleure mesure obtenue, meme imprecise
        if (meilleure) terminer(meilleure);
        else terminer({ ok: false, code: 3, message: MESSAGES_GEO[3] });
      }, timeoutMs + 500);

      try {
        veille = navigator.geolocation.watchPosition(
          p => {
            const mesure = {
              ok: true,
              lat: p.coords.latitude,
              lon: p.coords.longitude,
              precision: Math.round(p.coords.accuracy || 0),
              t: Date.now()
            };
            if (!meilleure || mesure.precision < meilleure.precision) meilleure = mesure;
            if (mesure.precision <= (precisionVoulue || 100)) terminer(meilleure);
          },
          err => {
            // Une erreur n'annule pas une mesure deja obtenue
            if (meilleure) { terminer(meilleure); return; }
            const code = err && err.code ? err.code : 2;
            terminer({ ok: false, code: code, message: MESSAGES_GEO[code] || (err && err.message) || 'Erreur inconnue' });
          },
          options
        );
      } catch (e) {
        terminer({ ok: false, code: 2, message: MESSAGES_GEO[2] });
      }
    });
  }

  /* ---- Canal 1 : position fournie par Android lui-même ----
     Dans le launcher, on ne passe plus par la géolocalisation du WebView :
     on interroge directement le système. C'est le canal le plus fiable. */
  async function positionNative(attendre) {
    if (!pontDispo()) return null;
    try {
      if (typeof window.MBVelo.positionConnue !== 'function') return null;
      if (!window.MBVelo.positionAutorisee()) {
        derniereErreurGeo = { code: 1, message: MESSAGES_GEO[1] };
        return null;
      }
      if (!window.MBVelo.positionActivee()) {
        derniereErreurGeo = { code: 5, message: MESSAGES_GEO[5] };
        return null;
      }

      window.MBVelo.demanderPosition();   // lance une mesure fraîche

      let brut = window.MBVelo.positionConnue();
      let p = brut ? JSON.parse(brut) : null;

      // Position trop vieille : on laisse au capteur le temps de répondre
      const perimee = !p || (Date.now() - p.t > 180000);
      if (perimee && attendre !== false) {
        for (let i = 0; i < 8; i++) {
          await new Promise(r => setTimeout(r, 1200));
          brut = window.MBVelo.positionConnue();
          const q = brut ? JSON.parse(brut) : null;
          if (q && Date.now() - q.t < 180000) { p = q; break; }
          if (q && (!p || q.t > p.t)) p = q;
        }
      }
      if (!p) return null;
      return { lat: p.lat, lon: p.lon, precision: p.precision, t: p.t, canal: 'android:' + (p.source || '?') };
    } catch (e) {
      console.warn('[Vélô] position native indisponible :', e.message);
      return null;
    }
  }

  /* ---- Canal 3 : localisation par adresse IP ----
     Dernier recours, sans aucune permission. Précision de l'ordre du
     quartier ou de la ville : suffisant pour ne pas se retrouver le bec
     dans l'eau, mais toujours signalé comme approximatif. */
  async function positionIP() {
    const services = [
      { url: 'https://ipwho.is/', lat: d => d.latitude, lon: d => d.longitude, ville: d => d.city },
      { url: 'https://get.geojs.io/v1/ip/geo.json', lat: d => parseFloat(d.latitude), lon: d => parseFloat(d.longitude), ville: d => d.city }
    ];
    for (const s of services) {
      try {
        const d = await fetchJson(s.url, 6000);
        const lat = s.lat(d), lon = s.lon(d);
        if (typeof lat === 'number' && typeof lon === 'number' && !isNaN(lat) && !isNaN(lon)) {
          return { lat: lat, lon: lon, precision: 10000, t: Date.now(), canal: 'ip', ville: s.ville(d) || '' };
        }
      } catch (e) {}
    }
    return null;
  }

  /* Géolocalisation en deux temps.

     Beaucoup d'échecs venaient d'une seule tentative en HAUTE PRÉCISION :
     elle réclame le GPS, qui ne capte pas en intérieur et n'existe pas sur un
     ordinateur. La demande expirait alors sans rien renvoyer, alors qu'une
     position Wi-Fi aurait répondu en une seconde.

     On essaie donc d'abord le GPS, brièvement ; s'il ne répond pas, on
     retombe sur la position réseau, moins précise mais quasi immédiate et
     largement suffisante pour trouver les stations autour de toi. */
  async function maPosition(timeoutMs) {
    const total = timeoutMs || 12000;

    // Essai 1 : GPS, on vise 60 m, pendant les deux tiers du temps imparti
    const t1 = Math.max(5000, Math.round(total * 0.65));
    let r = await tentativePosition(
      { enableHighAccuracy: true, timeout: t1, maximumAge: 30000 },
      t1, 60
    );

    // Essai 2 : réseau (Wi-Fi, antennes), tolérant sur la précision
    if (!r.ok && r.code !== 1) {
      r = await tentativePosition(
        { enableHighAccuracy: false, timeout: total, maximumAge: 300000 },
        total, 2000
      );
    }

    if (r.ok) {
      derniereErreurGeo = null;
      dernierePosition = { lat: r.lat, lon: r.lon, precision: r.precision, t: r.t };
      ecrire('velo_derniere_position', dernierePosition);
      return dernierePosition;
    }

    derniereErreurGeo = r;
    console.warn('[Vélô] géolocalisation échouée :', r.code, r.message);
    return null;
  }

  /* Point de référence, par ordre de préférence :
       1. position fraîche de moins de 2 minutes
       2. nouvelle mesure
       3. dernière position connue de moins de 24 h (marquée « ancienne »)
       4. adresse maison (marquée « approximative ») */
  function marquer(p) {
    if (!p) return p;
    if (p.canal === 'ip') return Object.assign({}, p, { parIP: true });
    return p;
  }

  async function pointDeReference() {
    // Mode manuel : on n'interroge plus aucun capteur, on part du point de repère
    if (getConfig().positionManuelle) {
      const d = getDomicile();
      return { lat: d.lat, lon: d.lon, t: Date.now(), manuel: true, nom: d.nom };
    }

    if (dernierePosition && Date.now() - dernierePosition.t < 120000) return marquer(dernierePosition);

    // Canal 1 — Android natif (le plus fiable, quand il est disponible)
    const n = await positionNative();
    if (n) {
      derniereErreurGeo = null;
      dernierePosition = n;
      ecrire('velo_derniere_position', n);
      return n;
    }

    // Canal 2 — géolocalisation du navigateur, GPS puis réseau
    const p = await maPosition(12000);
    if (p) return p;

    // Canal 3 — dernière position connue de moins de 24 h
    if (dernierePosition && Date.now() - dernierePosition.t < 86400000) {
      return Object.assign({}, marquer(dernierePosition), { ancienne: true });
    }

    /* Canal 4 — point de repère.
       Il passe AVANT le repérage par adresse IP : une adresse que tu as
       saisie toi-même vaut mieux qu'une estimation par la connexion, qui
       pointe en general le centre de la ville, soit plusieurs kilometres
       a cote. */
    const d = getDomicile();
    if (d && d.lat) {
      return { lat: d.lat, lon: d.lon, approx: true, nom: d.nom };
    }

    // Canal 5 — repérage par adresse IP, en tout dernier recours
    const ip = await positionIP();
    if (ip) {
      dernierePosition = ip;
      ecrire('velo_derniere_position', ip);
      return Object.assign({}, ip, { parIP: true });
    }

    return { lat: HOME_LAT, lon: HOME_LON, approx: true, nom: 'adresse par défaut' };
  }

  function etatGeoloc() {
    let natif = null;
    if (pontDispo() && typeof window.MBVelo.positionAutorisee === 'function') {
      try {
        natif = {
          autorisee: window.MBVelo.positionAutorisee(),
          activee: window.MBVelo.positionActivee()
        };
      } catch (e) { natif = null; }
    }
    return {
      securise: window.isSecureContext !== false,
      api: !!navigator.geolocation,
      natif: natif,
      position: dernierePosition,
      erreur: derniereErreurGeo
    };
  }

  /* =======================================================
     6. FAVORIS
     ======================================================= */

  function getFavoris() {
    const f = lire(K_FAVORIS, null);
    if (f && Array.isArray(f) && f.length) return f;
    return [{ nom: '🏠 Maison', lat: HOME_LAT, lon: HOME_LON }];
  }

  function ajouterFavori(nom, lat, lon) {
    const f = getFavoris().filter(x => x.nom !== nom);
    f.push({ nom: nom, lat: lat, lon: lon });
    ecrire(K_FAVORIS, f.slice(-12));
  }

  function supprimerFavori(nom) {
    ecrire(K_FAVORIS, getFavoris().filter(x => x.nom !== nom));
  }

  /* =======================================================
     7. TRAJET EN COURS
     -------------------------------------------------------
     Le trajet est enregistré dans localStorage avec l'heure
     de départ. Résultat : tu peux fermer Mon Bureau, éteindre
     l'écran, revenir 20 minutes plus tard — le chrono est juste.
     ======================================================= */

  function getTrajet() { return lire(K_TRAJET, null); }

  function demarrerTrajet(depart, arrivee) {
    const c = getConfig();
    const t = {
      debut: Date.now(),
      depart: depart ? { nom: depart.name, lat: depart.lat, lon: depart.lon, id: depart.id } : null,
      arrivee: arrivee ? { nom: arrivee.nom || arrivee.name, lat: arrivee.lat, lon: arrivee.lon, id: arrivee.id || null } : null,
      gratuit: c.minutesGratuites,
      alertes: {}
    };
    ecrire(K_TRAJET, t);
    lancerBulle(t);
    garderEcranAllume();
    demarrerGuidage(t);
    const j = incrementerJour();
    reveilAudio();
    demanderNotifications();
    Sons.depart();
    const reste = Math.max(0, c.maxEmprunts - j.n);
    notifier('🚲 Trajet démarré — ' + c.minutesGratuites + ' min · ' + j.n + '/' + c.maxEmprunts + ' emprunts');
    parler('Trajet démarré. ' + (t.gratuit || c.minutesGratuites) + ' minutes incluses. '
         + 'Emprunt ' + j.n + ' sur ' + c.maxEmprunts + '.');
    if (reste === 1) {
      Sons.avertir();
      pousserNotif('VélôToulouse', 'Attention : il ne te reste qu\'un emprunt aujourd\'hui.');
    } else if (reste === 0) {
      Sons.alerte();
      pousserNotif('VélôToulouse', 'Tu viens d\'utiliser ton dernier emprunt de la journée.');
    }
    lancerHorloge();
    rafraichirTuile();
    return t;
  }

  function arreterTrajet() {
    const t = getTrajet();
    if (!t) return null;
    const duree = Math.round((Date.now() - t.debut) / 1000);
    const histo = lire(K_HISTO, []);
    histo.unshift({
      debut: t.debut, fin: Date.now(), duree: duree,
      depart: t.depart ? t.depart.nom : '—',
      arrivee: t.arrivee ? t.arrivee.nom : '—',
      depassement: Math.max(0, Math.round(duree / 60) - (t.gratuit || 30)),
      gratuit: t.gratuit || getConfig().minutesGratuites,
      cout: coutTrajet(duree, t.gratuit)
    });
    ecrire(K_HISTO, histo.slice(0, 40));
    localStorage.removeItem(K_TRAJET);
    stopperBulle();
    relacherEcran();
    arreterGuidage();
    Sons.arrivee();
    const cout = coutTrajet(duree, t.gratuit);
    notifier('🏁 Trajet terminé — ' + chrono(duree) + (cout > 0 ? ' · ' + euros(cout) : ' · gratuit'));
    rafraichirTuile();
    proposerCreditBonus(t);
    return duree;
  }

  // Si tu viens de déposer dans une station repérée comme Bonus,
  // on te propose d'encaisser les 15 minutes de crédit.
  async function proposerCreditBonus(t) {
    try {
      if (!t || !t.arrivee) return;
      const stations = await fetchStations();
      await chargerAltitudes(stations);
      const proche = stations
        .map(x => Object.assign({}, x, { dist: distance(t.arrivee.lat, t.arrivee.lon, x.lat, x.lon) }))
        .sort((a, b) => a.dist - b.dist)[0];
      if (!proche || proche.dist > 250 || !estBonus(proche)) return;
      setTimeout(() => {
        if (confirm('⛰️ ' + proche.name + ' est repérée comme station Bonus.\n\nAjouter 15 minutes à ton crédit ?')) {
          const c = ajouterCredit(15);
          notifier('⛰️ Crédit Bonus : ' + c + ' min disponibles');
        }
      }, 900);
    } catch (e) {}
  }

  function tempsEcoule() {
    const t = getTrajet();
    return t ? Math.round((Date.now() - t.debut) / 1000) : 0;
  }

  /* --- Horloge : surveille le chrono ET la station d'arrivée --- */

  let horloge = null;
  let derniereVerifArrivee = 0;

  function lancerHorloge() {
    if (horloge) return;
    horloge = setInterval(tic, 1000);
  }

  function arreterHorloge() {
    if (!horloge) return;
    clearInterval(horloge); horloge = null;
  }

  async function tic() {
    const t = getTrajet();
    if (!t) { arreterHorloge(); majBanniereTrajet(); rafraichirTuile(); return; }

    const sec = Math.round((Date.now() - t.debut) / 1000);
    const min = Math.floor(sec / 60);
    const c = getConfig();
    const gratuit = t.gratuit || c.minutesGratuites;
    const seuilAvert = Math.max(1, gratuit - (c.alerteAvant || 5));
    let modifie = false;

    if (min >= seuilAvert && !t.alertes.avert) {
      t.alertes.avert = true; modifie = true;
      Sons.avertir();
      notifier('⏰ Plus que ' + (gratuit - min) + ' min de temps inclus');
      pousserNotif('VélôToulouse', 'Plus que ' + (gratuit - min) + ' minutes de temps inclus.');
      parler('Attention, plus que ' + (gratuit - min) + ' minutes de temps inclus.', true);
    }
    if (min >= gratuit && !t.alertes.fin) {
      t.alertes.fin = true; modifie = true;
      Sons.alerte();
      notifier('🔴 Temps inclus dépassé');
      pousserNotif('VélôToulouse', 'Temps inclus dépassé — pense à reposer le vélo.');
      parler('Temps inclus dépassé. Le trajet est maintenant facturé.', true);
    }
    // Avertissement quelques minutes avant CHAQUE nouvelle tranche facturée
    const avantTranche = secondesAvantTranche(sec, gratuit);
    if (avantTranche <= (c.alerteTranche || 3) * 60) {
      const cle = 'p' + trancheActuelle(sec, gratuit);
      if (!t.alertes[cle]) {
        t.alertes[cle] = true; modifie = true;
        const futur = (trancheActuelle(sec, gratuit) + 1) * c.tarifTranche;
        Sons.avertir();
        pousserNotif('VélôToulouse',
          'Dans ' + Math.ceil(avantTranche / 60) + ' min, le trajet passe à ' + euros(futur) + '.');
      }
    }
    // Franchissement d'une tranche : la facture vient d'augmenter
    const tr = trancheActuelle(sec, gratuit);
    if (tr > 0 && !t.alertes['t' + tr]) {
      t.alertes['t' + tr] = true; modifie = true;
      Sons.alerte();
      notifier('💶 Trajet : ' + euros(tr * c.tarifTranche));
      pousserNotif('VélôToulouse', 'Trajet facturé ' + euros(tr * c.tarifTranche) + '.');
      parler('Trajet facturé ' + (tr * c.tarifTranche) + ' euros.');
    }
    if (modifie) ecrire(K_TRAJET, t);

    // Surveillance des places libres à la station d'arrivée (toutes les 60 s)
    if (t.arrivee && Date.now() - derniereVerifArrivee > 60000) {
      derniereVerifArrivee = Date.now();
      try {
        const proches = await getStationsProches(t.arrivee.lat, t.arrivee.lon, 1, { pourArriver: true, rayon: 200 });
        const cible = proches[0];
        if (cible && cible.availableDocks <= 1 && !t.alertes.pleine) {
          t.alertes.pleine = true; ecrire(K_TRAJET, t);
          Sons.avertir();
          notifier('⚠️ ' + cible.name + ' est presque pleine');
          pousserNotif('VélôToulouse', cible.name + ' : plus que ' + cible.availableDocks + ' place(s). Prévois une station de repli.');
          parler('Attention, la station ' + cible.name + ' est presque pleine. '
               + (cible.availableDocks === 0 ? 'Aucune place libre.' : 'Plus que ' + cible.availableDocks + ' place.')
               + ' Prévois une autre station.', true);
        }
      } catch (e) {}
    }

    majAffichageChrono(sec);
  }

  function majAffichageChrono(sec) {
    const t = getTrajet();
    const gratuit = t ? (t.gratuit || getConfig().minutesGratuites) : 30;
    const pct = Math.min(100, (sec / (gratuit * 60)) * 100);
    const coul = pct < 70 ? 'var(--accent-3)' : pct < 100 ? 'var(--accent-4)' : 'var(--accent-2)';

    document.querySelectorAll('[data-velo-chrono]').forEach(el => { el.textContent = chrono(sec); el.style.color = coul; });
    document.querySelectorAll('[data-velo-jauge]').forEach(el => { el.style.width = pct + '%'; el.style.background = coul; });
    document.querySelectorAll('[data-velo-reste]').forEach(el => {
      const reste = gratuit * 60 - sec;
      el.textContent = reste > 0
        ? 'Il reste ' + chrono(reste) + ' de temps inclus'
        : 'Dépassement : ' + chrono(-reste);
      el.style.color = reste > 0 ? 'var(--ink-mid)' : 'var(--accent-2)';
    });

    // Prix du trajet en cours, et compte à rebours avant la tranche suivante
    const cout = coutTrajet(sec, gratuit);
    const avant = secondesAvantTranche(sec, gratuit);
    const prochain = cout + getConfig().tarifTranche;
    document.querySelectorAll('[data-velo-euros]').forEach(el => {
      el.textContent = cout > 0 ? euros(cout) : 'gratuit';
      el.style.color = cout > 0 ? 'var(--accent-2)' : 'var(--accent-3)';
    });
    document.querySelectorAll('[data-velo-prochain]').forEach(el => {
      el.textContent = euros(prochain) + ' dans ' + chrono(avant);
      el.style.color = avant <= 180 ? 'var(--accent-2)' : 'var(--ink-mid)';
      el.style.fontWeight = avant <= 180 ? '700' : '400';
    });
  }

  /* =======================================================
     7 bis. PILOTAGE AUTOMATIQUE PAR LES NOTIFICATIONS
     -------------------------------------------------------
     Quand Mon Bureau tourne dans le launcher Android, le pont
     window.MBVelo donne accès aux notifications de l'appli
     officielle vélôToulouse. Elle prévient au déverrouillage
     du vélo et à sa restitution : le chrono se pilote donc
     tout seul, sans mot de passe et sans saisie.
     ======================================================= */

  function pontDispo() {
    try { return !!(window.MBVelo && typeof window.MBVelo.version === 'function'); }
    catch (e) { return false; }
  }

  function pontAutorise() {
    try { return pontDispo() && window.MBVelo.autorise(); } catch (e) { return false; }
  }

  function pontJson(methode) {
    try { return JSON.parse(window.MBVelo[methode]() || '[]'); } catch (e) { return []; }
  }

  let dernierEventTraite = lire('velo_dernier_event', 0);

  async function releverEvenements() {
    if (!pontAutorise()) return;
    const evts = pontJson('evenements');
    if (!evts.length) return;

    let traite = false;
    for (const ev of evts) {
      if (!ev || !ev.t || ev.t <= dernierEventTraite) continue;
      dernierEventTraite = ev.t;
      ecrire('velo_dernier_event', dernierEventTraite);
      traite = true;

      if (ev.type === 'DEBUT' && !getTrajet()) {
        // Départ détecté : on repart de la station la plus proche connue
        let station = null;
        try {
          const p = await pointDeReference();
          const proches = await getStationsProches(p.lat, p.lon, 1, {});
          station = proches[0] || null;
        } catch (e) {}
        demarrerTrajet(station, destination);
        notifier('🤖 Départ détecté par l\'appli officielle');
      } else if (ev.type === 'FIN' && getTrajet()) {
        const duree = arreterTrajet();
        notifier('🤖 Restitution détectée · ' + chrono(duree));
      }
    }
    if (traite) { try { window.MBVelo.viderEvenements(); } catch (e) {} }
    rafraichirTuile();
  }

  function lancerEcouteAndroid() {
    if (!pontDispo()) return;
    releverEvenements();
    setInterval(releverEvenements, 8000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') releverEvenements();
    });
    console.log('🤖 Pont Android vélo actif — autorisé :', pontAutorise());
  }

  /* ---- Garder l'ecran allume pendant un trajet ----
     A velo, un ecran qui s'eteint toutes les 30 secondes oblige a
     deverrouiller sans arret. Tant qu'un trajet est en cours, on demande
     au navigateur de maintenir l'ecran actif. Le verrou est relache des
     que le trajet se termine, pour ne pas vider la batterie. */

  let verrouEcran = null;

  async function garderEcranAllume() {
    try {
      if (!('wakeLock' in navigator) || verrouEcran) return;
      verrouEcran = await navigator.wakeLock.request('screen');
      verrouEcran.addEventListener('release', () => { verrouEcran = null; });
    } catch (e) {
      // Refuse quand l'onglet n'est pas au premier plan : sans gravite
    }
  }

  function relacherEcran() {
    try { if (verrouEcran) { verrouEcran.release(); verrouEcran = null; } } catch (e) {}
  }

  /* ---- Bulle flottante (application Android seulement) ----
     Elle reste affichée par-dessus les autres applications, VélôToulouse
     compris. Le service Android recalcule le temps lui-même à partir de
     l'heure de départ : Mon Bureau peut être fermé, la bulle reste juste. */

  function bulleDisponible() {
    try { return pontDispo() && typeof window.MBVelo.demarrerBulle === 'function'; }
    catch (e) { return false; }
  }

  function bulleAutorisee() {
    try { return bulleDisponible() && window.MBVelo.bulleAutorisee(); }
    catch (e) { return false; }
  }

  function lancerBulle(t) {
    if (!bulleDisponible()) return;

    /* Si l'autorisation manque, on la demande au lieu d'abandonner en
       silence : c'est le moment ou la bulle sert, donc le bon moment pour
       la reclamer. Une seule demande par jour pour ne pas etre penible. */
    if (!bulleAutorisee()) {
      const dejaDemande = lire('velo_bulle_demande', 0);
      if (Date.now() - dejaDemande > 86400000) {
        ecrire('velo_bulle_demande', Date.now());
        notifier('🫧 Autorise l\'affichage par-dessus pour voir le chrono partout');
        try { window.MBVelo.demanderBulle(); } catch (e) {}
      }
      return;
    }

    try {
      const c = getConfig();
      window.MBVelo.demarrerBulle(
        String(t.debut),
        t.gratuit || c.minutesGratuites,
        String(c.tarifTranche),
        c.dureeTranche
      );
    } catch (e) { console.warn('[Vélô] bulle : ' + e.message); }
  }

  function stopperBulle() {
    if (!bulleDisponible()) return;
    try { window.MBVelo.arreterBulle(); } catch (e) {}
  }

  /* =======================================================
     7 ter. AGENDA
     -------------------------------------------------------
     La tuile Agenda de Mon Bureau range déjà tes rendez-vous
     dans window.state.events, avec leur lieu tel qu'il figure
     dans Google Agenda. On le lit directement : aucune
     nouvelle connexion Google à faire.

     Chaque lieu est transformé en coordonnées par Nominatim,
     le service d'adresses d'OpenStreetMap. Le résultat est
     gardé en mémoire pour ne pas réinterroger le service à
     chaque ouverture.
     ======================================================= */

  const K_GEOCACHE = 'velo_geocache';

  function evenementsAvecLieu(joursAvant) {
    let evts = [];
    try { evts = (window.state && window.state.events) || []; } catch (e) { return []; }

    const maintenant = new Date();
    const limite = new Date(maintenant.getTime() + (joursAvant || 7) * 86400000);

    return evts
      .filter(e => e && e.lieu && String(e.lieu).trim().length > 3 && e.date)
      .map(e => {
        // date "2026-08-12" + heure "14:30"
        const [a, m, j] = String(e.date).split('-').map(Number);
        const [hh, mm] = String(e.time || '09:00').split(':').map(Number);
        const quand = new Date(a, (m || 1) - 1, j || 1, hh || 9, mm || 0);
        return Object.assign({}, e, { quand: quand });
      })
      .filter(e => e.quand >= new Date(maintenant.getTime() - 3600000) && e.quand <= limite)
      .sort((x, y) => x.quand - y.quand);
  }

  /* Adresse -> coordonnées, via OpenStreetMap. Le résultat est conservé,
     et Toulouse est ajoutée d'office si l'adresse ne cite aucune ville. */
  async function geocoder(adresse) {
    const cle = String(adresse).trim().toLowerCase();
    if (!cle) return null;

    const cache = lire(K_GEOCACHE, {});
    if (cache[cle]) {
      if (cache[cle].vide) return null;
      return cache[cle];
    }

    let requete = adresse.trim();
    if (!/toulouse|31\d{3}|blagnac|colomiers|balma|ramonville|tournefeuille/i.test(requete)) {
      requete += ', Toulouse';
    }

    try {
      const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=fr&q='
                + encodeURIComponent(requete);
      const d = await fetchJson(url, 9000);
      if (!d || !d.length) {
        cache[cle] = { vide: true };
        ecrire(K_GEOCACHE, cache);
        return null;
      }
      const r = {
        lat: parseFloat(d[0].lat),
        lon: parseFloat(d[0].lon),
        nom: d[0].display_name.split(',').slice(0, 3).join(',').trim()
      };
      cache[cle] = r;
      ecrire(K_GEOCACHE, cache);
      return r;
    } catch (e) {
      console.warn('[Vélô] adresse introuvable :', adresse, e.message);
      return null;
    }
  }

  /* Heure a laquelle il faut sortir de chez soi :
     marche jusqu'a la station de depart, velo, puis marche jusqu'au lieu. */
  function calculerDepart(evt, stationDepart, stationArrivee, origine) {
    const mDepart  = walkMinutes(stationDepart.dist);
    const mVelo    = bikeMinutes(distance(stationDepart.lat, stationDepart.lon,
                                          stationArrivee.lat, stationArrivee.lon));
    const mArrivee = walkMinutes(stationArrivee.dist);
    const marge    = 5;   // temps de prise et de repose du velo
    const total    = mDepart + mVelo + mArrivee + marge;

    const partirA = new Date(evt.quand.getTime() - total * 60000);
    return {
      mDepart: mDepart, mVelo: mVelo, mArrivee: mArrivee, total: total,
      partirA: partirA,
      retard: partirA < new Date()
    };
  }

  /* =======================================================
     8. LA TUILE DE L'ACCUEIL
     ======================================================= */

  const ID_TUILE = 'tuile-velo';

  function injecterTuile() {
    if (document.getElementById(ID_TUILE)) return;
    const main = document.querySelector('main.desktop') || document.querySelector('main');
    if (!main) { setTimeout(injecterTuile, 300); return; }

    const sec = document.createElement('section');
    sec.className = 'tile tile-velo';
    sec.id = ID_TUILE;
    sec.setAttribute('data-app', 'velo');
    sec.setAttribute('role', 'button');
    sec.setAttribute('tabindex', '0');
    sec.innerHTML = `
      <div class="tile-header">
        <span class="tile-label">VélôToulouse</span>
      </div>
      <div class="tile-body" id="velo-tuile-corps">
        <div style="text-align:center;padding:14px 0;color:var(--ink-mid);font-size:12px">Chargement…</div>
      </div>
      <div class="tile-foot">Ouvrir →</div>
    `;
    main.appendChild(sec);
    rafraichirTuile();
  }

  /* ---- Bannière épinglée en haut de l'accueil pendant un trajet ----
     La tuile vélo vit dans le tiroir « Déplacements », qui est replié par
     défaut : un chronomètre enfermé dedans ne sert à rien. Pendant un trajet,
     on affiche donc une bannière tout en haut de l'écran d'accueil, visible
     sans rien déplier.

     Point technique : cette bannière n'a PAS la classe « tile ». C'est
     volontaire — le surveillant de tiroirs-accueil.js ne réagit qu'aux
     éléments portant cette classe, il ignore donc totalement la bannière et
     ne cherchera jamais à la ranger. Même principe que le panneau du matin. */

  const ID_BANNIERE = 'velo-trajet-pinned';

  function majBanniereTrajet() {
    const main = document.querySelector('main.desktop') || document.querySelector('main');
    if (!main) return;

    const t = getTrajet();
    const existante = document.getElementById(ID_BANNIERE);

    if (!t) { if (existante) existante.remove(); return; }

    const sec = tempsEcoule();
    if (!existante) {
      const b = document.createElement('div');
      b.id = ID_BANNIERE;
      b.style.cssText = 'grid-column:1/-1;background:var(--bg-card);border-radius:var(--radius);' +
        'box-shadow:var(--shadow-sm);padding:14px 16px;cursor:pointer;border-left:5px solid var(--accent-3)';
      b.innerHTML = `
        <div style="display:flex;align-items:center;gap:14px">
          <div style="font-size:26px;line-height:1">🚲</div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:baseline;gap:9px">
              <span data-velo-chrono style="font-family:var(--font-mono);font-size:32px;font-weight:700;line-height:1">${chrono(sec)}</span>
              <span data-velo-euros style="font-family:var(--font-mono);font-size:16px;font-weight:700">—</span>
            </div>
            <div style="height:6px;background:var(--line);border-radius:999px;overflow:hidden;margin:8px 0 5px">
              <div data-velo-jauge style="height:100%;width:0%;border-radius:999px;transition:width .5s linear"></div>
            </div>
            <div style="display:flex;justify-content:space-between;gap:8px;font-size:11px">
              <span data-velo-reste style="color:var(--ink-mid)">—</span>
              <span data-velo-prochain style="color:var(--ink-mid);text-align:right">—</span>
            </div>
          </div>
          <button id="velo-stop-banniere" style="flex-shrink:0;padding:14px 15px;border:none;border-radius:var(--radius-sm);
            background:var(--accent-2);color:#fff;font:inherit;font-size:13px;font-weight:700;cursor:pointer;line-height:1.3">🏁<br>Reposé</button>
        </div>
        <div id="velo-guidage" style="margin-top:10px;padding:9px 11px;background:var(--accent-1);border-radius:var(--radius-sm);display:none"></div>
        <div id="velo-banniere-arrivee" style="margin-top:10px;padding-top:9px;border-top:1px solid var(--line);display:none"></div>`;

      // Se place en tête, mais après le panneau du matin s'il est là
      const matin = document.getElementById('dashboard-matin-pinned');
      if (matin && matin.parentNode === main) matin.after(b);
      else main.prepend(b);

      b.addEventListener('click', e => {
        if (e.target.closest('#velo-stop-banniere')) return;
        ouvrirPanneau();
      });
      const stop = b.querySelector('#velo-stop-banniere');
      if (stop) stop.onclick = e => { e.stopPropagation(); arreterTrajet(); };
    }
    majAffichageChrono(sec);
    majArriveeBanniere();
  }

  /* Les places libres a l'arrivee, directement dans la banniere.
     C'est l'information dont on a besoin en roulant, et elle doit etre
     lisible sans ouvrir quoi que ce soit. */
  let derniereMajArrivee = 0;

  async function majArriveeBanniere(forcer) {
    const zone = document.getElementById('velo-banniere-arrivee');
    if (!zone) return;
    const t = getTrajet();
    if (!t || !t.arrivee) { zone.style.display = 'none'; return; }
    if (!forcer && Date.now() - derniereMajArrivee < 45000) return;
    derniereMajArrivee = Date.now();

    try {
      let proches = await getStationsProches(t.arrivee.lat, t.arrivee.lon, 4, { pourArriver: true, rayon: 700 });
      if (!proches.length) { zone.style.display = 'none'; return; }
      proches = trierUtiles(proches, 'arriver').slice(0, 3);

      zone.style.display = 'block';
      zone.innerHTML = `
        <div style="font-size:10px;color:var(--ink-mid);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">
          Places libres à l'arrivée · ${esc(t.arrivee.nom)}
        </div>
        <div style="display:flex;gap:7px">
          ${proches.map(s => {
            const n = s.availableDocks;
            const coul = n >= 4 ? 'var(--accent-3)' : n >= 1 ? 'var(--accent-4)' : 'var(--accent-2)';
            return `
              <div style="flex:1;text-align:center;padding:7px 4px;border:1px solid var(--line);
                border-radius:var(--radius-sm);background:var(--bg-elev)">
                <div style="font-family:var(--font-mono);font-size:19px;font-weight:700;color:${coul};line-height:1">${n}</div>
                <div style="font-size:9px;color:var(--ink-mid);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.name)}</div>
              </div>`;
          }).join('')}
        </div>`;
    } catch (e) {
      zone.style.display = 'none';
    }
  }

  async function rafraichirTuile() {
    majBanniereTrajet();
    const corps = document.getElementById('velo-tuile-corps');
    if (!corps) return;

    const t = getTrajet();

    // --- Cas 1 : un trajet est en cours -> la tuile devient un chronomètre
    if (t) {
      const sec = tempsEcoule();
      const gratuit = t.gratuit || getConfig().minutesGratuites;
      corps.innerHTML = `
        <div style="text-align:center;padding:6px 0 2px">
          <div style="font-size:11px;color:var(--ink-mid);letter-spacing:.06em;text-transform:uppercase">Trajet en cours</div>
          <div data-velo-chrono style="font-family:var(--font-mono);font-size:34px;font-weight:700;line-height:1.15;margin:4px 0">${chrono(sec)}</div>
          <div style="height:5px;background:var(--line);border-radius:999px;overflow:hidden;margin:6px 2px">
            <div data-velo-jauge style="height:100%;width:0%;border-radius:999px;transition:width .5s linear"></div>
          </div>
          <div data-velo-reste style="font-size:11px;color:var(--ink-mid);margin-top:5px">—</div>
          <div style="display:flex;justify-content:center;align-items:baseline;gap:6px;margin-top:6px">
            <span data-velo-euros style="font-family:var(--font-mono);font-size:17px;font-weight:700">—</span>
            <span data-velo-prochain style="font-size:10px;color:var(--ink-mid)">—</span>
          </div>
          ${t.arrivee ? `<div style="font-size:11px;color:var(--ink-mid);margin-top:3px">→ ${esc(t.arrivee.nom)}</div>` : ''}
        </div>
        <button id="velo-stop-tuile" style="width:100%;margin-top:8px;padding:9px;border:none;border-radius:var(--radius-sm);
          background:var(--accent-2);color:#fff;font:inherit;font-size:12px;font-weight:700;cursor:pointer">🏁 J'ai reposé le vélo</button>
      `;
      majAffichageChrono(sec);
      const b = document.getElementById('velo-stop-tuile');
      if (b) b.onclick = (e) => { e.stopPropagation(); arreterTrajet(); };
      lancerHorloge();
      return;
    }

    // --- Cas 2 : au repos -> les 2 meilleures stations autour de toi
    try {
      const p = await pointDeReference();
      const stations = await getStationsProches(p.lat, p.lon, 2, { pourPartir: true });
      if (!stations.length) {
        corps.innerHTML = `<div style="text-align:center;padding:14px 0;color:var(--ink-mid);font-size:12px">Aucune station dans ${distanceText(RAYON_MAX)}</div>`;
        return;
      }
      corps.innerHTML = stations.map(s => {
        const ok = s.availableBikes > 0;
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)">
            <div style="min-width:0">
              <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.name)}</div>
              <div style="font-size:10px;color:var(--ink-mid)">🚶 ${walkMinutes(s.dist)} min · ${distanceText(s.dist)}</div>
            </div>
            <div style="display:flex;gap:10px;flex-shrink:0;text-align:center">
              <div>
                <div style="font-size:16px;font-weight:700;font-family:var(--font-mono);color:${ok ? 'var(--accent-3)' : 'var(--accent-2)'}">${s.availableBikes}</div>
                <div style="font-size:9px;color:var(--ink-mid)">🚲${s.ebikes ? ' ⚡' + s.ebikes : ''}</div>
              </div>
              <div>
                <div style="font-size:16px;font-weight:700;font-family:var(--font-mono);color:${s.availableDocks > 0 ? 'var(--ink)' : 'var(--accent-2)'}">${s.availableDocks}</div>
                <div style="font-size:9px;color:var(--ink-mid)">🅿️</div>
              </div>
            </div>
          </div>`;
      }).join('') + (() => {
        const conf = getConfig();
        const j = compteurJour();
        const reste = Math.max(0, conf.maxEmprunts - j.n);
        const coulR = reste === 0 ? 'var(--accent-2)' : reste <= 2 ? 'var(--accent-4)' : 'var(--ink-mid)';
        const utile = stations.find(x => utiliteReseau(x, 'partir'));
        return `
          ${utile ? `<div style="font-size:10px;color:var(--accent);font-weight:700;margin-top:6px">🎁 ${esc(utile.name)} est saturée — y prendre un vélo rapporte</div>` : ''}
          <div style="display:flex;justify-content:space-between;font-size:9px;margin-top:5px">
            <span style="color:${coulR};font-weight:700">${j.n}/${conf.maxEmprunts} emprunts</span>
            <span style="color:var(--ink-low)">${p.manuel ? '📌 position fixe' : p.approx ? '📍 point de repère' : p.parIP ? '🌐 estimation ville' : p.ancienne ? '📍 position datée' : '📍 autour de toi'}</span>
          </div>`;
      })();
    } catch (e) {
      corps.innerHTML = `<div style="text-align:center;padding:14px 0;color:var(--ink-mid);font-size:12px">Données indisponibles</div>`;
    }
  }

  /* =======================================================
     9. LE PANNEAU COMPLET
     ======================================================= */

  let ongletActif = 'depart';
  let panneauInitialise = false;
  let destination = null;      // { nom, lat, lon }
  let rafraichissement = null;

  function ouvrirPanneau() {
    reveilAudio();
    panneauInitialise = false;   // l'onglet du trajet s'impose a l'ouverture, pas apres
    const html = `<div id="velo-panel"><div style="padding:26px 0;text-align:center;color:var(--ink-mid)">Chargement des stations…</div></div>`;
    if (typeof window.openSheet === 'function') {
      window.openSheet('🚲 VélôToulouse', html, () => { dessinerPanneau(); demarrerRafraichissement(); });
    } else {
      panneauSecours(html);
      dessinerPanneau(); demarrerRafraichissement();
    }
  }

  // Fenêtre de secours si openSheet() n'existe pas (page isolée, test local…)
  function panneauSecours(html) {
    let ov = document.getElementById('velo-overlay');
    if (ov) ov.remove();
    ov = document.createElement('div');
    ov.id = 'velo-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.4);display:flex;align-items:flex-end';
    ov.innerHTML = `<div style="background:var(--bg-card,#fff);width:100%;max-height:88vh;overflow:auto;border-radius:22px 22px 0 0;padding:18px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <strong style="font-size:16px">🚲 VélôToulouse</strong>
        <button id="velo-close" style="border:none;background:none;font-size:20px;cursor:pointer">✕</button>
      </div>${html}</div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', e => { if (e.target === ov) fermerPanneau(); });
    const c = document.getElementById('velo-close');
    if (c) c.onclick = fermerPanneau;
  }

  function fermerPanneau() {
    const ov = document.getElementById('velo-overlay');
    if (ov) ov.remove();
    if (typeof window.closeSheet === 'function') window.closeSheet();
    arreterRafraichissement();
  }

  function demarrerRafraichissement() {
    arreterRafraichissement();
    rafraichissement = setInterval(() => {
      if (!document.getElementById('velo-panel')) { arreterRafraichissement(); return; }
      dessinerPanneau(true);
    }, 60000);
  }

  function arreterRafraichissement() {
    if (rafraichissement) { clearInterval(rafraichissement); rafraichissement = null; }
  }

  async function dessinerPanneau(silencieux) {
    const zone = document.getElementById('velo-panel');
    if (!zone) return;
    if (!silencieux) zone.innerHTML = `<div style="padding:26px 0;text-align:center;color:var(--ink-mid)">Chargement des stations…</div>`;

    await fetchStations(!!silencieux);
    const t = getTrajet();
    /* On bascule sur l'onglet du trajet UNE SEULE FOIS, a l'ouverture du
       panneau. Auparavant cette ligne s'executait a chaque redessin, y
       compris apres un clic sur un autre onglet : impossible de consulter
       les stations pendant qu'on roule. */
    if (t && !panneauInitialise) ongletActif = 'trajet';
    panneauInitialise = true;

    const onglets = [
      { id: 'depart',  label: '🚲 Partir' },
      { id: 'trajet',  label: t ? '⏱️ En cours' : '⏱️ Trajet' },
      { id: 'arrivee', label: '📍 Arrivée' },
      { id: 'rdv',     label: '📅 RDV' },
      { id: 'points',  label: '🎁 Points' },
      { id: 'plus',    label: '⚙️ Plus' }
    ];

    zone.innerHTML = `
      <div style="display:flex;gap:5px;margin-bottom:14px;overflow-x:auto;padding-bottom:2px">
        ${onglets.map(o => `<button data-onglet="${o.id}" style="flex:1;white-space:nowrap;padding:8px 10px;border:none;border-radius:var(--radius-sm);font:inherit;font-size:12px;font-weight:600;cursor:pointer;
          background:${ongletActif === o.id ? 'var(--accent)' : 'var(--accent-1)'};color:${ongletActif === o.id ? '#fff' : 'var(--ink)'}">${o.label}</button>`).join('')}
      </div>
      <div id="velo-contenu"></div>
      <div style="margin-top:16px;font-size:10px;color:var(--ink-low);text-align:center">
        Source : ${esc(sourceActive)} · maj ${ilYA(cacheTime || Date.now())} · 466 stations
      </div>`;

    zone.querySelectorAll('[data-onglet]').forEach(b => {
      b.onclick = () => { Sons.clic(); ongletActif = b.dataset.onglet; dessinerPanneau(); };
    });

    const c = document.getElementById('velo-contenu');
    if (ongletActif === 'depart')  await vueDepart(c);
    if (ongletActif === 'trajet')  await vueTrajet(c);
    if (ongletActif === 'arrivee') await vueArrivee(c);
    if (ongletActif === 'rdv')     await vueRdv(c);
    if (ongletActif === 'points')  await vuePoints(c);
    if (ongletActif === 'plus')    vuePlus(c);
  }

  /* ---- Onglet 1 : où prendre un vélo ---- */
  async function vueDepart(c) {
    const conf = getConfig();
    c.innerHTML = `<div style="padding:20px 0;text-align:center;color:var(--ink-mid);font-size:13px">Recherche de ta position…</div>`;
    const p = await pointDeReference();
    let stations = await getStationsProches(p.lat, p.lon, 8, { pourPartir: true });
    await chargerAltitudes(await fetchStations());
    stations = trierUtiles(stations, 'partir').slice(0, 6);

    c.innerHTML = `
      ${bandeauCompteur()}
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:12px;cursor:pointer">
        <input type="checkbox" id="velo-elec" ${conf.elecSeulement ? 'checked' : ''}>
        <span>⚡ Stations avec vélo électrique seulement</span>
      </label>
      ${bandeauGeoloc(p)}
      ${stations.length ? stations.map(s => carteStation(s, 'partir')).join('')
        : `<div style="padding:20px 0;text-align:center;color:var(--ink-mid);font-size:13px">Aucune station avec vélo dans ${distanceText(RAYON_MAX)}.</div>`}
    `;

    brancherGeoloc();
    const el = document.getElementById('velo-elec');
    if (el) el.onchange = () => { setConfig({ elecSeulement: el.checked }); dessinerPanneau(); };

    c.querySelectorAll('[data-partir]').forEach(b => {
      b.onclick = () => {
        const st = stations.find(x => x.id === b.dataset.partir);
        if (!st) return;
        demarrerTrajet(st, destination);
        ongletActif = 'trajet';
        dessinerPanneau();
      };
    });
    brancherItineraires(c);
  }

  /* ---- Onglet 2 : le chronomètre ---- */
  async function vueTrajet(c) {
    const t = getTrajet();
    const conf = getConfig();

    if (!t) {
      const histo = lire(K_HISTO, []);
      const total = histo.reduce((a, h) => a + h.duree, 0);
      c.innerHTML = `
        <div style="text-align:center;padding:14px 0 18px">
          <div style="font-size:44px">🚲</div>
          <div style="font-size:13px;color:var(--ink-mid);margin-top:6px">Aucun trajet en cours</div>
          <div style="font-size:12px;color:var(--ink-low);margin-top:4px">Choisis une station dans « Partir » pour lancer le chrono.</div>
        </div>
        <button id="velo-start-libre" style="width:100%;padding:13px;border:none;border-radius:var(--radius-sm);background:var(--accent);color:#fff;font:inherit;font-size:14px;font-weight:700;cursor:pointer">
          ▶️ Démarrer sans choisir de station
        </button>
        ${histo.length ? `
          <div style="margin-top:22px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin-bottom:8px">
            Historique · ${histo.length} trajet${histo.length > 1 ? 's' : ''} · ${chrono(total)} · ${euros(histo.reduce((a, h) => a + (h.cout != null ? h.cout : coutTrajet(h.duree, h.gratuit)), 0))}
          </div>
          ${histo.slice(0, 10).map(h => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line);font-size:12px">
              <div style="min-width:0">
                <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(h.depart)} → ${esc(h.arrivee)}</div>
                <div style="font-size:10px;color:var(--ink-mid)">${new Date(h.debut).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
              </div>
              <div style="text-align:right;flex-shrink:0;margin-left:10px">
                <div style="font-family:var(--font-mono);font-weight:700;color:${h.depassement > 0 ? 'var(--accent-2)' : 'var(--accent-3)'}">${chrono(h.duree)}</div>
                <div style="font-size:9.5px;font-weight:700;color:${(h.cout != null ? h.cout : coutTrajet(h.duree, h.gratuit)) > 0 ? 'var(--accent-2)' : 'var(--accent-3)'}">${euros(h.cout != null ? h.cout : coutTrajet(h.duree, h.gratuit))}</div>
              </div>
            </div>`).join('')}
          <button id="velo-vider-histo" style="width:100%;margin-top:12px;padding:9px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;color:var(--ink-mid);font:inherit;font-size:12px;cursor:pointer">Vider l'historique</button>
        ` : ''}`;

      const b1 = document.getElementById('velo-start-libre');
      if (b1) b1.onclick = () => { demarrerTrajet(null, destination); dessinerPanneau(); };
      const b2 = document.getElementById('velo-vider-histo');
      if (b2) b2.onclick = () => { ecrire(K_HISTO, []); dessinerPanneau(); };
      return;
    }

    // Trajet en cours
    const sec = tempsEcoule();
    const gratuit = t.gratuit || conf.minutesGratuites;
    let blocArrivee = '';
    if (t.arrivee) {
      let proches = await getStationsProches(t.arrivee.lat, t.arrivee.lon, 8, { pourArriver: true, rayon: 700 });
      await chargerAltitudes(await fetchStations());
      proches = trierUtiles(proches, 'arriver').slice(0, 3);
      blocArrivee = `
        <div style="margin-top:20px">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin-bottom:8px">
            Places libres à l'arrivée · ${esc(t.arrivee.nom)}
          </div>
          ${proches.length ? proches.map(s => carteStation(s, 'arriver')).join('')
            : `<div style="font-size:12px;color:var(--ink-mid)">Aucune station à moins de 700 m.</div>`}
        </div>`;
    }

    const credit = getCredit();
    c.innerHTML = `
      ${bandeauCompteur()}
      <div style="text-align:center;background:var(--accent-1);border-radius:var(--radius);padding:20px 16px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid)">Temps d'utilisation</div>
        <div data-velo-chrono style="font-family:var(--font-mono);font-size:52px;font-weight:700;line-height:1.1;margin:6px 0">${chrono(sec)}</div>
        <div style="height:7px;background:rgba(0,0,0,.08);border-radius:999px;overflow:hidden;margin:10px 4px">
          <div data-velo-jauge style="height:100%;width:0%;border-radius:999px;transition:width .5s linear"></div>
        </div>
        <div data-velo-reste style="font-size:12px;margin-top:8px">—</div>
        <div style="display:flex;justify-content:center;align-items:baseline;gap:10px;margin-top:12px;
          background:rgba(0,0,0,.05);border-radius:var(--radius-sm);padding:9px 12px">
          <span data-velo-euros style="font-family:var(--font-mono);font-size:26px;font-weight:700">—</span>
          <span data-velo-prochain style="font-size:11px;color:var(--ink-mid)">—</span>
        </div>
        <div style="font-size:11px;color:var(--ink-mid);margin-top:10px">
          Départ ${new Date(t.debut).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
          ${t.depart ? ' · ' + esc(t.depart.nom) : ''}
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-top:14px">
        <button id="velo-stop" style="flex:2;padding:14px;border:none;border-radius:var(--radius-sm);background:var(--accent-2);color:#fff;font:inherit;font-size:14px;font-weight:700;cursor:pointer">🏁 Vélo reposé</button>
        <button id="velo-reset" style="flex:1;padding:14px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;font:inherit;font-size:12px;cursor:pointer">🔄 Relancer</button>
      </div>
      <div style="font-size:10px;color:var(--ink-low);margin-top:7px;line-height:1.5">
        « Relancer » = tu reposes le vélo puis tu en reprends un aussitôt : le compteur des ${gratuit} min repart à zéro,
        <strong>mais cela consomme un emprunt sur tes ${conf.maxEmprunts} de la journée</strong>.
      </div>
      ${credit > 0 ? `
        <button id="velo-use-credit" style="width:100%;margin-top:10px;padding:11px;border:none;border-radius:var(--radius-sm);
          background:var(--accent-4);color:#fff;font:inherit;font-size:13px;font-weight:700;cursor:pointer">
          ⛰️ Utiliser 15 min de crédit Bonus (${credit} min disponibles)
        </button>` : ''}
      ${blocArrivee}`;

    majAffichageChrono(sec);
    lancerHorloge();

    const bc = document.getElementById('velo-use-credit');
    if (bc) bc.onclick = () => {
      const tr = getTrajet();
      if (!tr) return;
      const pris = Math.min(15, getCredit());
      if (pris <= 0) return;
      tr.gratuit = (tr.gratuit || conf.minutesGratuites) + pris;
      tr.alertes = {};                 // les alertes se recalculent sur le nouveau seuil
      ecrire(K_TRAJET, tr);
      setCredit(getCredit() - pris);
      Sons.clic();
      notifier('⛰️ +' + pris + ' min — seuil porté à ' + tr.gratuit + ' min');
      dessinerPanneau();
    };
    document.getElementById('velo-stop').onclick = () => { arreterTrajet(); dessinerPanneau(); };
    document.getElementById('velo-reset').onclick = () => {
      const anc = getTrajet();
      arreterTrajet();
      setTimeout(() => {
        demarrerTrajet(anc && anc.depart ? { name: anc.depart.nom, lat: anc.depart.lat, lon: anc.depart.lon, id: anc.depart.id } : null,
                       anc ? anc.arrivee : null);
        dessinerPanneau();
      }, 400);
    };
    brancherItineraires(c);
  }

  /* ---- Onglet 3 : signalétique autour du point d'arrivée ---- */
  async function vueArrivee(c) {
    const favoris = getFavoris();
    c.innerHTML = `
      <div style="font-size:12px;color:var(--ink-mid);margin-bottom:10px;line-height:1.5">
        Indique où tu vas : je te montre toutes les stations autour, avec le nombre de places libres pour reposer le vélo.
      </div>
      <input id="velo-recherche" placeholder="Nom de station, rue, quartier…" autocomplete="off"
        style="width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:var(--radius-sm);font:inherit;font-size:14px;background:var(--bg-elev);color:var(--ink);box-sizing:border-box">
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
        <button data-dest="ici" style="padding:7px 12px;border:1px solid var(--line);border-radius:999px;background:none;font:inherit;font-size:12px;cursor:pointer">📍 Ma position</button>
        ${favoris.map(f => `<button data-fav="${esc(f.nom)}" style="padding:7px 12px;border:1px solid var(--line);border-radius:999px;background:none;font:inherit;font-size:12px;cursor:pointer">${esc(f.nom)}</button>`).join('')}
      </div>
      <div id="velo-resultats" style="margin-top:16px"></div>`;

    const input = document.getElementById('velo-recherche');
    const res = document.getElementById('velo-resultats');

    async function afficherAutour(nom, lat, lon) {
      destination = { nom: nom, lat: lat, lon: lon };
      res.innerHTML = `<div style="padding:16px 0;text-align:center;color:var(--ink-mid);font-size:13px">Recherche…</div>`;
      let stations = await getStationsProches(lat, lon, 10, { pourArriver: true, rayon: 900 });
      await chargerAltitudes(await fetchStations());
      stations = trierUtiles(stations, 'arriver').slice(0, 6);
      const t = getTrajet();
      res.innerHTML = `
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin-bottom:9px">
          Autour de ${esc(nom)}
        </div>
        ${stations.length ? stations.map(s => carteStation(s, 'arriver')).join('')
          : `<div style="font-size:13px;color:var(--ink-mid);padding:14px 0">Aucune station à moins de 900 m.</div>`}
        <div style="display:flex;gap:8px;margin-top:14px">
          <button id="velo-def-dest" style="flex:1;padding:11px;border:none;border-radius:var(--radius-sm);background:var(--accent);color:#fff;font:inherit;font-size:13px;font-weight:600;cursor:pointer">
            ${t ? '🎯 Définir comme arrivée du trajet' : '🎯 Mémoriser pour le prochain trajet'}
          </button>
          <button id="velo-add-fav" style="padding:11px 14px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;font:inherit;font-size:13px;cursor:pointer">⭐</button>
        </div>`;

      document.getElementById('velo-def-dest').onclick = () => {
        const tr = getTrajet();
        if (tr) { tr.arrivee = { nom: nom, lat: lat, lon: lon }; tr.alertes.pleine = false; ecrire(K_TRAJET, tr); }
        Sons.clic();
        notifier('🎯 Arrivée : ' + nom);
        rafraichirTuile();
      };
      document.getElementById('velo-add-fav').onclick = () => {
        const n = prompt('Nom du favori :', nom);
        if (n) { ajouterFavori(n, lat, lon); notifier('⭐ Favori enregistré'); dessinerPanneau(); }
      };
      brancherItineraires(res);
    }

    // Recherche parmi les 466 stations (nom + adresse)
    let minuteur = null;
    input.oninput = () => {
      clearTimeout(minuteur);
      minuteur = setTimeout(async () => {
        const q = input.value.trim().toLowerCase();
        if (q.length < 2) { res.innerHTML = ''; return; }
        const stations = await fetchStations();
        const trouves = stations.filter(s =>
          s.name.toLowerCase().includes(q) || (s.address || '').toLowerCase().includes(q)
        ).slice(0, 8);
        if (!trouves.length) {
          res.innerHTML = `<div style="font-size:13px;color:var(--ink-mid);padding:14px 0">Rien trouvé pour « ${esc(input.value)} ».</div>`;
          return;
        }
        res.innerHTML = trouves.map(s => `
          <button data-choix="${esc(s.id)}" style="display:block;width:100%;text-align:left;padding:10px 12px;margin-bottom:6px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--bg-elev);font:inherit;cursor:pointer">
            <div style="font-size:13px;font-weight:600">${esc(s.name)}</div>
            <div style="font-size:11px;color:var(--ink-mid)">${esc(s.address || '')}</div>
          </button>`).join('');
        res.querySelectorAll('[data-choix]').forEach(b => {
          b.onclick = () => {
            const s = trouves.find(x => String(x.id) === b.dataset.choix);
            if (s) { input.value = s.name; afficherAutour(s.name, s.lat, s.lon); }
          };
        });
      }, 250);
    };

    c.querySelectorAll('[data-fav]').forEach(b => {
      b.onclick = () => {
        const f = getFavoris().find(x => x.nom === b.dataset.fav);
        if (f) { input.value = f.nom; afficherAutour(f.nom, f.lat, f.lon); }
      };
    });
    const btnIci = c.querySelector('[data-dest="ici"]');
    if (btnIci) btnIci.onclick = async () => {
      btnIci.textContent = '📍 Localisation…';
      const p = await pointDeReference();
      btnIci.textContent = '📍 Ma position';
      afficherAutour(p.manuel || p.approx ? (p.nom || 'mon point de repère') : p.ancienne ? 'ma dernière position connue' : 'ma position', p.lat, p.lon);
    };
  }

  /* ---- Onglet 4 : les rendez-vous de l'agenda ----
     Pour chaque rendez-vous ayant une adresse, on cherche la station de
     départ près de toi, la station d'arrivée près du lieu, et on en déduit
     l'heure à laquelle il faut sortir de chez soi. */
  async function vueRdv(c) {
    c.innerHTML = `<div style="padding:22px 0;text-align:center;color:var(--ink-mid);font-size:13px">Lecture de ton agenda…</div>`;

    const evts = evenementsAvecLieu(7);
    if (!evts.length) {
      const total = (window.state && window.state.events) ? window.state.events.length : 0;
      c.innerHTML = `
        <div style="text-align:center;padding:22px 0">
          <div style="font-size:42px">📅</div>
          <div style="font-size:13px;color:var(--ink-mid);margin-top:8px">
            ${total ? 'Aucun rendez-vous avec une adresse dans les 7 prochains jours.'
                    : 'Aucun rendez-vous trouvé dans ton agenda.'}
          </div>
          <div style="font-size:11.5px;color:var(--ink-low);line-height:1.6;margin-top:10px;padding:0 6px">
            Seuls les rendez-vous dont le champ <strong>lieu</strong> est rempli apparaissent ici.
            ${total ? 'Ajoute une adresse à tes rendez-vous dans la tuile Agenda.'
                    : 'Ouvre la tuile Agenda et lance la synchronisation Google.'}
          </div>
        </div>`;
      return;
    }

    const p = await pointDeReference();
    const depart = (await getStationsProches(p.lat, p.lon, 1, { pourPartir: true }))[0];

    const morceaux = [];
    for (const e of evts.slice(0, 6)) {
      const lieu = await geocoder(e.lieu);
      const jour = e.quand.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
      const heure = e.quand.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

      if (!lieu) {
        morceaux.push(`
          <div style="border:1px solid var(--line);border-radius:var(--radius-sm);padding:12px;margin-bottom:9px;background:var(--bg-elev)">
            <div style="font-size:13.5px;font-weight:600">${esc(e.title)}</div>
            <div style="font-size:11px;color:var(--ink-mid);margin-top:2px">${jour} · ${heure}</div>
            <div style="font-size:11px;color:var(--accent-2);margin-top:6px">📍 Adresse non reconnue : ${esc(e.lieu)}</div>
          </div>`);
        continue;
      }

      const arrivee = (await getStationsProches(lieu.lat, lieu.lon, 1, { pourArriver: true, rayon: 900 }))[0];
      if (!arrivee || !depart) {
        morceaux.push(`
          <div style="border:1px solid var(--line);border-radius:var(--radius-sm);padding:12px;margin-bottom:9px;background:var(--bg-elev)">
            <div style="font-size:13.5px;font-weight:600">${esc(e.title)}</div>
            <div style="font-size:11px;color:var(--ink-mid);margin-top:2px">${jour} · ${heure} · ${esc(lieu.nom)}</div>
            <div style="font-size:11px;color:var(--ink-mid);margin-top:6px">🚫 Aucune station à moins de 900 m du lieu — le vélo n'est pas adapté.</div>
          </div>`);
        continue;
      }

      /* Distances reelles plutot qu'a vol d'oiseau : les rues ne vont pas
         tout droit, et l'ecart atteint 10 a 20 %. Sur une heure de depart,
         ca fait la difference entre a l'heure et en retard. */
      const t = calculerDepart(e, depart, arrivee, p);
      try {
        const [rm, rv, ra] = await Promise.all([
          itineraireReel(p.lat, p.lon, depart.lat, depart.lon, 'foot'),
          itineraireReel(depart.lat, depart.lon, arrivee.lat, arrivee.lon, 'bike'),
          itineraireReel(arrivee.lat, arrivee.lon, lieu.lat, lieu.lon, 'foot')
        ]);
        if (rm) t.mDepart = rm.minutes;
        if (rv) t.mVelo = rv.minutes;
        if (ra) t.mArrivee = ra.minutes;
        if (rm || rv || ra) {
          t.reel = true;
          t.total = t.mDepart + t.mVelo + t.mArrivee + 5;
          t.partirA = new Date(e.quand.getTime() - t.total * 60000);
          t.retard = t.partirA < new Date();
        }
      } catch (err) {}
      const partir = t.partirA.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const memeJour = t.partirA.toDateString() === new Date().toDateString();
      const urgent = memeJour && (t.partirA - new Date()) < 20 * 60000 && t.partirA > new Date();

      morceaux.push(`
        <div style="border:1px solid var(--line);border-left:4px solid ${t.retard ? 'var(--accent-2)' : urgent ? 'var(--accent-4)' : 'var(--accent-3)'};
          border-radius:var(--radius-sm);padding:12px;margin-bottom:10px;background:var(--bg-elev)">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
            <div style="min-width:0;flex:1">
              <div style="font-size:13.5px;font-weight:600;line-height:1.3">${esc(e.title)}</div>
              <div style="font-size:11px;color:var(--ink-mid);margin-top:2px">${jour} à ${heure}</div>
              <div style="font-size:11px;color:var(--ink-mid)">📍 ${esc(lieu.nom)}</div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-size:10px;color:var(--ink-mid)">Partir à</div>
              <div style="font-family:var(--font-mono);font-size:20px;font-weight:700;
                color:${t.retard ? 'var(--accent-2)' : urgent ? 'var(--accent-4)' : 'var(--accent-3)'}">${partir}</div>
            </div>
          </div>

          <div style="display:flex;align-items:center;gap:6px;margin-top:11px;font-size:10.5px;color:var(--ink-mid);flex-wrap:wrap">
            <span>🚶 ${t.mDepart} min</span><span>→</span>
            <span style="font-weight:600;color:var(--ink)">${esc(depart.name)}</span><span>→</span>
            <span>🚲 ${t.mVelo} min</span><span>→</span>
            <span style="font-weight:600;color:var(--ink)">${esc(arrivee.name)}</span><span>→</span>
            <span>🚶 ${t.mArrivee} min</span>
          </div>

          <div style="display:flex;justify-content:space-between;font-size:10.5px;margin-top:7px;
            padding-top:7px;border-top:1px solid var(--line)">
            <span style="color:${depart.availableBikes > 0 ? 'var(--accent-3)' : 'var(--accent-2)'}">
              Départ : ${depart.availableBikes} vélo${depart.availableBikes > 1 ? 's' : ''}</span>
            <span style="color:${arrivee.availableDocks > 0 ? 'var(--accent-3)' : 'var(--accent-2)'}">
              Arrivée : ${arrivee.availableDocks} place${arrivee.availableDocks > 1 ? 's' : ''}</span>
            <span>Total ${t.total} min${t.reel ? ' 🗺️' : ''}</span>
          </div>

          ${t.retard ? `<div style="font-size:11px;color:var(--accent-2);font-weight:600;margin-top:7px">⚠️ L'heure de départ est déjà passée</div>` : ''}

          <div style="display:flex;gap:7px;margin-top:10px">
            <button data-rdv-go="${esc(e.id)}" data-lat="${arrivee.lat}" data-lon="${arrivee.lon}" data-nom="${esc(arrivee.name)}"
              style="flex:2;padding:9px;border:none;border-radius:var(--radius-sm);background:var(--accent);color:#fff;
              font:inherit;font-size:12px;font-weight:700;cursor:pointer">▶️ Je pars pour ce RDV</button>
            <button data-itin="${arrivee.lat},${arrivee.lon}" data-itin-nom="${esc(arrivee.name)}"
              style="flex:1;padding:9px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;font:inherit;font-size:12px;cursor:pointer">🧭 Y aller</button>
          </div>
        </div>`);
    }

    c.innerHTML = `
      <div style="font-size:11.5px;color:var(--ink-mid);line-height:1.6;margin-bottom:12px">
        Tes rendez-vous des 7 prochains jours qui ont une adresse. Adresses et
        itinéraires viennent d'OpenStreetMap : les durées 🗺️ suivent les rues réelles,
        pas la ligne droite. L'heure de départ inclut la marche, le vélo et 5 minutes
        pour prendre et reposer.
      </div>
      ${morceaux.join('')}`;

    c.querySelectorAll('[data-rdv-go]').forEach(b => {
      b.onclick = () => {
        destination = {
          nom: b.dataset.nom,
          lat: parseFloat(b.dataset.lat),
          lon: parseFloat(b.dataset.lon)
        };
        demarrerTrajet(depart, destination);
        ongletActif = 'trajet';
        dessinerPanneau();
      };
    });
    brancherItineraires(c);
  }

  /* ---- Onglet 5 : les gestes qui rapportent des points ----
     Deux colonnes de sens contraire :
       - stations SATUREES autour de toi  -> y prendre un vélo rend service
       - stations A SEC autour de toi     -> y déposer un vélo rend service
     Plus les stations Bonus (+15 min) repérées dans le secteur.
  */
  async function vuePoints(c) {
    c.innerHTML = `<div style="padding:22px 0;text-align:center;color:var(--ink-mid);font-size:13px">Analyse du réseau autour de toi…</div>`;

    const p = await pointDeReference();
    const toutes = await fetchStations();
    await chargerAltitudes(toutes);

    const rayon = 2000;
    const autour = toutes
      .map(x => Object.assign({}, x, { dist: distance(p.lat, p.lon, x.lat, x.lon) }))
      .filter(x => x.dist < rayon && x.ouverte !== false);

    const aPrendre = autour.filter(x => x.retrait !== false && x.availableBikes > 0 && utiliteReseau(x, 'partir'))
      .sort((a, b) => a.availableDocks - b.availableDocks || a.dist - b.dist).slice(0, 5);
    const aDeposer = autour.filter(x => x.depot !== false && x.availableDocks > 0 && utiliteReseau(x, 'arriver'))
      .sort((a, b) => a.availableBikes - b.availableBikes || a.dist - b.dist).slice(0, 5);
    const bonusProches = autour.filter(x => estBonus(x) && x.depot !== false)
      .sort((a, b) => a.dist - b.dist).slice(0, 4);

    const mini = (s, mode) => {
      const chiffre = mode === 'partir' ? s.availableDocks : s.availableBikes;
      const critique = chiffre === 0;
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 0;border-bottom:1px solid var(--line)">
          <div style="min-width:0;flex:1">
            <div style="font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.name)}${estBonus(s) ? ' ⛰️' : ''}</div>
            <div style="font-size:10px;color:var(--ink-mid)">🚶 ${walkMinutes(s.dist)} min · ${distanceText(s.dist)} · ${mode === 'partir' ? s.availableBikes + ' vélos dispo' : s.availableDocks + ' places libres'}</div>
          </div>
          <div style="text-align:center;flex-shrink:0">
            <div style="font-family:var(--font-mono);font-size:19px;font-weight:700;color:${critique ? 'var(--accent-3)' : 'var(--accent-4)'}">${chiffre}</div>
            <div style="font-size:9px;color:var(--ink-mid)">${mode === 'partir' ? 'places' : 'vélos'}</div>
          </div>
          <button data-itin="${s.lat},${s.lon}" data-itin-nom="${esc(s.name)}" style="padding:8px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;font:inherit;font-size:12px;cursor:pointer">🧭</button>
        </div>`;
    };

    c.innerHTML = `
      ${bandeauCompteur()}
      <div style="font-size:11.5px;color:var(--ink-mid);line-height:1.6;margin-bottom:16px">
        Le programme de fidélité récompense les actions qui rééquilibrent le réseau.
        Voici, dans un rayon de 2 km, les stations où ton geste compte le plus.
      </div>

      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin-bottom:2px">
        🔴 Y prendre un vélo — stations saturées
      </div>
      <div style="font-size:10.5px;color:var(--ink-low);margin-bottom:6px">Plus aucune place libre : chaque vélo retiré débloque une borne.</div>
      ${aPrendre.length ? aPrendre.map(x => mini(x, 'partir')).join('')
        : `<div style="font-size:12px;color:var(--ink-mid);padding:8px 0">Aucune station saturée dans le secteur. Le réseau respire.</div>`}

      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin:22px 0 2px">
        🟢 Y déposer un vélo — stations à sec
      </div>
      <div style="font-size:10.5px;color:var(--ink-low);margin-bottom:6px">Plus aucun vélo : y ramener le tien dépanne tout le quartier.</div>
      ${aDeposer.length ? aDeposer.map(x => mini(x, 'arriver')).join('')
        : `<div style="font-size:12px;color:var(--ink-mid);padding:8px 0">Aucune station vide dans le secteur.</div>`}

      ${bonusProches.length ? `
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin:22px 0 2px">
          ⛰️ Stations Bonus repérées — +15 min
        </div>
        <div style="font-size:10.5px;color:var(--ink-low);margin-bottom:6px">
          Y ramener le vélo crédite 15 min, cumulables jusqu'à 2 h. Vérifie le logo sur la borne.
        </div>
        ${bonusProches.map(x => mini(x, 'arriver')).join('')}` : ''}

      <div style="margin-top:22px;padding:12px;background:var(--accent-1);border-radius:var(--radius-sm);font-size:11px;line-height:1.6;color:var(--ink-mid)">
        Le barème exact des points n'est pas publié par l'exploitant : Mon Bureau te montre
        <strong>où l'action est utile</strong>, pas combien elle rapporte. Le décompte officiel
        reste celui de ton compte vélôToulouse.
      </div>`;

    brancherItineraires(c);
  }

  /* ---- Onglet 5 : réglages ---- */
  function vuePlus(c) {
    const conf = getConfig();
    const favoris = getFavoris();
    const ligne = (id, label, actif, aide) => `
      <label style="display:flex;align-items:flex-start;gap:10px;padding:11px 0;border-bottom:1px solid var(--line);cursor:pointer">
        <input type="checkbox" data-conf="${id}" ${actif ? 'checked' : ''} style="margin-top:3px">
        <span><span style="font-size:13px">${label}</span>
        ${aide ? `<span style="display:block;font-size:11px;color:var(--ink-mid);margin-top:2px">${aide}</span>` : ''}</span>
      </label>`;

    c.innerHTML = `
      ${blocVersion()}

      ${blocDomicile()}

      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin-bottom:4px">Temps inclus</div>
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)">
        <input type="number" id="velo-gratuit" value="${conf.minutesGratuites}" min="5" max="120" step="5"
          style="width:80px;padding:9px;border:1px solid var(--line);border-radius:var(--radius-sm);font:inherit;font-family:var(--font-mono);text-align:center;background:var(--bg-elev);color:var(--ink)">
        <span style="font-size:12px;color:var(--ink-mid)">minutes incluses avant facturation</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)">
        <input type="number" id="velo-avant" value="${conf.alerteAvant}" min="1" max="20"
          style="width:80px;padding:9px;border:1px solid var(--line);border-radius:var(--radius-sm);font:inherit;font-family:var(--font-mono);text-align:center;background:var(--bg-elev);color:var(--ink)">
        <span style="font-size:12px;color:var(--ink-mid)">minutes avant la fin → premier bip</span>
      </div>

      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)">
        <input type="number" id="velo-max" value="${conf.maxEmprunts}" min="1" max="30"
          style="width:80px;padding:9px;border:1px solid var(--line);border-radius:var(--radius-sm);font:inherit;font-family:var(--font-mono);text-align:center;background:var(--bg-elev);color:var(--ink)">
        <span style="font-size:12px;color:var(--ink-mid)">emprunts maximum par jour</span>
      </div>

      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin:18px 0 4px">Clé JCDecaux</div>
      <div style="font-size:11px;color:var(--ink-mid);line-height:1.6;margin-bottom:6px">
        Facultative. Elle ajoute le numéro inscrit sur la borne et le repérage des terminaux carte bancaire.
        Celle qui est pré-remplie est la clé publique du site officiel : elle peut cesser de fonctionner
        du jour au lendemain. Tu peux créer la tienne, gratuitement, sur developer.jcdecaux.com.
        Champ vide = enrichissement désactivé, le reste continue de marcher.
      </div>
      <input type="text" id="velo-cle" value="${esc(conf.cleJCDecaux || '')}" placeholder="Aucune clé"
        style="width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:var(--radius-sm);font:inherit;
        font-family:var(--font-mono);font-size:11px;background:var(--bg-elev);color:var(--ink);box-sizing:border-box">

      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin:18px 0 4px">🧭 Navigation</div>
      <div style="font-size:11px;color:var(--ink-mid);line-height:1.6;margin-bottom:7px">
        Ce qui s'ouvre quand tu appuies sur « Y aller ».
      </div>
      <div style="display:flex;gap:6px;margin-bottom:4px">
        ${[['osm', '🗺️ OpenStreetMap'], ['geo', '📱 Appli du tél.'], ['google', '🔵 Google Maps']].map(([v, l]) => `
          <button data-nav="${v}" style="flex:1;padding:9px 6px;border:none;border-radius:var(--radius-sm);font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;
            background:${conf.navigation === v ? 'var(--accent)' : 'var(--accent-1)'};color:${conf.navigation === v ? '#fff' : 'var(--ink)'}">${l}</button>`).join('')}
      </div>
      <div style="font-size:10.5px;color:var(--ink-low);line-height:1.5;margin-bottom:4px">
        « Appli du tél. » laisse Android proposer les applications de navigation que tu as installées.
      </div>

      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin:18px 0 4px">🔊 Annonces vocales</div>
      ${ligne('voix', '🗣️ Parler à voix haute', conf.voix, 'Départ, seuils de temps, facturation, station qui se remplit.')}
      ${ligne('guidage', '🧭 Guidage tournant par tournant', conf.guidage, 'Annonce les virages vers la station d\'arrivée, calculés par OpenStreetMap.')}
      <button id="velo-test-voix" style="width:100%;margin-top:8px;padding:10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;font:inherit;font-size:12px;cursor:pointer">🔊 Tester la voix</button>

      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin:18px 0 4px">Tarif</div>
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)">
        <input type="number" id="velo-tarif" value="${conf.tarifTranche}" min="0" max="20" step="0.5"
          style="width:80px;padding:9px;border:1px solid var(--line);border-radius:var(--radius-sm);font:inherit;font-family:var(--font-mono);text-align:center;background:var(--bg-elev);color:var(--ink)">
        <span style="font-size:12px;color:var(--ink-mid)">€ par demi-heure entamée au-delà des ${conf.minutesGratuites} min</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)">
        <input type="number" id="velo-tarif-supp" value="${conf.tarifEmpruntSupp}" min="0" max="20" step="0.5"
          style="width:80px;padding:9px;border:1px solid var(--line);border-radius:var(--radius-sm);font:inherit;font-family:var(--font-mono);text-align:center;background:var(--bg-elev);color:var(--ink)">
        <span style="font-size:12px;color:var(--ink-mid)">€ par emprunt au-delà du ${conf.maxEmprunts}ᵉ de la journée</span>
      </div>

      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin:18px 0 4px">Points de fidélité</div>
      <div style="font-size:11px;color:var(--ink-mid);line-height:1.6;margin-bottom:6px">
        Le réseau récompense les gestes qui le rééquilibrent : prendre un vélo dans une station saturée,
        en déposer un dans une station à sec. Ces seuils décident du badge 🎁.
      </div>
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)">
        <input type="number" id="velo-svide" value="${conf.seuilVide}" min="0" max="6"
          style="width:80px;padding:9px;border:1px solid var(--line);border-radius:var(--radius-sm);font:inherit;font-family:var(--font-mono);text-align:center;background:var(--bg-elev);color:var(--ink)">
        <span style="font-size:12px;color:var(--ink-mid)">vélos restants max → « déposer ici aide »</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)">
        <input type="number" id="velo-spleine" value="${conf.seuilPleine}" min="0" max="6"
          style="width:80px;padding:9px;border:1px solid var(--line);border-radius:var(--radius-sm);font:inherit;font-family:var(--font-mono);text-align:center;background:var(--bg-elev);color:var(--ink)">
        <span style="font-size:12px;color:var(--ink-mid)">places restantes max → « prendre ici aide »</span>
      </div>
      ${ligne('prioriserUtiles', '🎁 Remonter les stations utiles en tête de liste', conf.prioriserUtiles, 'Sinon, tri uniquement par distance.')}

      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin:18px 0 4px">Stations Bonus (+15 min)</div>
      <div style="font-size:11px;color:var(--ink-mid);line-height:1.6;margin-bottom:6px">
        Vérification faite auprès de l'API officielle : aucune station de Toulouse ne porte actuellement
        le drapeau Bonus (0 sur 441). Le programme des 15 minutes offertes semble suspendu.
        La devinette par altitude est donc désactivée — mets une valeur au-dessus de zéro pour la réveiller.
        Si tu vois un logo Bonus sur une borne, le bouton ⛰️ te permet de la marquer toi-même,
        et ta marque est gardée définitivement.
      </div>
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)">
        <input type="number" id="velo-alt" value="${conf.altitudeBonus}" min="120" max="250" step="5"
          style="width:80px;padding:9px;border:1px solid var(--line);border-radius:var(--radius-sm);font:inherit;font-family:var(--font-mono);text-align:center;background:var(--bg-elev);color:var(--ink)">
        <span style="font-size:12px;color:var(--ink-mid)">mètres d'altitude → station supposée Bonus (0 = désactivé)</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)">
        <input type="number" id="velo-credit" value="${getCredit()}" min="0" max="120" step="15"
          style="width:80px;padding:9px;border:1px solid var(--line);border-radius:var(--radius-sm);font:inherit;font-family:var(--font-mono);text-align:center;background:var(--bg-elev);color:var(--ink)">
        <span style="font-size:12px;color:var(--ink-mid)">minutes de crédit Bonus en réserve (max 120)</span>
      </div>

      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin:18px 0 2px">Alertes</div>
      ${ligne('son', '🔔 Bips sonores', conf.son, 'Départ, avertissement, dépassement, arrivée.')}
      ${ligne('vibration', '📳 Vibration', conf.vibration, 'Utile quand le téléphone est dans la poche.')}
      ${ligne('notification', '📲 Notifications système', conf.notification, 'Elles apparaissent même si Mon Bureau est fermé.')}
      ${ligne('elecSeulement', '⚡ Vélos électriques seulement', conf.elecSeulement, 'Filtre appliqué aux stations de départ.')}

      <div style="display:flex;gap:8px;margin-top:14px">
        <button id="velo-test-son" style="flex:1;padding:10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;font:inherit;font-size:12px;cursor:pointer">🔊 Tester les bips</button>
        <button id="velo-test-notif" style="flex:1;padding:10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;font:inherit;font-size:12px;cursor:pointer">📲 Autoriser notifs</button>
      </div>

      ${blocBulle()}

      ${blocDiagnosticGeo()}

      ${blocAndroid()}

      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin:20px 0 6px">Favoris</div>
      ${favoris.map(f => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--line);font-size:13px">
          <span>${esc(f.nom)}</span>
          <button data-delfav="${esc(f.nom)}" style="border:none;background:none;color:var(--accent-2);font-size:15px;cursor:pointer">✕</button>
        </div>`).join('')}
      <button id="velo-fav-ici" style="width:100%;margin-top:10px;padding:10px;border:1px dashed var(--line);border-radius:var(--radius-sm);background:none;font:inherit;font-size:12px;cursor:pointer">＋ Enregistrer ma position actuelle</button>

      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin:20px 0 6px">Remise à zéro</div>
      <div style="display:flex;gap:8px">
        <button id="velo-reset-jour" style="flex:1;padding:10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;font:inherit;font-size:12px;cursor:pointer">↺ Compteur du jour (${compteurJour().n})</button>
        <button id="velo-reset-bonus" style="flex:1;padding:10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;font:inherit;font-size:12px;cursor:pointer">↺ Marquages ⛰️ manuels</button>
      </div>

      <div style="margin-top:20px;padding:12px;background:var(--accent-1);border-radius:var(--radius-sm);font-size:11px;line-height:1.6;color:var(--ink-mid)">
        Données temps réel VélôToulouse (JCDecaux), rafraîchies chaque minute.
        Le chronomètre est une aide personnelle : il ne communique pas avec ta borne,
        c'est toi qui le démarres et l'arrêtes.
      </div>`;

    c.querySelectorAll('[data-conf]').forEach(i => {
      i.onchange = () => {
        const patch = {}; patch[i.dataset.conf] = i.checked;
        setConfig(patch);
        if (i.dataset.conf === 'notification' && i.checked) demanderNotifications();
        if (i.dataset.conf === 'positionManuelle') {
          dernierePosition = null; derniereErreurGeo = null;
          notifier(i.checked ? '📌 Position fixe activée' : '📍 Recherche GPS réactivée');
          dessinerPanneau(); rafraichirTuile();
        }
      };
    });
    document.getElementById('velo-gratuit').onchange = e => setConfig({ minutesGratuites: Math.max(5, parseInt(e.target.value, 10) || 30) });
    document.getElementById('velo-avant').onchange   = e => setConfig({ alerteAvant: Math.max(1, parseInt(e.target.value, 10) || 5) });
    document.getElementById('velo-max').onchange     = e => setConfig({ maxEmprunts: Math.max(1, parseInt(e.target.value, 10) || 7) });
    document.getElementById('velo-svide').onchange   = e => setConfig({ seuilVide: Math.max(0, parseInt(e.target.value, 10) || 0) });
    document.getElementById('velo-spleine').onchange = e => setConfig({ seuilPleine: Math.max(0, parseInt(e.target.value, 10) || 0) });
    document.getElementById('velo-cle').onchange = e => { setConfig({ cleJCDecaux: e.target.value.trim() }); v3Cache = null; fetchStations(true); };
    const tv = document.getElementById('velo-test-voix');
    if (tv) tv.onclick = () => {
      if (!window.speechSynthesis) { notifier('🔇 Voix non disponible sur cet appareil'); return; }
      parler('Dans 100 mètres, tourne à droite sur la route d\'Espagne. Station Espagne Langlade, 7 places libres.', true);
    };
    c.querySelectorAll('[data-nav]').forEach(b => {
      b.onclick = () => { setConfig({ navigation: b.dataset.nav }); Sons.clic(); dessinerPanneau(); };
    });
    document.getElementById('velo-tarif').onchange      = e => setConfig({ tarifTranche: Math.max(0, parseFloat(e.target.value) || 0) });
    document.getElementById('velo-tarif-supp').onchange = e => setConfig({ tarifEmpruntSupp: Math.max(0, parseFloat(e.target.value) || 0) });
    document.getElementById('velo-alt').onchange     = e => { setConfig({ altitudeBonus: Math.max(120, parseInt(e.target.value, 10) || 155) }); dessinerPanneau(); };
    document.getElementById('velo-credit').onchange  = e => { setCredit(parseInt(e.target.value, 10) || 0); dessinerPanneau(); };
    document.getElementById('velo-test-son').onclick = () => { Sons.depart(); setTimeout(Sons.avertir, 900); setTimeout(Sons.alerte, 2000); };
    document.getElementById('velo-test-notif').onclick = () => {
      demanderNotifications();
      setTimeout(() => pousserNotif('VélôToulouse', 'Les notifications fonctionnent 👍'), 800);
    };
    c.querySelectorAll('[data-delfav]').forEach(b => {
      b.onclick = () => { supprimerFavori(b.dataset.delfav); dessinerPanneau(); };
    });
    brancherVersion();
    brancherBulle();
    brancherDomicile();
    brancherAndroid();
    brancherDiagnosticGeo();
    document.getElementById('velo-reset-jour').onclick = () => { ecrire(K_JOUR, { date: aujourdhui(), n: 0 }); dessinerPanneau(); rafraichirTuile(); };
    document.getElementById('velo-reset-bonus').onclick = () => { ecrire(K_BONUS, {}); notifier('⛰️ Marquages effacés'); dessinerPanneau(); };
    document.getElementById('velo-fav-ici').onclick = async () => {
      const p = await maPosition(9000);
      if (!p) { notifier('📍 Position indisponible'); return; }
      const n = prompt('Nom du favori :', 'Travail');
      if (n) { ajouterFavori(n, p.lat, p.lon); dessinerPanneau(); }
    };
  }

  /* ---- Identite de la copie affichee : version, appareil, mise a jour ---- */
  function appareil() {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone / iPad';
    if (/Android/i.test(ua)) return 'Android';
    return 'Ordinateur';
  }

  function blocVersion() {
    const dansAppli = pontDispo();
    const surAndroid = /Android/i.test(navigator.userAgent || '');
    const ligne = (label, valeur, coul) => `
      <div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid var(--line);font-size:12px">
        <span>${label}</span><span style="font-weight:600;text-align:right;color:${coul || 'var(--ink)'}">${valeur}</span>
      </div>`;

    let conseil = '';
    if (surAndroid && !dansAppli) {
      conseil = `<div style="font-size:11px;color:var(--ink-mid);line-height:1.6;margin-top:8px">
        Tu es sur Android mais le pont de l'application n'est pas là : soit tu navigues dans Chrome,
        soit l'application installée n'a pas encore reçu la mise à jour Android.
        Dans les deux cas le GPS passe par le navigateur, qui doit t'avoir demandé l'autorisation.</div>`;
    }

    return `
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin-bottom:6px">🧾 Cette copie</div>
      ${ligne('Version de la tuile', 'v' + VERSION, 'var(--accent)')}
      ${ligne('Appareil', appareil())}
      ${ligne('Application Mon Bureau', dansAppli ? 'oui' : 'non', dansAppli ? 'var(--accent-3)' : 'var(--ink-mid)')}
      <div style="font-size:11px;color:var(--ink-mid);line-height:1.6;margin-top:8px">
        Compare la version entre ton ordinateur et ton téléphone. Si elles diffèrent,
        l'un des deux affiche une ancienne copie gardée en mémoire.
      </div>
      ${conseil}
      <button id="velo-maj" style="width:100%;margin-top:9px;padding:11px;border:none;border-radius:var(--radius-sm);
        background:var(--accent);color:#fff;font:inherit;font-size:13px;font-weight:700;cursor:pointer">🔄 Forcer la mise à jour</button>
      <div style="font-size:10.5px;color:var(--ink-low);line-height:1.5;margin-top:5px">
        Vide la mémoire du site et recharge tout depuis GitHub. À faire sur le téléphone si sa version est plus ancienne.
      </div>`;
  }

  function brancherVersion() {
    const b = document.getElementById('velo-maj');
    if (!b) return;
    b.onclick = async () => {
      b.disabled = true; b.textContent = '🔄 Nettoyage…';
      try {
        // 1. On retire le service worker, qui sert les copies en cache
        if (navigator.serviceWorker) {
          const regs = await navigator.serviceWorker.getRegistrations();
          for (const r of regs) { try { await r.unregister(); } catch (e) {} }
        }
        // 2. On vide tous les caches du site
        if (window.caches) {
          const noms = await caches.keys();
          for (const n of noms) { try { await caches.delete(n); } catch (e) {} }
        }
      } catch (e) {
        console.warn('[Vélô] nettoyage partiel :', e.message);
      }
      b.textContent = '🔄 Rechargement…';
      // 3. Rechargement en contournant le cache du navigateur
      const u = new URL(window.location.href);
      u.searchParams.set('maj', Date.now());
      window.location.replace(u.toString());
    };
  }

  /* ---- Point de repère : l'adresse utilisée quand le GPS ne répond pas ---- */
  function blocDomicile() {
    const d = getDomicile();
    const conf = getConfig();
    return `
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin-bottom:6px">📌 Mon point de repère</div>
      <div style="background:var(--accent-1);border-radius:var(--radius-sm);padding:11px 13px">
        <div style="font-size:13px;font-weight:600;line-height:1.4">${esc(d.nom)}</div>
        <div style="font-size:10.5px;color:var(--ink-mid);font-family:var(--font-mono);margin-top:3px">${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}</div>
      </div>
      <div style="font-size:11px;color:var(--ink-mid);line-height:1.6;margin:8px 0 6px">
        C'est l'adresse utilisée quand la position ne peut pas être mesurée. Tape une adresse, ou capture ta position actuelle.
      </div>
      <input id="velo-adr" placeholder="12 rue de la Pomme, Toulouse" autocomplete="off"
        style="width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:var(--radius-sm);font:inherit;font-size:13px;background:var(--bg-elev);color:var(--ink);box-sizing:border-box">
      <div id="velo-adr-res" style="margin-top:6px"></div>
      <button id="velo-adr-ici" style="width:100%;margin-top:8px;padding:10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;font:inherit;font-size:12.5px;cursor:pointer">📍 Capturer ma position actuelle</button>

      <label style="display:flex;align-items:flex-start;gap:10px;padding:12px 0 4px;cursor:pointer">
        <input type="checkbox" data-conf="positionManuelle" ${conf.positionManuelle ? 'checked' : ''} style="margin-top:3px">
        <span><span style="font-size:13px">📌 Toujours utiliser ce point</span>
        <span style="display:block;font-size:11px;color:var(--ink-mid);margin-top:2px">
          À cocher si le GPS ne marche jamais chez toi : la tuile arrête de le chercher et répond instantanément.</span></span>
      </label>`;
  }

  function brancherDomicile() {
    const input = document.getElementById('velo-adr');
    const res = document.getElementById('velo-adr-res');
    if (!input) return;

    let minuteur = null;
    input.oninput = () => {
      clearTimeout(minuteur);
      minuteur = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < 4) { res.innerHTML = ''; return; }
        res.innerHTML = '<div style="font-size:11.5px;color:var(--ink-mid);padding:6px 0">Recherche…</div>';
        try {
          const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=fr&q=' + encodeURIComponent(q);
          const d = await fetchJson(url, 9000);
          if (!d.length) {
            res.innerHTML = '<div style="font-size:11.5px;color:var(--ink-mid);padding:6px 0">Adresse introuvable. Précise la ville.</div>';
            return;
          }
          res.innerHTML = d.map((x, i) => `
            <button data-adr="${i}" style="display:block;width:100%;text-align:left;padding:9px 11px;margin-bottom:5px;
              border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--bg-elev);font:inherit;font-size:12px;cursor:pointer;line-height:1.4">
              ${esc(x.display_name)}
            </button>`).join('');
          res.querySelectorAll('[data-adr]').forEach(b => {
            b.onclick = () => {
              const x = d[parseInt(b.dataset.adr, 10)];
              const court = x.display_name.split(',').slice(0, 3).join(',').trim();
              setDomicile(parseFloat(x.lat), parseFloat(x.lon), court);
              Sons.clic();
              notifier('📌 Point de repère : ' + court);
              dernierePosition = null;
              dessinerPanneau();
              rafraichirTuile();
            };
          });
        } catch (e) {
          res.innerHTML = '<div style="font-size:11.5px;color:var(--accent-2);padding:6px 0">Recherche d\'adresse indisponible.</div>';
        }
      }, 500);
    };

    const b = document.getElementById('velo-adr-ici');
    if (b) b.onclick = async () => {
      b.disabled = true; b.textContent = '📍 Recherche…';
      dernierePosition = null;
      const p = await maPosition(15000);
      b.disabled = false; b.textContent = '📍 Capturer ma position actuelle';
      if (!p) { notifier('📍 ' + (derniereErreurGeo ? derniereErreurGeo.message : 'Position introuvable')); return; }
      let nom = 'Position capturée';
      try {
        const r = await fetchJson('https://nominatim.openstreetmap.org/reverse?format=json&zoom=18&lat=' + p.lat + '&lon=' + p.lon, 8000);
        if (r && r.display_name) nom = r.display_name.split(',').slice(0, 3).join(',').trim();
      } catch (e) {}
      setDomicile(p.lat, p.lon, nom);
      notifier('📌 Point de repère : ' + nom);
      dessinerPanneau();
      rafraichirTuile();
    };
  }

  /* ---- Reglage de la bulle flottante ---- */
  function blocBulle() {
    if (!bulleDisponible()) {
      return `
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin:20px 0 6px">🫧 Bulle flottante</div>
        <div style="font-size:11.5px;color:var(--ink-mid);line-height:1.6">
          Disponible uniquement dans l'application Mon Bureau installée sur Android,
          à partir de la version 1.6.
        </div>`;
    }

    const ok = bulleAutorisee();
    const t = getTrajet();
    return `
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin:20px 0 6px">🫧 Bulle flottante</div>
      <div style="background:${ok ? 'var(--accent-1)' : 'var(--bg-elev)'};border:1px solid var(--line);border-radius:var(--radius-sm);padding:12px">
        <div style="font-size:12.5px;font-weight:600">${ok ? '✅ Autorisée' : '⚠️ Pas encore autorisée'}</div>
        <div style="font-size:11px;color:var(--ink-mid);line-height:1.6;margin-top:5px">
          Pendant un trajet, une pastille reste affichée par-dessus les autres applications —
          y compris vélôToulouse. Elle montre le temps et le montant, se déplace au doigt,
          et un appui ramène à Mon Bureau.
        </div>
        ${ok ? '' : `<button id="velo-bulle-perm" style="width:100%;margin-top:10px;padding:11px;border:none;border-radius:var(--radius-sm);
          background:var(--accent);color:#fff;font:inherit;font-size:13px;font-weight:700;cursor:pointer">Autoriser l'affichage par-dessus</button>`}
      </div>
      ${ok ? `<div style="display:flex;gap:7px;margin-top:8px">
        <button id="velo-bulle-test" style="flex:1;padding:10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;font:inherit;font-size:12px;cursor:pointer">🫧 ${t ? 'Réafficher' : 'Essayer'} la bulle</button>
        <button id="velo-bulle-off" style="flex:1;padding:10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;font:inherit;font-size:12px;cursor:pointer">Masquer</button>
      </div>` : ''}`;
  }

  function brancherBulle() {
    const p = document.getElementById('velo-bulle-perm');
    if (p) p.onclick = () => {
      try { window.MBVelo.demanderBulle(); } catch (e) {}
      setTimeout(dessinerPanneau, 3000);
    };
    const t1 = document.getElementById('velo-bulle-test');
    if (t1) t1.onclick = () => {
      const tr = getTrajet();
      lancerBulle(tr || { debut: Date.now(), gratuit: getConfig().minutesGratuites });
      notifier('🫧 Bulle affichée — reviens à ton écran d\'accueil pour la voir');
    };
    const t2 = document.getElementById('velo-bulle-off');
    if (t2) t2.onclick = () => { stopperBulle(); notifier('🫧 Bulle masquée'); };
  }

  /* ---- Diagnostic de la géolocalisation ---- */
  function blocDiagnosticGeo() {
    const e = etatGeoloc();
    const ligne = (label, ok, detail) => `
      <div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);font-size:12px">
        <span>${label}</span>
        <span style="color:${ok ? 'var(--accent-3)' : 'var(--accent-2)'};font-weight:600;text-align:right;flex-shrink:0">${detail}</span>
      </div>`;

    const p = e.position;
    return `
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin:20px 0 6px">📍 Diagnostic position</div>
      ${ligne('Connexion sécurisée (HTTPS)', e.securise, e.securise ? 'oui' : 'NON — bloquant')}
      ${ligne('Géolocalisation proposée', e.api, e.api ? 'oui' : 'NON — bloquant')}
      ${ligne('Application Android', pontDispo(), pontDispo() ? 'oui' : 'non (navigateur)')}
      ${e.natif ? ligne('Autorisation Android', e.natif.autorisee, e.natif.autorisee ? 'accordée' : 'REFUSÉE') : ''}
      ${e.natif ? ligne('Localisation du téléphone', e.natif.activee, e.natif.activee ? 'allumée' : 'ÉTEINTE') : ''}
      ${ligne('Dernière position', !!p, p ? (p.precision != null ? p.precision + ' m · ' + ilYA(p.t) : ilYA(p.t)) : 'aucune')}
      ${e.erreur ? ligne('Dernier échec', false, 'code ' + e.erreur.code) : ''}
      ${e.erreur ? `<div style="font-size:11px;color:var(--ink-mid);line-height:1.6;margin-top:6px">${esc(e.erreur.message)}</div>` : ''}
      <button id="velo-test-geo" style="width:100%;margin-top:10px;padding:11px;border:1px solid var(--line);border-radius:var(--radius-sm);
        background:none;font:inherit;font-size:12.5px;cursor:pointer">📍 Tester les 4 canaux</button>
      <div id="velo-geo-result" style="font-size:11.5px;color:var(--ink-mid);line-height:1.6;margin-top:8px"></div>
      ${e.natif && !e.natif.autorisee ? `<button id="velo-diag-perm" style="width:100%;margin-top:7px;padding:10px;border:none;border-radius:var(--radius-sm);background:var(--accent);color:#fff;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer">🔓 Demander l'autorisation Android</button>` : ''}
      ${e.natif && !e.natif.activee ? `<button id="velo-diag-loc" style="width:100%;margin-top:7px;padding:10px;border:none;border-radius:var(--radius-sm);background:var(--accent);color:#fff;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer">⚙️ Allumer la localisation du téléphone</button>` : ''}`;
  }

  function brancherDiagnosticGeo() {
    const dp = document.getElementById('velo-diag-perm');
    if (dp) dp.onclick = () => { try { window.MBVelo.demanderPermission(); } catch (e) {} setTimeout(dessinerPanneau, 2500); };
    const dl = document.getElementById('velo-diag-loc');
    if (dl) dl.onclick = () => { try { window.MBVelo.ouvrirReglagesPosition(); } catch (e) {} };

    const b = document.getElementById('velo-test-geo');
    if (!b) return;
    b.onclick = async () => {
      const out = document.getElementById('velo-geo-result');
      b.disabled = true; b.textContent = '📍 Test en cours…';
      dernierePosition = null; derniereErreurGeo = null;
      const lignes = [];
      const rendre = () => { if (out) out.innerHTML = lignes.join('<br>'); };

      // Canal 1
      lignes.push('⏳ Canal 1 — Android natif…'); rendre();
      let t0 = Date.now();
      const n = await positionNative();
      lignes[0] = n
        ? `✅ Canal 1 — Android natif : ${n.precision || '?'} m en ${((Date.now() - t0) / 1000).toFixed(1)} s (${esc(n.canal)})`
        : (pontDispo() ? `❌ Canal 1 — Android natif : ${esc(derniereErreurGeo ? derniereErreurGeo.message : 'aucune mesure')}`
                       : '➖ Canal 1 — Android natif : indisponible (navigateur)');
      rendre();

      // Canal 2
      lignes.push('⏳ Canal 2 — navigateur…'); rendre();
      t0 = Date.now();
      const g = await maPosition(15000);
      lignes[1] = g
        ? `✅ Canal 2 — navigateur : ${g.precision || '?'} m en ${((Date.now() - t0) / 1000).toFixed(1)} s`
        : `❌ Canal 2 — navigateur : ${esc(derniereErreurGeo ? derniereErreurGeo.message : 'échec')}`;
      rendre();

      // Canal 3
      lignes.push('⏳ Canal 3 — adresse IP…'); rendre();
      t0 = Date.now();
      const ip = await positionIP();
      lignes[2] = ip
        ? `✅ Canal 3 — adresse IP : ${esc(ip.ville || '?')} en ${((Date.now() - t0) / 1000).toFixed(1)} s`
        : '❌ Canal 3 — adresse IP : échec';
      rendre();

      // Résultat retenu
      const p = n || g || ip;
      if (p) {
        const proches = await getStationsProches(p.lat, p.lon, 1, {});
        lignes.push('');
        lignes.push(`<strong>Retenu :</strong> ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`);
        lignes.push(proches[0]
          ? 'Station la plus proche : ' + esc(proches[0].name) + ' à ' + distanceText(proches[0].dist)
          : 'Aucune station à moins de 1,5 km.');
      } else {
        lignes.push('');
        lignes.push('<strong>Aucun canal n\'a répondu.</strong> Repli sur l\'adresse maison.');
      }
      rendre();
      b.disabled = false; b.textContent = '📍 Tester les 4 canaux';
      rafraichirTuile();
    };
  }

  /* ---- Section « chrono automatique » (launcher Android seulement) ---- */
  function blocAndroid() {
    if (!pontDispo()) {
      return `
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin:20px 0 6px">Chrono automatique</div>
        <div style="font-size:11.5px;color:var(--ink-mid);line-height:1.6">
          Disponible uniquement dans l'application Mon Bureau installée sur Android.
          Sur navigateur, le chrono reste manuel.
        </div>`;
    }

    const ok = pontAutorise();
    let paquet = '';
    try { paquet = window.MBVelo.paquet() || ''; } catch (e) {}
    const journal = pontJson('journal');

    // Applications distinctes vues récemment, la plus récente en premier
    const apps = [];
    journal.slice().reverse().forEach(n => {
      if (!apps.find(a => a.pkg === n.pkg)) apps.push({ pkg: n.pkg, app: n.app, dernier: n.texte, t: n.t });
    });

    return `
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid);margin:20px 0 6px">🤖 Chrono automatique</div>

      <div style="background:${ok ? 'var(--accent-1)' : 'var(--bg-elev)'};border:1px solid var(--line);
        border-radius:var(--radius-sm);padding:12px">
        <div style="font-size:12.5px;font-weight:600">${ok ? '✅ Accès aux notifications accordé' : '⚠️ Accès aux notifications non accordé'}</div>
        <div style="font-size:11px;color:var(--ink-mid);line-height:1.6;margin-top:5px">
          L'appli officielle vélôToulouse prévient au déverrouillage et à la restitution du vélo.
          En lisant ces notifications, Mon Bureau lance et arrête le chrono tout seul —
          sans jamais connaître ton mot de passe.
        </div>
        ${ok ? '' : `<button id="velo-perm" style="width:100%;margin-top:10px;padding:11px;border:none;border-radius:var(--radius-sm);
          background:var(--accent);color:#fff;font:inherit;font-size:13px;font-weight:700;cursor:pointer">Ouvrir les réglages Android</button>`}
      </div>

      ${ok ? `
        <div style="font-size:11.5px;color:var(--ink-mid);margin:14px 0 6px">
          ${paquet ? `Application surveillée : <strong>${esc(paquet)}</strong>`
                   : 'Aucune application désignée. Fais un trajet, puis reviens ici et choisis vélôToulouse dans la liste.'}
        </div>

        ${apps.length ? apps.slice(0, 12).map(a => `
          <button data-app-velo="${esc(a.pkg)}" style="display:block;width:100%;text-align:left;padding:10px 12px;margin-bottom:6px;
            border:1px solid ${a.pkg === paquet ? 'var(--accent)' : 'var(--line)'};border-radius:var(--radius-sm);
            background:${a.pkg === paquet ? 'var(--accent-1)' : 'var(--bg-elev)'};font:inherit;cursor:pointer">
            <div style="font-size:13px;font-weight:600">${a.pkg === paquet ? '✅ ' : ''}${esc(a.app || a.pkg)}</div>
            <div style="font-size:10px;color:var(--ink-mid);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(a.dernier || '')}</div>
          </button>`).join('')
          : `<div style="font-size:12px;color:var(--ink-mid);padding:8px 0">Aucune notification captée pour l'instant.</div>`}

        <div style="display:flex;gap:7px;margin-top:10px;flex-wrap:wrap">
          <button id="velo-sim-debut" style="flex:1;padding:9px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;font:inherit;font-size:11.5px;cursor:pointer">🧪 Simuler un départ</button>
          <button id="velo-sim-fin" style="flex:1;padding:9px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;font:inherit;font-size:11.5px;cursor:pointer">🧪 Simuler une fin</button>
          <button id="velo-vider-journal" style="flex:1;padding:9px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;font:inherit;font-size:11.5px;cursor:pointer">↺ Vider la liste</button>
        </div>
        ${paquet ? `<button id="velo-oublier-app" style="width:100%;margin-top:7px;padding:9px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;color:var(--accent-2);font:inherit;font-size:11.5px;cursor:pointer">Ne plus surveiller cette application</button>` : ''}
      ` : ''}`;
  }

  function brancherAndroid() {
    const perm = document.getElementById('velo-perm');
    if (perm) perm.onclick = () => { try { window.MBVelo.ouvrirReglages(); } catch (e) {} };

    document.querySelectorAll('[data-app-velo]').forEach(b => {
      b.onclick = () => {
        try { window.MBVelo.definirPaquet(b.dataset.appVelo); } catch (e) {}
        Sons.clic();
        notifier('🤖 Application surveillée enregistrée');
        dessinerPanneau();
      };
    });

    const sd = document.getElementById('velo-sim-debut');
    if (sd) sd.onclick = () => { try { window.MBVelo.simuler('DEBUT'); } catch (e) {} setTimeout(releverEvenements, 300); };
    const sf = document.getElementById('velo-sim-fin');
    if (sf) sf.onclick = () => { try { window.MBVelo.simuler('FIN'); } catch (e) {} setTimeout(releverEvenements, 300); };
    const vj = document.getElementById('velo-vider-journal');
    if (vj) vj.onclick = () => { try { window.MBVelo.viderJournal(); } catch (e) {} dessinerPanneau(); };
    const ou = document.getElementById('velo-oublier-app');
    if (ou) ou.onclick = () => { try { window.MBVelo.definirPaquet(''); } catch (e) {} dessinerPanneau(); };
  }

  /* ---- Bandeau d'explication quand la position pose problème ---- */
  function bandeauGeoloc(p) {
    if (p && p.manuel) {
      return `<div style="background:var(--accent-1);border-radius:var(--radius-sm);padding:10px 12px;margin-bottom:12px;font-size:11.5px">
        📌 Position fixe : <strong>${esc(p.nom || 'point de repère')}</strong>
        <span style="color:var(--ink-mid)"> — le GPS n'est plus interrogé (réglable dans ⚙️ Plus).</span></div>`;
    }
    if (p && !p.approx && !p.ancienne && !p.parIP) return '';   // tout va bien

    const e = derniereErreurGeo;
    let titre, aide;

    const e0 = derniereErreurGeo;
    const boutonsAndroid = pontDispo() ? `
      <div style="display:flex;gap:7px;margin-top:9px">
        ${e0 && e0.code === 5 ? `<button id="velo-geo-reglages" style="flex:1;padding:9px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;font:inherit;font-size:11.5px;cursor:pointer">⚙️ Allumer la localisation</button>` : ''}
        ${e0 && e0.code === 1 ? `<button id="velo-geo-perm" style="flex:1;padding:9px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;font:inherit;font-size:11.5px;cursor:pointer">🔓 Demander l'autorisation</button>` : ''}
      </div>` : '';

    if (p && p.parIP) {
      titre = '🌐 Position estimée d\'après ta connexion' + (p.ville ? ' (' + esc(p.ville) + ')' : '');
      aide = "Précision de l'ordre du quartier. Les distances affichées sont indicatives — active la localisation pour un repérage exact.";
    } else if (p && p.ancienne) {
      titre = '📍 Position datée du ' + new Date(p.t).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      aide = "Je n'ai pas pu te localiser à l'instant, j'utilise ta dernière position connue.";
    } else if (e && e.code === 1) {
      titre = '🚫 Accès à ta position refusé';
      aide = pontDispo()
        ? "Ouvre les Paramètres Android → Applications → Mon Bureau → Autorisations → Position, et choisis « Autoriser »."
        : "Clique sur l'icône à gauche de l'adresse du site (cadenas ou curseurs), puis autorise la position pour ce site. Un simple « Réessayer » ne suffit pas une fois le refus enregistré.";
    } else if (e && e.code === 4) {
      titre = '🔒 Connexion non sécurisée';
      aide = "Les navigateurs n'autorisent la géolocalisation qu'en HTTPS. Vérifie que l'adresse commence bien par https://.";
    } else if (e && e.code === 0) {
      titre = '📍 Géolocalisation indisponible';
      aide = "Cet appareil ou ce navigateur ne propose pas de géolocalisation.";
    } else if (e) {
      titre = '📍 Position introuvable';
      aide = (e.message || '') + " Vérifie que la localisation du téléphone est allumée, et que le Wi-Fi est activé même si tu n'y es pas connectée : il aide beaucoup au repérage.";
    } else if (p && p.approx) {
      titre = '📍 Repli sur ' + esc(p.nom || 'ton point de repère');
      aide = "Le GPS n'a rien renvoyé. Les distances sont calculées depuis cette adresse.";
    } else {
      titre = '📍 Position en attente';
      aide = "La position n'a pas encore été demandée.";
    }

    return `
      <div style="background:var(--accent-1);border-radius:var(--radius-sm);padding:11px 13px;margin-bottom:12px">
        <div style="font-size:12.5px;font-weight:600">${titre}</div>
        <div style="font-size:11px;color:var(--ink-mid);line-height:1.6;margin-top:4px">${aide}</div>
        <button id="velo-retry-geo" style="width:100%;margin-top:9px;padding:9px;border:none;border-radius:var(--radius-sm);
          background:var(--accent);color:#fff;font:inherit;font-size:12px;font-weight:600;cursor:pointer">📍 Réessayer maintenant</button>
        ${boutonsAndroid}
      </div>`;
  }

  function brancherGeoloc() {
    const r = document.getElementById('velo-geo-reglages');
    if (r) r.onclick = () => { try { window.MBVelo.ouvrirReglagesPosition(); } catch (e) {} };
    const a = document.getElementById('velo-geo-perm');
    if (a) a.onclick = () => { try { window.MBVelo.demanderPermission(); } catch (e) {} };

    const b = document.getElementById('velo-retry-geo');
    if (!b) return;
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = '📍 Recherche en cours…';
      dernierePosition = null;
      derniereErreurGeo = null;
      const p = await pointDeReference();
      if (p && !p.approx && !p.parIP) {
        notifier('📍 Position trouvée à ' + (p.precision || '?') + ' m près');
      } else if (p && p.parIP) {
        notifier('🌐 Position estimée par la connexion');
      } else {
        notifier('📍 ' + (derniereErreurGeo ? derniereErreurGeo.message : 'Position introuvable'));
      }
      dessinerPanneau();
      rafraichirTuile();
    };
  }

  /* ---- Bandeau : emprunts restants + crédit Bonus ---- */
  function bandeauCompteur() {
    const conf = getConfig();
    const j = compteurJour();
    const reste = Math.max(0, conf.maxEmprunts - j.n);
    const credit = getCredit();
    const cj = coutDuJour();
    const coul = reste === 0 ? 'var(--accent-2)' : reste <= 2 ? 'var(--accent-4)' : 'var(--accent-3)';
    const points = Array.from({ length: conf.maxEmprunts }, (_, i) =>
      `<span style="width:9px;height:9px;border-radius:999px;background:${i < j.n ? coul : 'var(--line)'}"></span>`).join('');

    return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--accent-1);
        border-radius:var(--radius-sm);padding:10px 12px;margin-bottom:12px">
        <div>
          <div style="font-size:11px;color:var(--ink-mid)">Emprunts du jour</div>
          <div style="display:flex;gap:4px;align-items:center;margin-top:5px">${points}</div>
        </div>
        <div style="text-align:right">
          <div style="font-family:var(--font-mono);font-size:18px;font-weight:700;color:${coul}">${j.n}/${conf.maxEmprunts}</div>
          ${credit > 0 ? `<div style="font-size:10px;color:var(--accent-4);font-weight:700">⛰️ +${credit} min de crédit</div>`
                       : `<div style="font-size:10px;color:var(--ink-mid)">${reste} restant${reste > 1 ? 's' : ''}</div>`}
        </div>
        <div style="text-align:right;border-left:1px solid rgba(0,0,0,.1);padding-left:12px">
          <div style="font-size:11px;color:var(--ink-mid)">Aujourd'hui</div>
          <div style="font-family:var(--font-mono);font-size:18px;font-weight:700;color:${cj.total > 0 ? 'var(--accent-2)' : 'var(--accent-3)'}">${euros(cj.total)}</div>
          ${cj.empruntsSupp > 0 ? `<div style="font-size:9px;color:var(--accent-2)">dont ${cj.empruntsSupp} emprunt(s) hors quota</div>` : ''}
        </div>
      </div>
      ${reste === 0 ? `<div style="background:var(--accent-2);color:#fff;border-radius:var(--radius-sm);padding:9px 12px;
        font-size:12px;font-weight:600;margin-bottom:12px">⛔ Limite de ${conf.maxEmprunts} emprunts atteinte aujourd'hui.</div>` : ''}`;
  }

  /* ---- Bloc visuel d'une station ---- */
  function carteStation(s, mode) {
    const pourPartir = mode === 'partir';
    const chiffre = pourPartir ? s.availableBikes : s.availableDocks;
    const vert = chiffre >= 4, orange = chiffre >= 1 && chiffre < 4;
    const coul = vert ? 'var(--accent-3)' : orange ? 'var(--accent-4)' : 'var(--accent-2)';
    const etat = vert ? 'Bonne dispo' : orange ? 'Juste — fonce' : (pourPartir ? 'Aucun vélo' : 'Station pleine');
    const capa = s.capacity || (s.availableBikes + s.availableDocks) || 1;
    const pctVelos = Math.round((s.availableBikes / capa) * 100);
    const alerte = (pourPartir && s.retrait === false) ? '⛔ Retrait impossible'
                 : (!pourPartir && s.depot === false) ? '⛔ Dépôt impossible' : '';

    const util = utiliteReseau(s, pourPartir ? 'partir' : 'arriver');
    const bonus = !pourPartir && estBonus(s);
    const badges = [];
    if (util) badges.push(`<span style="display:inline-block;padding:3px 9px;border-radius:999px;font-size:10px;font-weight:700;
      background:${util.niveau === 2 ? 'var(--accent-3)' : 'var(--accent-1)'};color:${util.niveau === 2 ? '#fff' : 'var(--accent)'}">
      🎁 ${esc(util.texte)}</span>`);
    if (bonus) badges.push(`<span style="display:inline-block;padding:3px 9px;border-radius:999px;font-size:10px;font-weight:700;
      background:var(--accent-4);color:#fff">⛰️ Bonus +15 min</span>`);
    const ligneBadges = badges.length
      ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:8px">${badges.join('')}</div>` : '';

    return `
      <div style="border:1px solid var(--line);border-left:4px solid ${coul};border-radius:var(--radius-sm);padding:12px;margin-bottom:9px;background:var(--bg-elev)">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
          <div style="min-width:0;flex:1">
            <div style="font-size:14px;font-weight:600;line-height:1.25">${esc(s.name)}</div>
            ${s.address ? `<div style="font-size:11px;color:var(--ink-mid);margin-top:1px">${esc(s.address)}</div>` : ''}
            <div style="font-size:10px;color:var(--ink-low);margin-top:2px">
              ${s.numero != null ? 'Borne n° ' + s.numero : ''}${s.cb ? ' · 💳 terminal CB' : ''}${s.horsLigne ? ' · 📡 hors ligne' : ''}
            </div>
            <div style="font-size:11px;color:var(--ink-mid);margin-top:4px">
              🚶 ${walkMinutes(s.dist)} min · ${distanceText(s.dist)}${pourPartir ? '' : ' de l\'arrivée'}
            </div>
          </div>
          <div style="text-align:center;flex-shrink:0">
            <div style="font-family:var(--font-mono);font-size:26px;font-weight:700;line-height:1;color:${coul}">${chiffre}</div>
            <div style="font-size:9px;color:var(--ink-mid);margin-top:2px">${pourPartir ? 'vélos' : 'places'}</div>
          </div>
        </div>

        <div style="height:6px;background:var(--line);border-radius:999px;overflow:hidden;margin:10px 0 6px;display:flex">
          <div style="width:${pctVelos}%;background:var(--accent-3)"></div>
          <div style="flex:1;background:var(--ink-low);opacity:.35"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--ink-mid)">
          <span>🚲 ${s.mbikes} méca${s.ebikes ? ' · ⚡ ' + s.ebikes + ' élec' : ''}</span>
          <span>🅿️ ${s.availableDocks} / ${capa}</span>
        </div>
        ${(s.bikesHS || s.docksHS) ? `<div style="font-size:10px;color:var(--ink-low);margin-top:3px">🔧 ${s.bikesHS} vélo(s) HS · ${s.docksHS} borne(s) HS</div>` : ''}
        ${alerte ? `<div style="font-size:11px;color:var(--accent-2);font-weight:600;margin-top:5px">${alerte}</div>` : ''}
        ${ligneBadges}

        <div style="display:flex;gap:7px;margin-top:11px">
          <button data-itin="${s.lat},${s.lon}" data-itin-nom="${esc(s.name)}" style="flex:1;padding:9px;border:1px solid var(--line);border-radius:var(--radius-sm);background:none;font:inherit;font-size:12px;cursor:pointer">🧭 Y aller</button>
          ${pourPartir
            ? `<button data-partir="${esc(s.id)}" ${chiffre === 0 || s.retrait === false ? 'disabled' : ''}
                 style="flex:2;padding:9px;border:none;border-radius:var(--radius-sm);font:inherit;font-size:12px;font-weight:700;cursor:pointer;
                 background:${chiffre === 0 || s.retrait === false ? 'var(--line)' : 'var(--accent)'};color:${chiffre === 0 || s.retrait === false ? 'var(--ink-low)' : '#fff'}">
                 ▶️ Je pars d'ici</button>`
            : `<div style="flex:2;display:flex;align-items:center;justify-content:center;font-size:11px;color:${coul};font-weight:600">${etat}</div>`}
          <button data-bonus="${esc(s.id)}" title="Marquer / démarquer comme station Bonus"
            style="padding:9px 11px;border:1px solid var(--line);border-radius:var(--radius-sm);background:${bonus ? 'var(--accent-4)' : 'none'};font:inherit;font-size:12px;cursor:pointer">⛰️</button>
        </div>
      </div>`;
  }

  /* =======================================================
     ANNONCES VOCALES
     -------------------------------------------------------
     A velo on ne regarde pas l'ecran. La voix de synthese du
     telephone annonce donc les changements de direction, les
     seuils de temps et les places restantes a l'arrivee.

     Aucune permission, aucun fichier son : c'est la voix
     integree au systeme, celle qui lit les messages.
     ======================================================= */

  let voixFr = null;

  function choisirVoix() {
    try {
      if (!window.speechSynthesis) return null;
      if (voixFr) return voixFr;
      const voix = window.speechSynthesis.getVoices() || [];
      voixFr = voix.find(v => /^fr[-_]FR/i.test(v.lang))
            || voix.find(v => /^fr/i.test(v.lang))
            || null;
      return voixFr;
    } catch (e) { return null; }
  }

  function parler(texte, prioritaire) {
    if (!getConfig().voix) return;
    try {
      if (!window.speechSynthesis) return;
      if (prioritaire) window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(texte);
      u.lang = 'fr-FR';
      u.rate = 1.0;
      u.volume = 1.0;
      const v = choisirVoix();
      if (v) u.voice = v;
      window.speechSynthesis.speak(u);
    } catch (e) {
      console.warn('[Vélô] voix indisponible :', e.message);
    }
  }

  // Les voix arrivent parfois apres le chargement de la page
  try {
    if (window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = () => { voixFr = null; choisirVoix(); };
    }
  } catch (e) {}

  /* =======================================================
     ITINERAIRES REELS (OSRM / OpenStreetMap)
     -------------------------------------------------------
     Jusqu'ici les durees etaient estimees a vol d'oiseau, ce
     qui les rendait trop optimistes : les rues ne vont pas
     tout droit. On demande maintenant le vrai trajet au
     service de routage d'OpenStreetMap, avec le profil velo
     ou pieton selon le cas.

     Verifie le 12/08/2026 : CORS ouvert, profils routed-foot
     et routed-bike disponibles, instructions detaillees.
     ======================================================= */

  const OSRM = 'https://routing.openstreetmap.de/';
  const K_ROUTES = 'velo_routes_cache';

  /* mode : 'bike' ou 'foot'. Retourne { metres, minutes, etapes } ou null. */
  async function itineraireReel(latA, lonA, latB, lonB, mode, avecEtapes) {
    const profil = mode === 'foot' ? 'routed-foot' : 'routed-bike';
    const cle = profil + ':' + latA.toFixed(4) + ',' + lonA.toFixed(4)
              + ':' + latB.toFixed(4) + ',' + lonB.toFixed(4) + (avecEtapes ? ':s' : '');

    if (!avecEtapes) {
      const cache = lire(K_ROUTES, {});
      if (cache[cle] && Date.now() - cache[cle].t < 7 * 86400000) return cache[cle].r;
    }

    try {
      const url = OSRM + profil + '/route/v1/driving/'
                + lonA + ',' + latA + ';' + lonB + ',' + latB
                + '?overview=false' + (avecEtapes ? '&steps=true' : '');
      const d = await fetchJson(url, 9000);
      if (!d || !d.routes || !d.routes.length) return null;

      const r0 = d.routes[0];
      const r = {
        metres: Math.round(r0.distance),
        minutes: Math.max(1, Math.round(r0.duration / 60)),
        etapes: avecEtapes ? (r0.legs[0].steps || []).map(e => ({
          type: e.maneuver.type,
          cote: e.maneuver.modifier || '',
          rue: e.name || '',
          metres: Math.round(e.distance),
          lat: e.maneuver.location[1],
          lon: e.maneuver.location[0]
        })) : null
      };

      if (!avecEtapes) {
        const cache = lire(K_ROUTES, {});
        cache[cle] = { t: Date.now(), r: r };
        // on ne garde que les 60 derniers trajets
        const cles = Object.keys(cache);
        if (cles.length > 60) cles.slice(0, cles.length - 60).forEach(k => delete cache[k]);
        ecrire(K_ROUTES, cache);
      }
      return r;
    } catch (e) {
      console.warn('[Vélô] routage indisponible :', e.message);
      return null;
    }
  }

  /* Transforme une manoeuvre OSRM en phrase francaise. */
  function phraseEtape(e) {
    const cotes = {
      'left': 'à gauche', 'right': 'à droite',
      'slight left': 'légèrement à gauche', 'slight right': 'légèrement à droite',
      'sharp left': 'franchement à gauche', 'sharp right': 'franchement à droite',
      'straight': 'tout droit', 'uturn': 'demi-tour'
    };
    const c = cotes[e.cote] || '';
    const rue = e.rue ? ' sur ' + e.rue : '';

    switch (e.type) {
      case 'depart':       return 'Départ' + rue;
      case 'arrive':       return 'Vous êtes arrivée';
      case 'turn':         return 'Tourne ' + c + rue;
      case 'new name':     return 'Continue' + rue;
      case 'continue':     return 'Continue ' + c + rue;
      case 'merge':        return 'Rejoins' + rue;
      case 'roundabout':
      case 'rotary':       return 'Au rond-point, prends la sortie' + rue;
      case 'fork':         return 'Garde ' + c + rue;
      case 'end of road':  return 'Au bout de la rue, va ' + c + rue;
      default:             return (c ? 'Va ' + c : 'Continue') + rue;
    }
  }

  /* =======================================================
     GUIDAGE VERS LA STATION D'ARRIVEE
     -------------------------------------------------------
     Une fois le trajet lance avec une arrivee definie, on
     calcule l'itineraire velo puis on suit ta position. Quand
     tu approches d'un virage, il est annonce a voix haute.
     ======================================================= */

  let guidage = null;   // { etapes, index, veille }

  async function demarrerGuidage(t) {
    if (!getConfig().guidage || !t || !t.arrivee) return;
    try {
      const p = await pointDeReference();
      const r = await itineraireReel(p.lat, p.lon, t.arrivee.lat, t.arrivee.lon, 'bike', true);
      if (!r || !r.etapes || r.etapes.length < 2) return;

      guidage = { etapes: r.etapes, index: 1, annoncees: {}, veille: null };
      const longueur = r.metres >= 1000
        ? (r.metres / 1000).toFixed(1).replace('.', ',') + ' kilomètres'
        : r.metres + ' mètres';
      parler('Itinéraire calculé : ' + longueur + ', environ ' + r.minutes + ' minutes.', true);

      // On suit la position en continu pendant le trajet
      if (navigator.geolocation) {
        guidage.veille = navigator.geolocation.watchPosition(
          pos => suivreGuidage(pos.coords.latitude, pos.coords.longitude),
          () => {},
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
        );
      }
      rafraichirTuile();
    } catch (e) {
      console.warn('[Vélô] guidage impossible :', e.message);
    }
  }

  function suivreGuidage(lat, lon) {
    if (!guidage || guidage.index >= guidage.etapes.length) return;

    const e = guidage.etapes[guidage.index];
    const d = distance(lat, lon, e.lat, e.lon);

    // Annonce a 120 m, puis rappel a 30 m
    if (d < 120 && !guidage.annoncees[guidage.index + ':loin']) {
      guidage.annoncees[guidage.index + ':loin'] = true;
      parler('Dans ' + Math.round(d / 10) * 10 + ' mètres, ' + phraseEtape(e).toLowerCase());
    }
    if (d < 30 && !guidage.annoncees[guidage.index + ':pres']) {
      guidage.annoncees[guidage.index + ':pres'] = true;
      parler(phraseEtape(e), true);
    }
    // Virage passe : on vise le suivant
    if (d < 18) {
      guidage.index++;
      if (guidage.index >= guidage.etapes.length) {
        parler('Tu arrives à destination.', true);
        arreterGuidage();
      }
    }
    majGuidageAffichage(d);
  }

  function majGuidageAffichage(dist) {
    const z = document.getElementById('velo-guidage');
    if (!z) return;
    if (!guidage || guidage.index >= guidage.etapes.length) { z.style.display = 'none'; return; }
    const e = guidage.etapes[guidage.index];
    const fleches = {
      'left': '⬅️', 'right': '➡️', 'slight left': '↖️', 'slight right': '↗️',
      'sharp left': '↰', 'sharp right': '↱', 'straight': '⬆️', 'uturn': '⤵️'
    };
    z.style.display = 'block';
    z.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px">
        <div style="font-size:30px;line-height:1">${fleches[e.cote] || '⬆️'}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;line-height:1.3">${esc(phraseEtape(e))}</div>
          <div style="font-size:11px;color:var(--ink-mid)">dans ${dist != null ? distanceText(dist) : distanceText(e.metres)}</div>
        </div>
      </div>`;
  }

  function arreterGuidage() {
    if (!guidage) return;
    try { if (guidage.veille != null) navigator.geolocation.clearWatch(guidage.veille); } catch (e) {}
    guidage = null;
    const z = document.getElementById('velo-guidage');
    if (z) z.style.display = 'none';
  }

  /* Ouvre un itineraire vers un point.

     window.open est bloque dans la WebView du launcher Android : le clic
     ne faisait donc rien du tout. On passe par un lien clique par le code,
     ce qui fonctionne aussi bien dans un navigateur que dans l'application.

     Le service se choisit dans les reglages : OpenStreetMap par defaut,
     ou l'application de navigation installee sur le telephone. */
  function ouvrirItineraire(lat, lon, nom) {
    const conf = getConfig();
    const depuis = dernierePosition || getDomicile();
    let url;

    if (conf.navigation === 'geo') {
      url = 'geo:' + lat + ',' + lon + '?q=' + lat + ',' + lon
          + (nom ? '(' + encodeURIComponent(nom) + ')' : '');
    } else if (conf.navigation === 'google') {
      url = 'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lon + '&travelmode=walking';
    } else {
      url = 'https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot'
          + '&route=' + depuis.lat + '%2C' + depuis.lon + '%3B' + lat + '%2C' + lon;
    }

    try {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 500);
    } catch (e) {
      try { window.location.href = url; }
      catch (e2) { notifier('Impossible d\'ouvrir la navigation'); }
    }
  }

  function brancherItineraires(zone) {
    zone.querySelectorAll('[data-itin]').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const [lat, lon] = b.dataset.itin.split(',');
        ouvrirItineraire(lat, lon, b.dataset.itinNom || '');
      };
    });
    zone.querySelectorAll('[data-bonus]').forEach(b => {
      b.onclick = () => {
        const id = b.dataset.bonus;
        const manuel = lire(K_BONUS, {});
        const actuel = Object.prototype.hasOwnProperty.call(manuel, id) ? manuel[id] : null;
        // cycle : deviné -> confirmé Bonus -> confirmé pas Bonus -> deviné
        if (actuel === null) marquerBonus(id, true);
        else if (actuel === true) marquerBonus(id, false);
        else marquerBonus(id, null);
        Sons.clic();
        dessinerPanneau();
      };
    });
  }

  /* =======================================================
     10. BRANCHEMENT SUR L'ACCUEIL
     ======================================================= */

  // Interception en phase de capture : ce gestionnaire s'exécute AVANT
  // celui que couche3.js pose sur chaque tuile, quel que soit l'ordre
  // de chargement des scripts.
  function brancherClics() {
    document.addEventListener('click', e => {
      const tile = e.target.closest && e.target.closest('[data-app="velo"]');
      if (!tile) return;
      if (e.target.closest('#velo-stop-tuile')) return; // bouton interne
      e.stopImmediatePropagation();
      e.preventDefault();
      ouvrirPanneau();
    }, true);

    document.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tile = e.target.closest && e.target.closest('[data-app="velo"]');
      if (!tile) return;
      e.preventDefault();
      ouvrirPanneau();
    }, true);
  }

  function init() {
    brancherClics();
    injecterTuile();
    lancerEcouteAndroid();
    if (getTrajet()) lancerHorloge();

    // Rafraîchissement de la tuile toutes les 2 minutes (léger)
    setInterval(() => { if (!getTrajet()) rafraichirTuile(); }, 120000);

    // Quand tu reviens sur l'app : on remet tout à jour immédiatement
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        rafraichirTuile();
        if (getTrajet()) { lancerHorloge(); garderEcranAllume(); }
      }
    });
    if (getTrajet()) garderEcranAllume();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* =======================================================
     11. API PUBLIQUE
     (les 3 premières existaient déjà : compatibilité assurée)
     ======================================================= */

  function renderStations(stations) {
    if (!stations || !stations.length) return `<div class="dm-card-label">Aucune station proche</div>`;
    return stations.map(s => `
      <div style="display:flex;align-items:center;justify-content:space-between;width:100%;padding:5px 0;border-bottom:1px solid var(--line)">
        <div>
          <div style="font-size:12px;font-weight:500">${esc(s.name)}</div>
          <div style="font-size:10px;color:var(--ink-mid)">🚶 ${walkMinutes(s.dist)} min · ${distanceText(s.dist)}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-shrink:0;text-align:center">
          <div><div style="font-size:15px;font-weight:700;color:${s.availableBikes > 0 ? 'var(--accent-3)' : 'var(--accent-2)'}">${s.availableBikes}</div>
               <div style="font-size:9px;color:var(--ink-mid)">🚲 vélos</div></div>
          <div><div style="font-size:15px;font-weight:700;color:${s.availableDocks > 0 ? 'var(--ink)' : 'var(--accent-2)'}">${s.availableDocks}</div>
               <div style="font-size:9px;color:var(--ink-mid)">🅿️ places</div></div>
        </div>
      </div>`).join('');
  }

  async function renderVeloOption(dest, stationProche) {
    if (!stationProche) {
      const p = await pointDeReference();
      const s = await getStationsProches(p.lat, p.lon, 1, { pourPartir: true });
      stationProche = s[0];
    }
    if (!stationProche) return null;
    const n = stationProche.availableBikes;
    return {
      mode: 'bicycling',
      label: '🚲 VélôToulouse',
      sublabel: stationProche.name + ' · ' + n + ' vélo' + (n > 1 ? 's' : '') + ' dispo',
      disabled: n === 0,
      color: n > 0 ? '#2d9c6a' : '#e63946',
      stationProche: stationProche
    };
  }

  return {
    // données
    fetchStations, getStationsProches, renderStations, renderVeloOption,
    distance, distanceText, walkMinutes, bikeMinutes,
    HOME_LAT, HOME_LON,
    // trajet
    demarrerTrajet, arreterTrajet, getTrajet, tempsEcoule,
    // interface
    ouvrirPanneau, rafraichirTuile,
    // réglages
    getConfig, setConfig, getFavoris, ajouterFavori, supprimerFavori,
    // fidélité & bonus
    compteurJour, incrementerJour, empruntsRestants,
    estBonus, marquerBonus, utiliteReseau,
    getCredit, setCredit, ajouterCredit,
    coutTrajet, coutDuJour, secondesAvantTranche, trancheActuelle, euros,
    // pont Android
    pontDispo, pontAutorise, releverEvenements,
    bulleDisponible, bulleAutorisee, lancerBulle, stopperBulle,
    majBanniereTrajet,
    // divers
    VERSION,
    ouvrirItineraire, itineraireReel, phraseEtape, parler,
    demarrerGuidage, arreterGuidage,
    Sons, maPosition, positionNative, positionIP, pointDeReference, etatGeoloc,
    getDomicile, setDomicile,
    evenementsAvecLieu, geocoder, calculerDepart,
    get source() { return sourceActive; }
  };
})();

window.AgentVelo = AgentVelo;
console.log('✅ Agent VélôToulouse v' + AgentVelo.VERSION + ' — GBFS direct, tuile + chrono + alertes');
