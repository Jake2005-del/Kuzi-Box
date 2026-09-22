// --- SUPABASE CONFIGURATION ---
const SUPABASE_URL = 'https://dmmbwtadrjrujksorwfj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_YvfEOPqg2IEVqzQ-p4Fylw_C2AeEkdj';

const supabaseClient = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

let userSession = { id: null, email: "", username: "", kuziCoins: 10, isVip: false, streakCount: 0, refCode: "", lastSpinTime: null };
let activeMovie = null;
let activeCategoryTag = "Movie";
let activeServer = 'alldebrid';
let serverLoadTimeout = null;
let serverSwitchAttempts = 0;
const serverProviders = ['alldebrid', 'vidsrc', 'vidsrcme', '2embed', 'watchv2_autoembed', 'superembed', 'rivestream', 'nontongo'];
const SERVER_LOAD_TIMEOUT_MS = 12000;
let vipTimerInterval = null;
let watchTimerInterval = null;
let watchSeconds = 0;
let watchRewardGranted = false;
let isVideoPlaying = false;
let isSettlingReferral = false;
let searchController = null;
let notificationItems = JSON.parse(localStorage.getItem("kuzi_notifications") || "[]");
const rowPages = { movies: 1, anime: 1, shows: 1 };
const rowLoading = { movies: false, anime: false, shows: false };
let isGoldenSpinning = false;
let accountRewardState = {};
const DAILY_SPIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const GOLDEN_WATCH_TARGET_MINUTES = 300;
const GOLDEN_WATCH_TARGET_SECONDS = GOLDEN_WATCH_TARGET_MINUTES * 60;
let serverClockOffsetMs = 0;
let deferredInstallPrompt = null;
let rewardStateSaveTimer = null;

function getDailySpinStorageKey() {
    return `kuzi_daily_spins_${userSession.id || "guest"}`;
}

function setupInstallPrompt() {
    window.addEventListener("beforeinstallprompt", (event) => {
        event.preventDefault();
        deferredInstallPrompt = event;
        window.dispatchEvent(new Event("kuziinstallavailable"));
    });

    window.addEventListener("appinstalled", () => {
        deferredInstallPrompt = null;
    });

    window.promptInstallApp = async () => {
        if (!deferredInstallPrompt) return false;
        const installPrompt = deferredInstallPrompt;
        deferredInstallPrompt = null;
        await installPrompt.prompt();
        return (await installPrompt.userChoice).outcome === "accepted";
    };
}

function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("./sw.js").catch((error) => {
        console.warn("Service worker registration failed:", error);
    });
}

function saveAccountRewardState(patch) {
    accountRewardState = { ...accountRewardState, ...patch };
    if (!supabaseClient || !userSession.id) return;
    clearTimeout(rewardStateSaveTimer);
    rewardStateSaveTimer = setTimeout(async () => {
        try {
            await supabaseClient.auth.updateUser({ data: { kuzi_reward_state: accountRewardState } });
        } catch (error) {
            console.warn("Reward state sync deferred:", error);
        }
    }, 2000);
}

function hydrateAccountRewardState(state = {}) {
    accountRewardState = { ...(state || {}) };
    const localWatchlist = JSON.parse(localStorage.getItem(getLibraryKey("watchlist")) || "[]");
    const localHistory = JSON.parse(localStorage.getItem(getLibraryKey("history")) || "[]");
    const legacySpins = JSON.parse(localStorage.getItem("kuzi_daily_spins") || "null");
    const localSpins = JSON.parse(localStorage.getItem(getDailySpinStorageKey()) || "null");
    const localWatchRewards = JSON.parse(localStorage.getItem(`kuzi_watch_rewards_${userSession.id}`) || "null");
    const missions = { ...(state.missions || {}) };
    ["station1Btn", "station2Btn", "station3Btn"].forEach(id => {
        const value = Number(localStorage.getItem(getAdCooldownKey(id)) || 0);
        if (value) missions[id] = value;
    });
    const migration = {
        ...(Array.isArray(state.watchlist) ? {} : { watchlist: localWatchlist }),
        ...(Array.isArray(state.history) ? {} : { history: localHistory }),
        ...(state.dailySpins ? {} : ((localSpins || legacySpins) ? { dailySpins: localSpins || legacySpins } : {})),
        ...(state.watchRewards ? {} : (localWatchRewards ? { watchRewards: localWatchRewards } : {})),
        ...(Object.keys(missions).length ? { missions } : {})
    };
    accountRewardState = { ...accountRewardState, ...migration };
    if (Array.isArray(accountRewardState.watchlist)) localStorage.setItem(getLibraryKey("watchlist"), JSON.stringify(accountRewardState.watchlist));
    if (Array.isArray(accountRewardState.history)) localStorage.setItem(getLibraryKey("history"), JSON.stringify(accountRewardState.history));
    if (accountRewardState.dailySpins) localStorage.setItem(getDailySpinStorageKey(), JSON.stringify(accountRewardState.dailySpins));
    if (accountRewardState.watchRewards) localStorage.setItem(`kuzi_watch_rewards_${userSession.id}`, JSON.stringify(accountRewardState.watchRewards));
    Object.entries(accountRewardState.missions || {}).forEach(([id, cooldownUntil]) => {
        localStorage.setItem(getAdCooldownKey(id), String(cooldownUntil));
    });
    if (Object.keys(migration).length) saveAccountRewardState(migration);
}

function getAccountDownloads() {
    return Array.isArray(accountRewardState.downloads) ? accountRewardState.downloads : [];
}

function renderDownloads() {
    const downloads = getAccountDownloads();
    document.querySelectorAll(".downloads-list").forEach(list => {
        if (!downloads.length) {
            list.innerHTML = `
                <div class="downloads-empty">
                    <span aria-hidden="true">⇩</span>
                    <strong>No downloads yet</strong>
                    <p>Save a title from its details panel and it will appear here.</p>
                </div>`;
            return;
        }
        list.innerHTML = downloads.map(item => `
            <article class="download-item">
                <img src="${IMAGE_BASE_URL}${item.poster_path}" alt="">
                <div class="download-item-info">
                    <strong>${item.title}</strong>
                    <span>${item.categoryTag || "Title"} · Saved ${new Date(item.savedAt).toLocaleDateString()}</span>
                    <small>Account synced</small>
                </div>
                <button class="download-remove-btn" type="button" data-remove-download="${item.id}" aria-label="Remove ${item.title} from downloads">&times;</button>
            </article>`).join("");
        list.querySelectorAll("[data-remove-download]").forEach(button => {
            button.addEventListener("click", () => {
                const next = downloads.filter(item => String(item.id) !== String(button.dataset.removeDownload));
                accountRewardState.downloads = next;
                saveAccountRewardState({ downloads: next });
                renderDownloads();
            });
        });
    });
}

function setMobileDownloadsMode(isLoggedIn) {
    const tab = document.querySelector('[data-mobile-tab="auth"]');
    const label = document.querySelector("[data-mobile-auth-label]");
    const icon = document.querySelector("[data-mobile-auth-icon]");
    if (!tab || !label || !icon) return;
    label.innerText = isLoggedIn ? "Downloads" : "Login";
    icon.innerText = isLoggedIn ? "⇩" : "⎈";
    tab.dataset.mobileTab = isLoggedIn ? "downloads" : "auth";
    tab.setAttribute("aria-label", isLoggedIn ? "Downloads" : "Login");
}

function showSiteNotification(message) {
    let notification = document.getElementById("siteNotification");
    if (!notification) {
        notification = document.createElement("div");
        notification.id = "siteNotification";
        notification.className = "site-notification hidden";
        notification.innerHTML = `
            <div class="notification-character" aria-hidden="true">✦</div>
            <div class="notification-card">
                <strong class="notification-title">Kuzi Box</strong>
                <p class="notification-message"></p>
            </div>
            <button class="notification-close" type="button" aria-label="Close notification">&times;</button>
        `;
        document.body.appendChild(notification);
        notification.querySelector(".notification-close").addEventListener("click", () => notification.classList.add("hidden"));
    }

    notification.querySelector(".notification-message").textContent = message;
    notification.classList.remove("hidden");
    clearTimeout(notification.dismissTimer);
    notification.dismissTimer = setTimeout(() => notification.classList.add("hidden"), 5000);
}

window.alert = showSiteNotification;

function addNotification(message) {
    notificationItems.unshift({ message, time: new Date().toLocaleString() });
    notificationItems = notificationItems.slice(0, 20);
    localStorage.setItem("kuzi_notifications", JSON.stringify(notificationItems));
    const count = document.getElementById("notificationCount");
    if (count) {
        count.innerText = notificationItems.length;
        count.classList.remove("hidden");
    }
    renderNotifications();
}

function renderNotifications() {
    const list = document.getElementById("notificationsList");
    if (!list) return;
    list.innerHTML = notificationItems.length
    ? notificationItems.map((item, index) => `<div class="notification-item"><div><strong>Kuzi Box</strong><p>${item.message}</p><small>${item.time}</small></div><button class="notification-remove-btn" type="button" data-notification-index="${index}" aria-label="Remove notification">&times;</button></div>`).join("")
        : '<p class="empty-notifications">Your latest rewards and premieres will appear here.</p>';
}

function isAllowedContent(item, options = {}) {
    const childMode = localStorage.getItem("kuzi_child_mode") === "true";
    const restrictedGenres = [27, 53, 80, 10752];
    const isAdult = item?.adult === true || item?.adult === "true";
    const minimumRating = options.minimumRating ?? 6;
    const minimumVotes = options.minimumVotes ?? 20;
    return item && !isAdult && Number(item.vote_average || 0) >= minimumRating && Number(item.vote_count || 0) >= minimumVotes &&
        (!childMode || !(item.genre_ids || []).some(genreId => restrictedGenres.includes(genreId)));
}

// --- TMDB API CONFIGURATION ---
const TMDB_API_KEY = "f92f86fb452a865f657343e076f23d13";
const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500";

let heroItems = [];
let currentHeroIndex = 0;
let heroInterval = null;
let catalogRotationTimer = null;
let goldenSpinRotation = 0;
const mobileDiscoverCache = new Map();
let activeCatalogRequests = 0;
const catalogRequestWaiters = [];
const CATALOG_ROTATION_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const CATALOG_ROTATION_SORTS = ['popularity.desc', 'vote_average.desc', 'vote_count.desc', 'date.desc'];
let activeCatalogRotationSlot = Math.floor(Date.now() / CATALOG_ROTATION_WINDOW_MS);

function getCatalogRotationSlot(timestamp = Date.now()) {
    return Math.floor(timestamp / CATALOG_ROTATION_WINDOW_MS);
}

function getCatalogRotationConfig(offset = 0) {
    const slot = getCatalogRotationSlot();
    return {
        slot,
        page: ((slot + offset) % 4) + 1,
        sortBy: CATALOG_ROTATION_SORTS[(slot + offset) % CATALOG_ROTATION_SORTS.length]
    };
}

// Pagination & Infinite Scroll State
let currentCatalogPage = 1;
let currentSearchQuery = "";
let isFetchingMore = false;
let searchTimer = null; // Debounce timer for search

document.addEventListener("DOMContentLoaded", () => {
    setupInstallPrompt();
    registerServiceWorker();
    initAntiInspection();
    fetchAllCategoriesCatalog(); 
    buildWheelSegments();
    buildGoldenWheel();
    bindEventListeners();
    checkExistingSession();
    captureReferralCode();
    updateSpinButtonUI();
    initInfiniteScroll();
    startCatalogRotationWatcher();
});

function initAntiInspection() {
    document.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("keydown", (e) => {
        if (e.key === "F12" || (e.ctrlKey && e.shiftKey && (e.key === "I" || e.key === "J")) || (e.ctrlKey && e.key === "U")) {
            e.preventDefault();
        }
    });
}

function captureReferralCode() {
    const urlParams = new URLSearchParams(window.location.search);
    const ref = urlParams.get('ref');
    if (ref) localStorage.setItem('kuzi_ref_code', ref);
}

function sortByYearPriority(items) {
    return [...items].sort((a, b) => {
        const aYear = Number((a.release_date || a.first_air_date || '').slice(0, 4)) || 0;
        const bYear = Number((b.release_date || b.first_air_date || '').slice(0, 4)) || 0;
        if (bYear !== aYear) return bYear - aYear;
        return Number(b.popularity || 0) - Number(a.popularity || 0);
    });
}

function mapCategoryTag(groupKey) {
    const tags = {
        latest: 'Latest',
        trending: 'Trending',
        cdrama: 'C-Drama',
        kdrama: 'K-Drama',
        shows: 'TV Show',
        anime: 'Anime',
        southindian: 'South Indian',
        bollywood: 'Bollywood'
    };
    return tags[groupKey] || 'Movie';
}

function normalizeCategoryItems(items, fallbackMediaType = 'movie', groupKey = 'latest', options = {}) {
    return (items || [])
        .filter(item => isAllowedContent(item, options))
        .map(item => ({
            ...item,
            media_type: item.media_type || fallbackMediaType,
            isAnime: Boolean(item.isAnime || (item.genre_ids || []).includes(16)),
            content_group: groupKey,
            categoryTag: mapCategoryTag(groupKey)
        }));
}

async function fetchCollectionByQuery({ mediaType, params = {}, extraFilters = [], rotationOffset = 0, contentOptions = {} }) {
    const rotation = getCatalogRotationConfig(rotationOffset);
    const sortBy = rotation.sortBy === 'date.desc'
        ? (mediaType === 'tv' ? 'first_air_date.desc' : 'primary_release_date.desc')
        : rotation.sortBy;
    const query = new URLSearchParams({
        api_key: TMDB_API_KEY,
        sort_by: sortBy,
        'vote_average.gte': String(contentOptions.minimumRating ?? 6),
        'vote_count.gte': String(contentOptions.minimumVotes ?? 20),
        page: String(rotation.page)
    });

    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    });

    const url = `${TMDB_BASE_URL}/discover/${mediaType}?${query.toString()}`;
    while (activeCatalogRequests >= 3) {
        await new Promise(resolve => catalogRequestWaiters.push(resolve));
    }
    activeCatalogRequests++;
    try {
        const response = await fetch(url);
        if (!response.ok) return [];
        const data = await response.json();
        const items = (data.results || []).filter(item => isAllowedContent(item, contentOptions)).map(item => ({
            ...item,
            media_type: mediaType,
            isAnime: Boolean(item.isAnime || (item.genre_ids || []).includes(16))
        }));

        return extraFilters.length ? items.filter(item => extraFilters.every(filter => filter(item))) : items;
    } catch (error) {
        console.warn("Catalog category unavailable:", mediaType, error);
        return [];
    } finally {
        activeCatalogRequests--;
        catalogRequestWaiters.shift()?.();
    }
}

async function fetchAllCategoriesCatalog() {
    try {
        const latestDate = new Date().toISOString().slice(0, 10);
        const recentDate = `${new Date().getFullYear() - 2}-01-01`;

        const [latestMovies, latestTv, trendingMovies, trendingTv, cDrama, kDrama, tvShows, anime, southIndian, bollywood] = await Promise.all([
            fetchCollectionByQuery({
                mediaType: 'movie',
                rotationOffset: 0,
                contentOptions: { minimumVotes: 5, minimumRating: 5 },
                params: {
                    sort_by: 'primary_release_date.desc',
                    page: String((getCatalogRotationSlot() % 2) + 1),
                    'primary_release_date.gte': recentDate,
                    'primary_release_date.lte': latestDate
                }
            }),
            fetchCollectionByQuery({
                mediaType: 'tv',
                rotationOffset: 1,
                contentOptions: { minimumVotes: 5, minimumRating: 5 },
                params: {
                    sort_by: 'first_air_date.desc',
                    page: String(((getCatalogRotationSlot() + 1) % 2) + 1),
                    'first_air_date.gte': recentDate,
                    'first_air_date.lte': latestDate
                }
            }),
            fetchCollectionByQuery({
                mediaType: 'movie',
                rotationOffset: 2,
                params: {
                    'primary_release_date.gte': `${new Date().getFullYear() - 4}-01-01`,
                    'vote_average.gte': 7
                }
            }),
            fetchCollectionByQuery({
                mediaType: 'tv',
                rotationOffset: 3,
                params: {
                    'first_air_date.gte': `${new Date().getFullYear() - 4}-01-01`,
                    'vote_average.gte': 7
                }
            }),
            fetchCollectionByQuery({
                mediaType: 'tv',
                rotationOffset: 4,
                params: { with_origin_country: 'CN', with_original_language: 'zh' },
                extraFilters: [item => !((item.genre_ids || []).includes(16))]
            }),
            fetchCollectionByQuery({
                mediaType: 'tv',
                rotationOffset: 5,
                params: { with_origin_country: 'KR', with_original_language: 'ko' },
                extraFilters: [item => !((item.genre_ids || []).includes(16))]
            }),
            fetchCollectionByQuery({
                mediaType: 'tv',
                rotationOffset: 6,
                params: { with_origin_country: 'US' },
                extraFilters: [item => !((item.genre_ids || []).includes(16))]
            }),
            fetchCollectionByQuery({
                mediaType: 'tv',
                rotationOffset: 7,
                params: { with_genres: 16, with_origin_country: 'JP', with_original_language: 'ja' },
                extraFilters: [item => (item.genre_ids || []).includes(16)]
            }),
            fetchCollectionByQuery({
                mediaType: 'movie',
                rotationOffset: 8,
                contentOptions: { minimumVotes: 2, minimumRating: 4.5 },
                params: {
                    with_origin_country: 'IN',
                    sort_by: 'primary_release_date.desc',
                    page: String((getCatalogRotationSlot() % 2) + 1),
                    'primary_release_date.gte': `${new Date().getFullYear() - 4}-01-01`,
                    'primary_release_date.lte': latestDate
                },
                extraFilters: [item => ['ta', 'te', 'ml', 'kn'].includes(String(item.original_language || '').toLowerCase())]
            }),
            fetchCollectionByQuery({
                mediaType: 'movie',
                rotationOffset: 9,
                contentOptions: { minimumVotes: 2, minimumRating: 4.5 },
                params: {
                    with_original_language: 'hi',
                    with_origin_country: 'IN',
                    sort_by: 'primary_release_date.desc',
                    page: String(((getCatalogRotationSlot() + 1) % 2) + 1),
                    'primary_release_date.gte': `${new Date().getFullYear() - 4}-01-01`,
                    'primary_release_date.lte': latestDate
                },
                extraFilters: [item => String(item.original_language || '').toLowerCase() === 'hi']
            })
        ]);

        const latestList = sortByYearPriority([
            ...normalizeCategoryItems(latestMovies, 'movie', 'latest', { minimumVotes: 5, minimumRating: 5 }),
            ...normalizeCategoryItems(latestTv, 'tv', 'latest', { minimumVotes: 5, minimumRating: 5 })
        ]).slice(0, 18);
        const trendingList = sortByYearPriority([
            ...normalizeCategoryItems(trendingMovies, 'movie', 'trending'),
            ...normalizeCategoryItems(trendingTv, 'tv', 'trending')
        ]).slice(0, 18);
        const cDramaList = sortByYearPriority(normalizeCategoryItems(cDrama, 'tv', 'cdrama')).slice(0, 18);
        const kDramaList = sortByYearPriority(normalizeCategoryItems(kDrama, 'tv', 'kdrama')).slice(0, 18);
        const showsList = sortByYearPriority(normalizeCategoryItems(tvShows, 'tv', 'shows')).slice(0, 18);
        const animeList = sortByYearPriority(normalizeCategoryItems(anime, 'tv', 'anime')).slice(0, 18);
        const southIndianList = sortByYearPriority(normalizeCategoryItems(southIndian, 'movie', 'southindian', { minimumVotes: 2, minimumRating: 4.5 })).slice(0, 18);
        const bollywoodList = sortByYearPriority(normalizeCategoryItems(bollywood, 'movie', 'bollywood', { minimumVotes: 2, minimumRating: 4.5 })).slice(0, 18);

        heroItems = [...latestList, ...trendingList, ...cDramaList, ...kDramaList].slice(0, 8);
        if (heroItems.length > 0) {
            setupHeroBanner(heroItems[0]);
            startHeroAutoplay();
        }

        renderMovieRow('latestGrid', latestList, false);
        renderMovieRow('trendingGrid', trendingList, false);
        renderMovieRow('cdramaGrid', cDramaList, false);
        renderMovieRow('kdramaGrid', kDramaList, false);
        renderMovieRow('showsGrid', showsList, false);
        renderMovieRow('animeGrid', animeList, false);
        renderMovieRow('southindianGrid', southIndianList, false);
        renderMovieRow('bollywoodGrid', bollywoodList, false);

        const today = new Date().toDateString();
        if (localStorage.getItem('kuzi_last_content_notice') !== today) {
            localStorage.setItem('kuzi_last_content_notice', today);
            addNotification('Fresh premium titles are live across your favorite categories.');
        }
    } catch (error) {
        console.error('Error fetching catalog:', error);
    }
}

function startCatalogRotationWatcher() {
    clearInterval(catalogRotationTimer);
    catalogRotationTimer = setInterval(() => {
        const nextSlot = getCatalogRotationSlot();
        if (nextSlot === activeCatalogRotationSlot || isFetchingMore) return;
        activeCatalogRotationSlot = nextSlot;
        fetchAllCategoriesCatalog();
    }, 60 * 60 * 1000);
}

function getVisibleCategoryMeta(item) {
    if (item?.categoryTag) return item.categoryTag;
    if (item?.content_group) return mapCategoryTag(item.content_group);

    const language = String(item.original_language || '').toLowerCase();
    const genres = item.genre_ids || [];

    if (item.isAnime || genres.includes(16)) return 'Anime';
    if (item.media_type === 'tv' && language === 'ko') return 'K-Drama';
    if (item.media_type === 'tv' && language === 'zh') return 'C-Drama';
    if (item.media_type === 'movie' && ['hi', 'bn', 'mr', 'ta', 'te', 'ml', 'kn', 'gu'].includes(language)) return 'Bollywood';
    if (item.media_type === 'tv' && ['ta', 'te', 'ml', 'kn'].includes(language)) return 'South Indian';
    if (item.media_type === 'tv') return 'TV Show';
    return 'Movie';
}

function getSectionCategoryTitle(categoryKey) {
    const titles = {
        latest: 'Latest',
        trending: 'Trending',
        cdrama: 'C-Drama',
        kdrama: 'K-Drama',
        shows: 'TV & Shows',
        anime: 'Anime',
        southindian: 'South Indian',
        bollywood: 'Bollywood'
    };
    return titles[categoryKey] || 'Movie';
}

function renderMovieRow(containerId, movieList, append = false) {
    const grid = document.getElementById(containerId);
    if (!grid) return;

    if (!append) {
        grid.innerHTML = '';
    }

    if (movieList.length === 0 && !append) {
        grid.innerHTML = '<p style="color:#64748b; font-size:13px; padding:10px;">No content found.</p>';
        return;
    }

    movieList.forEach(item => {
        if (!item.poster_path) return;

        const title = item.title || item.name;
        const categoryTag = getVisibleCategoryMeta(item);
        const yearLabel = (item.release_date || item.first_air_date || '').slice(0, 4) || 'N/A';

        const card = document.createElement('div');
        card.className = 'movie-card';
        card.innerHTML = `
            <img src="${IMAGE_BASE_URL}${item.poster_path}" alt="${title}">
            <div class="card-details">
                <h4>${title}</h4>
                <div class="card-meta"><span>⭐ ${item.vote_average ? item.vote_average.toFixed(1) : 'N/A'}</span><span>${categoryTag}</span></div>
                <div class="card-year">${yearLabel}</div>
                <button class="card-watchlist-btn" type="button">${isInWatchlist(item.id) ? '♥ Saved' : '♡ Watchlist'}</button>
            </div>
        `;
        card.addEventListener('click', () => openOverviewModal(item, categoryTag));
        card.querySelector('.card-watchlist-btn').addEventListener('click', event => {
            event.stopPropagation();
            if (isInWatchlist(item.id)) removeLibraryItem('watchlist', item.id);
            else saveLibraryItem('watchlist', item, categoryTag);
            event.currentTarget.innerText = isInWatchlist(item.id) ? '♥ Saved' : '♡ Watchlist';
        });
        grid.appendChild(card);
    });
}

async function loadMobileDiscoverCategory(category) {
    const content = document.getElementById("mobileDiscoverContent");
    if (!content) return;

    if (mobileDiscoverCache.has(category)) {
        content.innerHTML = "";
        renderMovieRow("mobileDiscoverContent", mobileDiscoverCache.get(category));
        return;
    }

    content.innerHTML = '<p style="color:#94a3b8; padding:12px 0;">Loading titles...</p>';

    try {
        let items = [];
        if (category === "top-picks") {
            const [movies, shows] = await Promise.all([
                fetchCollectionByQuery({ mediaType: "movie", params: { vote_average: 7 } }),
                fetchCollectionByQuery({ mediaType: "tv", params: { vote_average: 7 } })
            ]);
            items = [...movies, ...shows];
        } else if (category === "k-drama") {
            items = await fetchCollectionByQuery({
                mediaType: "tv",
                params: { with_origin_country: "KR", with_original_language: "ko" }
            });
        } else if (category === "anime") {
            items = await fetchCollectionByQuery({
                mediaType: "tv",
                params: { with_genres: 16, with_original_language: "ja" }
            });
        } else {
            items = await fetchCollectionByQuery({ mediaType: "movie", params: { vote_average: 7 } });
        }

        items = sortByYearPriority(items).slice(0, 12).map(item => ({
            ...item,
            categoryTag: category === "k-drama" ? "K-Drama" : category === "anime" ? "Anime" : "Movie"
        }));
        mobileDiscoverCache.set(category, items);
        content.innerHTML = "";
        renderMovieRow("mobileDiscoverContent", items);
    } catch (error) {
        console.error("Error loading mobile discover category:", error);
        content.innerHTML = '<p style="color:#fca5a5; padding:12px 0;">Unable to load titles right now.</p>';
    }
}

function setSearchModeState(isActive, query = "") {
    const heroBannerEl = document.querySelector(".hero-banner") || document.getElementById("heroBackdrop")?.parentElement;
    if (heroBannerEl) heroBannerEl.style.display = isActive ? "none" : "";

    document.body.classList.toggle("search-mode", isActive);

    const searchSection = document.getElementById("trendingGrid")?.closest(".category-section");
    document.querySelectorAll(".category-section").forEach(section => {
        const shouldShow = !isActive || section === searchSection;
        section.classList.toggle("search-results-section", isActive && section === searchSection);
        section.style.display = shouldShow ? "block" : "none";
    });

    if (searchSection) {
        const title = searchSection.querySelector("h3");
        if (title) {
            title.innerText = isActive ? `🔍 Search Results for "${query}"` : `🔥 Trending`;
        }
    }
}

// --- SEARCH FUNCTION WITH CLEAN HERO HIDING ---
async function searchAllContent(query) {
    if (!query || query.length < 3) return;
    currentSearchQuery = query;
    currentCatalogPage = 1;

    try {
        if (searchController) searchController.abort();
        searchController = new AbortController();
        const response = await fetch(`${TMDB_BASE_URL}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&page=1`, { signal: searchController.signal });
        const data = await response.json();
        const filteredResults = (data.results || []).filter(item => (item.media_type === 'movie' || item.media_type === 'tv') && isAllowedContent(item));

        renderMovieRow("trendingGrid", filteredResults, false);
        setSearchModeState(true, query);

    } catch (err) {
        if (err.name === "AbortError") return;
        console.error("Error searching content:", err);
    }
}

// --- INFINITE SCROLL LOGIC ---
function initInfiniteScroll() {
    window.addEventListener("scroll", async () => {
        if (isFetchingMore) return;
        
        const { scrollTop, scrollHeight, clientHeight } = document.documentElement;
        if (scrollTop + clientHeight >= scrollHeight - 300) {
            isFetchingMore = true;
            currentCatalogPage++;

            if (currentSearchQuery) {
                try {
                    const res = await fetch(`${TMDB_BASE_URL}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(currentSearchQuery)}&page=${currentCatalogPage}`);
                    const data = await res.json();
                    const moreResults = (data.results || []).filter(item => (item.media_type === 'movie' || item.media_type === 'tv') && isAllowedContent(item));
                    if (moreResults.length > 0) {
                        renderMovieRow("trendingGrid", moreResults, true);
                    }
                } catch (e) {
                    console.error("Error loading more search results", e);
                }
            } else {
                try {
                    const latestDate = new Date().toISOString().slice(0, 10);
                    const recentDate = `${new Date().getFullYear() - 2}-01-01`;
                    const res = await fetch(`${TMDB_BASE_URL}/discover/movie?api_key=${TMDB_API_KEY}&sort_by=popularity.desc&vote_average.gte=6&vote_count.gte=20&primary_release_date.gte=${recentDate}&primary_release_date.lte=${latestDate}&page=${currentCatalogPage}`);
                    const data = await res.json();
                    const moreMovies = (data.results || []).filter(isAllowedContent).map(item => ({ ...item, media_type: 'movie' }));
                    if (moreMovies.length > 0) {
                        renderMovieRow("trendingGrid", moreMovies, true);
                    }
                } catch (e) {
                    console.error("Error loading more catalog items", e);
                }
            }
            isFetchingMore = false;
        }
    });
}

function setupHeroBanner(item) {
    const title = item.title || item.name;
    const backdropPath = item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : '';
    
    const backdropEl = document.getElementById("heroBackdrop");
    if (backdropEl) {
        backdropEl.style.backgroundImage = `url(${backdropPath})`;
        backdropEl.style.setProperty('--hero-image', `url(${backdropPath})`);
    }
    
    const heroTitle = document.getElementById("heroTitle");
    heroTitle.innerText = title;
    heroTitle.classList.toggle("hero-title-long", title.length > 20 || title.trim().split(/\s+/).length >= 4);
    document.getElementById("heroRating").innerText = `⭐ ${item.vote_average ? item.vote_average.toFixed(1) : 'N/A'}`;
    document.getElementById("heroCategory").innerText = item.media_type === 'movie' ? 'Blockbuster Movie' : 'TV / Series';
    document.getElementById("heroSynopsis").innerText = item.overview || "No overview available.";
    
    const heroBanner = document.getElementById("heroBanner");
    if (heroBanner) {
        const openFeaturedTitle = () => openOverviewModal(item, item.media_type === 'movie' ? 'Movie' : 'TV Show');
        heroBanner.onclick = openFeaturedTitle;
        heroBanner.onkeydown = (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openFeaturedTitle();
            }
        };
        heroBanner.setAttribute('aria-label', `Open featured title: ${title}`);
    }
}

function startHeroAutoplay() {
    if (heroInterval) clearInterval(heroInterval);
    heroInterval = setInterval(() => {
        if (heroItems.length === 0) return;
        currentHeroIndex = (currentHeroIndex + 1) % heroItems.length;
        setupHeroBanner(heroItems[currentHeroIndex]);
    }, 6000);
}

function getLibraryKey(type) {
    const owner = userSession.id || "guest";
    return `kuzi_${type}_${owner}`;
}

function getLibraryItems(type) {
    try {
        return JSON.parse(localStorage.getItem(getLibraryKey(type)) || "[]");
    } catch (error) {
        return [];
    }
}

function saveLibraryItem(type, item, categoryTag) {
    if (!item?.id || !item.poster_path) return;
    const entry = {
        id: item.id,
        title: item.title || item.name,
        poster_path: item.poster_path,
        overview: item.overview || "No synopsis available.",
        vote_average: Number(item.vote_average || 0),
        media_type: item.media_type || "movie",
        isAnime: Boolean(item.isAnime),
        categoryTag,
        savedAt: Date.now()
    };
    const items = getLibraryItems(type).filter(saved => saved.id !== entry.id);
    items.unshift(entry);
    localStorage.setItem(getLibraryKey(type), JSON.stringify(items.slice(0, 50)));
    renderLibraryUI();
    saveAccountRewardState({ [type]: items.slice(0, 50) });
    window.dispatchEvent(new CustomEvent("kuzi-library-state-changed", { detail: { type } }));
}

function removeLibraryItem(type, itemId) {
    const items = getLibraryItems(type).filter(item => item.id !== itemId);
    localStorage.setItem(getLibraryKey(type), JSON.stringify(items));
    renderLibraryUI();
    saveAccountRewardState({ [type]: items });
    window.dispatchEvent(new CustomEvent("kuzi-library-state-changed", { detail: { type } }));
}

function isInWatchlist(itemId) {
    return getLibraryItems("watchlist").some(item => item.id === itemId);
}

function applyViewMode(section, mode) {
    const grid = section?.querySelector(".movie-row-grid");
    if (!grid) return;
    const isGrid = mode === "grid";
    grid.classList.toggle("grid-mode", isGrid);
    section.querySelectorAll("[data-view-mode]").forEach(button => {
        const active = button.dataset.viewMode === mode;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
    });
}

function bindViewModeControls() {
    document.querySelectorAll(".category-section[data-row-category]").forEach(section => {
        const category = section.dataset.rowCategory;
        const savedMode = localStorage.getItem(`kuzi_view_mode_${category}`) || "row";
        applyViewMode(section, savedMode);
        section.querySelectorAll("[data-view-mode]").forEach(button => {
            button.addEventListener("click", () => {
                const mode = button.dataset.viewMode;
                localStorage.setItem(`kuzi_view_mode_${category}`, mode);
                applyViewMode(section, mode);
            });
        });
    });
}

function renderLibraryUI() {
    const watchlist = getLibraryItems("watchlist");
    const history = getLibraryItems("history");
    const watchlistCount = document.getElementById("watchlistCount");
    const historyCount = document.getElementById("historyCount");
    if (watchlistCount) watchlistCount.innerText = watchlist.length;
    if (historyCount) historyCount.innerText = history.length;

    ["watchlist", "history"].forEach(type => {
        const grid = document.getElementById(`${type}Library`);
        if (!grid) return;
        const items = type === "watchlist" ? watchlist : history;
        grid.innerHTML = items.length ? "" : `<p class="library-empty">${type === "watchlist" ? "Save titles here to watch later." : "Your recently played titles will appear here."}</p>`;
        items.forEach(item => {
            const card = document.createElement("button");
            card.type = "button";
            card.className = "library-card";
            card.innerHTML = `<img src="${IMAGE_BASE_URL}${item.poster_path}" alt=""><span>${item.title}</span><small>${item.categoryTag || "Title"}</small>`;
            card.addEventListener("click", () => openOverviewModal(item, item.categoryTag || "Movie"));
            grid.appendChild(card);
        });
    });
}

const wheelSegments = [
    { text: "1 KC",  amount: 1,  centerAngle: 30  },
    { text: "3 KC",  amount: 3,  centerAngle: 90  },
    { text: "5 KC",  amount: 5,  centerAngle: 150 }, 
    { text: "10 KC", amount: 10, centerAngle: 210 },
    { text: "0 KC",  amount: 0,  centerAngle: 270 },
    { text: "2 KC",  amount: 2,  centerAngle: 330 }
];

const goldenWheelSegments = [
    { text: "10 KC", amount: 10, centerAngle: 30 },
    { text: "20 KC", amount: 20, centerAngle: 90 },
    { text: "50 KC", amount: 50, centerAngle: 150 },
    { text: "VIP", amount: "vip", centerAngle: 210 },
    { text: "15 KC", amount: 15, centerAngle: 270 },
    { text: "30 KC", amount: 30, centerAngle: 330 }
];

function buildWheelSegments() {
    const wheel = document.getElementById("wheel");
    if (!wheel) return;
    wheel.innerHTML = "";
    wheelSegments.forEach(item => {
        const label = document.createElement("div");
        label.className = "wheel-label";
        label.style.transform = `rotate(${item.centerAngle}deg) translateY(-68px) rotate(-${item.centerAngle}deg)`;
        label.innerText = item.text;
        wheel.appendChild(label);
    });
}

function buildGoldenWheel() {
    const wheel = document.getElementById("goldenWheel");
    if (!wheel) return;
    wheel.innerHTML = "";
    goldenWheelSegments.forEach(item => {
        const label = document.createElement("div");
        label.className = "golden-wheel-label";
        label.style.transform = `rotate(${item.centerAngle}deg) translateY(-56px) rotate(-${item.centerAngle}deg)`;
        label.innerText = item.text;
        wheel.appendChild(label);
    });
}

async function checkExistingSession() {
    if (!supabaseClient) return;
    const { data: { session } = {} } = await supabaseClient.auth.getSession();
    if (session?.user) await fetchUserProfile(session.user);
    supabaseClient.auth.onAuthStateChange((_event, nextSession) => {
        window.setTimeout(() => {
            if (nextSession?.user) {
                if (userSession.id === nextSession.user.id) return;
                fetchUserProfile(nextSession.user).catch((error) => {
                    console.error("Authenticated profile setup failed:", error);
                    applyAuthenticatedUI(nextSession.user);
                });
            } else if (userSession.id) {
                window.location.reload();
            }
        }, 0);
    });
}

const authModal = document.getElementById("authModal");
const openLoginModal = document.getElementById("openLoginModal");
const openSignupModal = document.getElementById("openSignupModal");
const closeAuthModal = document.getElementById("closeAuthModal");
const authModalTitle = document.getElementById("authModalTitle");
const modalActionBtn = document.getElementById("modalActionBtn");
let authMode = "login";

function openAuthModal(mode) {
    authMode = mode;
    authModalTitle.innerText = mode === "signup" ? "Create your Kuzi Box account" : "Login to Kuzi Box";
    modalActionBtn.innerText = mode === "signup" ? "Sign Up" : "Login";
    authModal.classList.remove("hidden");
}

function closeMobileAuthAfterLogin() {
    document.body.classList.remove("mobile-auth-open");
    document.getElementById("mobileAuthView")?.classList.add("hidden");
    document.querySelectorAll("[data-mobile-tab]").forEach(item => item.classList.toggle("active", item.dataset.mobileTab === "home"));
    document.querySelector('[data-mobile-tab="auth"]')?.classList.add("hidden");
}

openLoginModal?.addEventListener("click", () => openAuthModal("login"));
openSignupModal?.addEventListener("click", () => openAuthModal("signup"));
closeAuthModal?.addEventListener("click", () => authModal.classList.add("hidden"));

modalActionBtn.addEventListener("click", async () => {
    const email = document.getElementById("authEmail").value.trim();
    const password = document.getElementById("authPassword").value.trim();
    if (!email || !password) return alert("Please enter both email address and password.");
    if (!supabaseClient) return alert("Authentication service is currently unavailable.");

    try {
        const { data, error } = authMode === "signup"
            ? await supabaseClient.auth.signUp({ email, password })
            : await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;

        if (authMode === "signup") {
            const savedRef = localStorage.getItem('kuzi_ref_code');
            if (savedRef && data.user) {
                localStorage.setItem(`kuzi_pending_referral_${data.user.id}`, savedRef);
                localStorage.removeItem('kuzi_ref_code');
            }
            alert("Account registered successfully! You may now log in.");
        } else if (data.user) {
            const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
            if (sessionError) throw sessionError;
            if (!sessionData?.session?.user) throw new Error("Login succeeded but no active session was returned.");
            await fetchUserProfile(sessionData.session.user);
            authModal.classList.add("hidden");
            alert("Authentication successful. Welcome to Kuzi Box!");
        }
    } catch (err) {
        alert((authMode === "signup" ? "Registration Failed: " : "Login Failed: ") + err.message);
    }
});

window.addEventListener("click", (event) => {
    if (event.target === authModal) {
        authModal.classList.add("hidden");
    }
});

async function fetchUserProfile(user) {
    userSession.id = user.id;
    hydrateAccountRewardState(user.user_metadata?.kuzi_reward_state || {});
    setMobileDownloadsMode(true);
    renderDownloads();
    userSession.email = user.email;
    userSession.username = user.email?.split('@')[0] || "User";

    const { data, error: profileError } = await supabaseClient.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (profileError) console.warn("Profile hydration failed; continuing with session state:", profileError);
    if (data) {
        userSession.kuziCoins = data.kuzi_coins ?? 10;
        userSession.isVip = data.is_vip ?? false;
        userSession.lastSpinTime = data.last_spin_time || null;
        const vipExpiryKey = `kuzi_vip_expires_${user.id}`;
        const vipActivatedKey = `kuzi_vip_activated_${user.id}`;
        let vipExpiry = Number(localStorage.getItem(vipExpiryKey) || 0);
        const vipActivatedAt = Number(localStorage.getItem(vipActivatedKey) || 0);
        const serverVipActivatedAt = Number(user.user_metadata?.kuzi_vip_activated_at || 0);
        if (!vipExpiry && serverVipActivatedAt) {
            vipExpiry = serverVipActivatedAt + 7 * 24 * 60 * 60 * 1000;
            localStorage.setItem(vipActivatedKey, String(serverVipActivatedAt));
            localStorage.setItem(vipExpiryKey, String(vipExpiry));
        }
        if (userSession.isVip && !vipExpiry && vipActivatedAt) {
            vipExpiry = vipActivatedAt + 7 * 24 * 60 * 60 * 1000;
            localStorage.setItem(vipExpiryKey, String(vipExpiry));
        }
        if (userSession.isVip && vipExpiry && !serverVipActivatedAt && vipActivatedAt) {
            await supabaseClient.auth.updateUser({ data: { kuzi_vip_activated_at: vipActivatedAt } });
        }
        if (userSession.isVip && vipExpiry && Date.now() >= vipExpiry) {
            userSession.isVip = false;
            localStorage.removeItem(vipExpiryKey);
            await supabaseClient.from("profiles").update({ is_vip: false }).eq("id", user.id);
        }
        const localStreak = getStreakState();
        const serverLastCheckin = data.last_checkin || (data.streak_count && localStreak.lastClaimDate ? localStreak.lastClaimDate : "");
        userSession.streakCount = data.streak_count ?? 0;
        if (serverLastCheckin) {
            saveStreakState({ count: userSession.streakCount, lastClaimDate: serverLastCheckin });
            if (!data.last_checkin && supabaseClient) {
                await supabaseClient.from("profiles").update({ last_checkin: serverLastCheckin }).eq("id", user.id);
            }
        }
        userSession.refCode = data.referral_code ?? "";
        userSession.username = data.username ?? userSession.username;
        localStorage.setItem(`kuzi_reward_coins_${user.id}`, String(userSession.kuziCoins));
        saveRewardSnapshot(user.id);
        updateUI();
    } else {
        const snapshot = JSON.parse(localStorage.getItem(`kuzi_reward_snapshot_${user.id}`) || "null");
        if (snapshot) {
            userSession.kuziCoins = Number(snapshot.kuziCoins ?? userSession.kuziCoins);
            userSession.isVip = Boolean(snapshot.isVip);
            updateUI();
        }
    }

    applyAuthenticatedUI(user);
    closeMobileAuthAfterLogin();
    updateUI();

}

function applyAuthenticatedUI(user) {
    const authButtons = document.getElementById("authButtonsGroup");
    const profileButton = document.getElementById("userProfile");
    const profileLabelEl = document.getElementById("userAvatarTitle");
    authButtons?.classList.add("hidden");
    profileButton?.classList.remove("hidden");
    if (profileLabelEl) profileLabelEl.innerText = userSession.username || user?.user_metadata?.username || user?.email?.split("@")[0] || "User";
}

async function syncCoinsToDatabase(newBalance) {
    userSession.kuziCoins = newBalance;
    updateUI();
    if (userSession.id) {
        localStorage.setItem(`kuzi_reward_coins_${userSession.id}`, String(newBalance));
        saveRewardSnapshot(userSession.id);
    }
    window.dispatchEvent(new CustomEvent("kuzi-reward-state-changed", { detail: { type: "coins" } }));
    if (userSession.id && supabaseClient) {
        await supabaseClient.from('profiles').update({ kuzi_coins: newBalance }).eq('id', userSession.id);
    }
}

function saveRewardSnapshot(accountId = userSession.id) {
    if (!accountId) return;
    localStorage.setItem(`kuzi_reward_snapshot_${accountId}`, JSON.stringify({
        kuziCoins: userSession.kuziCoins,
        isVip: userSession.isVip,
        savedAt: Date.now()
    }));
}

function updateUI() {
    document.getElementById("navBalance").innerText = userSession.kuziCoins;
    document.getElementById("vaultBalanceDisplay").innerText = `${userSession.kuziCoins} KuziCoin`;
    const mobileRewardBalance = document.getElementById("mobileRewardBalance");
    if (mobileRewardBalance) mobileRewardBalance.innerText = userSession.kuziCoins;
    document.getElementById("streakDisplay").innerText = `🔥 ${userSession.streakCount} Days`;
    document.getElementById("drawerEmail").innerText = userSession.email || "-";
    document.getElementById("drawerCoins").innerText = userSession.kuziCoins;
    updateVipStatusLabel();
    document.getElementById("refLinkInput").value = `${window.location.origin}?ref=${userSession.refCode}`;
    const referralStatus = document.getElementById("referralRewardStatus");
    if (referralStatus && userSession.refCode) {
        referralStatus.innerText = "Your friend receives 10 KuziCoin after completing 1 hour of streaming. You receive 5 KuziCoin automatically.";
    }
    renderStreakGrid();
    updateSpinButtonUI();
    updateAdMissionUI();
    updateWatchRewardUI();
    updateGoldenSpinUI();
    updateVipCountdown();
}

function updateVipStatusLabel(statusText = null) {
    const status = document.getElementById("drawerVip");
    if (!status) return;
    if (statusText) {
        status.innerText = statusText;
        return;
    }
    const expiry = Number(localStorage.getItem(`kuzi_vip_expires_${userSession.id}`) || 0);
    status.innerText = userSession.isVip && (!expiry || Date.now() < expiry) ? "Active" : "Inactive";
}

async function saveVipActivation(accountId = userSession.id) {
    const activatedAt = Date.now();
    const expiry = activatedAt + 7 * 24 * 60 * 60 * 1000;
    localStorage.setItem(`kuzi_vip_activated_${accountId}`, String(activatedAt));
    localStorage.setItem(`kuzi_vip_expires_${accountId}`, String(expiry));
    if (supabaseClient) {
        await supabaseClient.auth.updateUser({ data: { kuzi_vip_activated_at: activatedAt } });
    }
    saveRewardSnapshot(accountId);
    window.dispatchEvent(new CustomEvent("kuzi-reward-state-changed", { detail: { type: "vip" } }));
}

function formatVipDate(timestamp) {
    return new Date(timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function updateVipCountdown() {
    const countdown = document.getElementById("vipCountdown");
    const button = document.getElementById("buyVipBtn");
    const dates = document.getElementById("vipDates");
    if (!countdown || !button) return;
    const expiry = Number(localStorage.getItem(`kuzi_vip_expires_${userSession.id}`) || 0);
    const activatedAt = Number(localStorage.getItem(`kuzi_vip_activated_${userSession.id}`) || 0);
    if (!userSession.isVip || !expiry) {
        const statusText = userSession.isVip ? "Active (expiry not recorded)" : "Inactive";
        countdown.innerText = userSession.isVip ? "VIP Pass: Active, expiry not recorded" : "VIP Pass: Not active";
        if (dates) dates.innerText = userSession.isVip ? "Exact expiry is unavailable for this older activation." : "Activation and expiry details will appear here.";
        updateVipStatusLabel(statusText);
        button.innerText = "👑 Unlock 7-Day VIP · 50 KuziCoin";
        if (vipTimerInterval) {
            clearInterval(vipTimerInterval);
            vipTimerInterval = null;
        }
        return;
    }

    const updateRemaining = () => {
        const remaining = Math.max(0, expiry - Date.now());
        if (remaining <= 0) {
            userSession.isVip = false;
            localStorage.removeItem(`kuzi_vip_expires_${userSession.id}`);
            countdown.innerText = "VIP Pass: Expired";
            if (dates) dates.innerText = `Expired: ${formatVipDate(expiry)}`;
            updateVipStatusLabel("Expired");
            button.innerText = "👑 Unlock 7-Day VIP · 50 KuziCoin";
            if (vipTimerInterval) clearInterval(vipTimerInterval);
            vipTimerInterval = null;
            if (supabaseClient && userSession.id) supabaseClient.from("profiles").update({ is_vip: false }).eq("id", userSession.id);
            saveRewardSnapshot(userSession.id);
            return;
        }
        const totalHours = Math.floor(remaining / 3600000);
        const days = Math.floor(totalHours / 24);
        const hours = totalHours % 24;
        const minutes = Math.floor((remaining % 3600000) / 60000);
        const seconds = Math.floor((remaining % 60000) / 1000);
        countdown.innerText = `VIP Pass active: ${days}d ${hours}h ${minutes}m ${seconds}s remaining`;
        if (dates) dates.innerText = `Activated: ${activatedAt ? formatVipDate(activatedAt) : "Previous activation"} · Expires: ${formatVipDate(expiry)}`;
        updateVipStatusLabel(`Active · ${days}d ${hours}h ${minutes}m ${seconds}s left`);
        button.innerText = `👑 VIP Active · ${days}d ${hours}h left`;
    };
    updateRemaining();
    if (!vipTimerInterval) vipTimerInterval = setInterval(updateRemaining, 1000);
}

function getNextMidnightTimestamp() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0);
    return next.getTime();
}

function formatResetTimer(msLeft) {
    const totalSeconds = Math.max(0, Math.ceil(msLeft / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
}

function updateDailyResetTimers() {
    const streakTimerEl = document.getElementById('streakResetTimer');
    const mobileStreakTimerEl = document.getElementById('mobileStreakResetTimer');
    const watchTimerEl = document.getElementById('watchRewardResetTimer');
    const remaining = Math.max(0, getNextMidnightTimestamp() - Date.now());
    const timerText = `Daily reset in ${formatResetTimer(remaining)}`;

    if (streakTimerEl) streakTimerEl.innerText = timerText;
    if (mobileStreakTimerEl) mobileStreakTimerEl.innerText = timerText;
    if (watchTimerEl) watchTimerEl.innerText = timerText;
}

function getStreakState() {
    const key = userSession.id ? `kuzi_streak_${userSession.id}` : "kuzi_streak_guest";
    const stored = JSON.parse(localStorage.getItem(key) || '{"count":0,"lastClaimDate":""}');
    return {
        count: Number(stored.count || 0),
        lastClaimDate: stored.lastClaimDate || ""
    };
}

function saveStreakState(state) {
    const key = userSession.id ? `kuzi_streak_${userSession.id}` : "kuzi_streak_guest";
    localStorage.setItem(key, JSON.stringify({
        count: Number(state.count || 0),
        lastClaimDate: state.lastClaimDate || ""
    }));
    userSession.streakCount = Number(state.count || 0);
}

function getDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getDayDiffDays(fromDateKey, toDateKey) {
    const from = new Date(`${fromDateKey}T00:00:00`);
    const to = new Date(`${toDateKey}T00:00:00`);
    return Math.round((to - from) / 86400000);
}

function normalizeStreakState() {
    const state = getStreakState();
    const todayKey = getDayKey();
    if (!state.lastClaimDate) {
        state.count = 0;
        state.lastClaimDate = "";
        saveStreakState(state);
        return state;
    }

    const diffDays = getDayDiffDays(state.lastClaimDate, todayKey);
    if (diffDays > 1) {
        state.count = 0;
        state.lastClaimDate = "";
    }
    saveStreakState(state);
    return state;
}

function renderStreakGrid() {
    const grid = document.getElementById("streakGrid");
    const claimButton = document.getElementById("claimCheckinBtn");
    if (!grid) return;
    const state = normalizeStreakState();
    const todayKey = getDayKey();
    const claimedToday = state.lastClaimDate === todayKey;

    if (claimButton) {
        claimButton.disabled = claimedToday;
        claimButton.innerText = claimedToday ? 'Claimed Today • Lock until reset' : "Claim Today's Reward";
    }

    const mobileClaimButton = document.getElementById("mobileClaimCheckinBtn");
    if (mobileClaimButton) {
        mobileClaimButton.disabled = claimedToday;
        mobileClaimButton.innerText = claimedToday ? "Claimed Today" : "Claim Today's Reward";
    }
    const mobileStreak = document.getElementById("mobileRewardStreak");
    if (mobileStreak) mobileStreak.innerText = `🔥 ${state.count} Days streak`;

    updateDailyResetTimers();

    grid.innerHTML = "";
    for (let i = 1; i <= 7; i++) {
        const day = document.createElement("div");
        day.className = `streak-day ${i <= state.count ? 'active' : ''}`;
        day.innerText = `Day ${i}`;
        grid.appendChild(day);
    }
}

async function claimDailyReward() {
    if (!userSession.id) return alert("Please log in to claim daily rewards.");

    const state = normalizeStreakState();
    const todayKey = getDayKey();
    if (state.lastClaimDate === todayKey) {
        const resetIn = formatResetTimer(Math.max(0, getNextMidnightTimestamp() - Date.now()));
        return alert(`Today's check-in reward has already been claimed. You can claim again in ${resetIn}.`);
    }

    const nextCount = (state.lastClaimDate && getDayDiffDays(state.lastClaimDate, todayKey) === 1)
        ? state.count + 1
        : 1;

    state.count = Math.min(nextCount, 7);
    state.lastClaimDate = todayKey;
    saveStreakState(state);

    const reward = state.count === 7 ? 10 : 2;
    if (supabaseClient) {
        await supabaseClient.from('profiles').update({ streak_count: state.count, last_checkin: todayKey }).eq('id', userSession.id);
    }
    await syncCoinsToDatabase(userSession.kuziCoins + reward);
    addNotification(`Daily streak reward claimed: +${reward} KuziCoin.`);
    renderStreakGrid();
    alert(`Day ${state.count} Reward Claimed: +${reward} KuziCoins credited!`);
}

document.getElementById("claimCheckinBtn").addEventListener("click", claimDailyReward);
document.getElementById("mobileClaimCheckinBtn").addEventListener("click", claimDailyReward);

let isSpinning = false;
let currentRotation = 0;
let adCooldownInterval = null;
let spinCooldownTimeout = null;

function getServerNow() {
    return Date.now() + serverClockOffsetMs;
}

function setServerClock(serverTimestamp) {
    const serverTime = Date.parse(serverTimestamp || "");
    if (Number.isFinite(serverTime)) serverClockOffsetMs = serverTime - Date.now();
}

function getDailySpinRemainingMs() {
    const lastSpinTime = Date.parse(userSession.lastSpinTime || "");
    if (!Number.isFinite(lastSpinTime)) return 0;
    return Math.max(0, lastSpinTime + DAILY_SPIN_INTERVAL_MS - getServerNow());
}

function refreshSharedRewardState(type) {
    if (type === "spin") updateSpinButtonUI();
    if (type === "vip") updateVipCountdown();
    if (type === "coins") updateUI();
    if (type === "streak") renderStreakGrid();
}

async function refreshRewardSurface() {
    if (supabaseClient && !userSession.id) {
        const { data: { session } = {} } = await supabaseClient.auth.getSession();
        if (session?.user) await fetchUserProfile(session.user);
    }
    updateUI();
    renderStreakGrid();
    updateSpinButtonUI();
}

window.addEventListener("kuzi-reward-state-changed", event => {
    refreshSharedRewardState(event.detail?.type);
});

window.addEventListener("storage", event => {
    if (event.key?.startsWith(`kuzi_${userSession.id ? "watchlist" : "guest"}_`) || event.key?.startsWith(`kuzi_${userSession.id ? "history" : "guest"}_`)) {
        renderLibraryUI();
    }
    if (event.key === `kuzi_streak_${userSession.id}`) {
        renderStreakGrid();
    }
    if (event.key === "kuzi_daily_spins") refreshSharedRewardState("spin");
    if (event.key === `kuzi_vip_expires_${userSession.id}` || event.key === `kuzi_vip_activated_${userSession.id}`) {
        const expiry = Number(localStorage.getItem(`kuzi_vip_expires_${userSession.id}`) || 0);
        userSession.isVip = expiry > Date.now();
        refreshSharedRewardState("vip");
    }
    if (event.key === `kuzi_reward_coins_${userSession.id}` && event.newValue !== null) {
        userSession.kuziCoins = Number(event.newValue);
        refreshSharedRewardState("coins");
    }
});

window.addEventListener("focus", refreshRewardSurface);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshRewardSurface();
});

window.addEventListener("kuzi-library-state-changed", () => renderLibraryUI());

function updateSpinButtonUI() {
    const spinBtn = document.getElementById("spinWheelBtn");
    if (!spinBtn) return;
    if (isSpinning) {
        spinBtn.innerText = "Spin in progress...";
        spinBtn.disabled = true;
    } else if (getDailySpinRemainingMs() > 0) {
        spinBtn.innerText = `Spin available in ${formatCooldown(getDailySpinRemainingMs())}`;
        spinBtn.disabled = true;
    } else {
        spinBtn.innerText = "Spin Now";
        spinBtn.disabled = false;
    }
}

function getAdCooldownKey(id) {
    return `kuzi_ad_cooldown_${userSession.id || "guest"}_${id}`;
}

function updateAdMissionUI() {
    document.querySelectorAll("[data-ad-mission]").forEach(button => {
        const cooldownUntil = Number(localStorage.getItem(getAdCooldownKey(button.id)) || 0);
        if (cooldownUntil > Date.now()) {
            button.disabled = true;
            button.innerText = `Available in ${formatCooldown(cooldownUntil - Date.now())}`;
        } else {
            button.disabled = false;
            button.innerText = "Watch Mission (+1 KuziCoin)";
        }
    });
}

async function claimServerSpin() {
    if (!supabaseClient || !userSession.id) return false;

    const { data, error } = await supabaseClient.rpc("claim_lucky_spin");
    if (error) {
        console.error("Lucky Spin validation failed:", error);
        alert("Lucky Spin is temporarily unavailable. Please try again shortly.");
        return false;
    }

    const result = Array.isArray(data) ? data[0] : data;
    setServerClock(result?.server_now);
    if (result?.last_spin_time) userSession.lastSpinTime = result.last_spin_time;
    if (!result?.allowed) {
        updateSpinButtonUI();
        alert(`Your next spin is available in ${formatCooldown(getDailySpinRemainingMs())}.`);
        return false;
    }
    return true;
}

document.getElementById("spinWheelBtn").addEventListener("click", async () => {
    if (!userSession.id) return alert("Please log in to access the Lucky Wheel.");
    if (isSpinning) return;
    if (!(await claimServerSpin())) return;
    executeSpinProcess();
});

function formatCooldown(milliseconds) {
    const totalSeconds = Math.ceil(milliseconds / 1000);
    return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
}

function getGoldenSpinState() {
    if (!userSession.id) return { startedAt: Date.now(), movies: 0, movieIds: [], seconds: 0, unlocked: false, claimed: false };
    const key = `kuzi_golden_spin_${userSession.id}`;
    const stored = JSON.parse(localStorage.getItem(key) || "null");
    if (!stored || !stored.startedAt || Date.now() - stored.startedAt >= 24 * 60 * 60 * 1000) {
        return { startedAt: Date.now(), movies: 0, movieIds: [], seconds: 0, unlocked: false, claimed: false };
    }
    return stored;
}

function saveGoldenSpinState(state) {
    if (userSession.id) localStorage.setItem(`kuzi_golden_spin_${userSession.id}`, JSON.stringify(state));
}

function updateGoldenSpinUI() {
    const state = getGoldenSpinState();
    const progress = document.getElementById("goldenSpinProgress");
    const button = document.getElementById("goldenSpinBtn");
    const minutesWatched = Math.min(GOLDEN_WATCH_TARGET_MINUTES, Math.max(0, Math.floor(state.seconds / 60)));
    if (progress) progress.innerText = `${minutesWatched}/${GOLDEN_WATCH_TARGET_MINUTES} minutes watched in 24 hours`;
    if (!button) return;
    button.disabled = !state.unlocked || state.claimed || isGoldenSpinning;
    button.innerText = isGoldenSpinning
        ? "Golden Spin in progress..."
        : state.claimed
            ? "Golden Spin Claimed"
            : state.unlocked
                ? "✨ Spin for Your Bonus"
                : "🔒 Golden Spin Locked";
}

function recordGoldenMovie() {
    const state = getGoldenSpinState();
    const movieId = activeMovie?.id;
    if (!movieId || state.movieIds?.includes(movieId)) return;
    state.movieIds = [...(state.movieIds || []), movieId];
    state.movies = state.movieIds.length;
    state.unlocked = state.seconds >= GOLDEN_WATCH_TARGET_SECONDS;
    saveGoldenSpinState(state);
    updateGoldenSpinUI();
}

function recordGoldenWatchMinute() {
    const state = getGoldenSpinState();
    state.seconds++;
    state.unlocked = state.seconds >= GOLDEN_WATCH_TARGET_SECONDS;
    saveGoldenSpinState(state);
    updateGoldenSpinUI();
}

function runGoldenSpin() {
    const state = getGoldenSpinState();
    if (!userSession.id || !state.unlocked || state.claimed || isGoldenSpinning) return;
    isGoldenSpinning = true;
    updateGoldenSpinUI();

    const prizeIndex = Math.floor(Math.random() * goldenWheelSegments.length);
    const selectedPrize = goldenWheelSegments[prizeIndex];
    const fullSpins = 4 * 360;
    const targetDegrees = fullSpins + (360 - selectedPrize.centerAngle);
    goldenSpinRotation = goldenSpinRotation + targetDegrees + (360 - (goldenSpinRotation % 360));

    const wheel = document.getElementById("goldenWheel");
    if (wheel) {
        wheel.style.transform = `rotate(${goldenSpinRotation}deg)`;
    }

    setTimeout(async () => {
        state.claimed = true;
        saveGoldenSpinState(state);

        if (selectedPrize.amount === 'vip') {
            userSession.isVip = true;
            saveVipActivation();
            if (supabaseClient && userSession.id) {
                await supabaseClient.from("profiles").update({ is_vip: true }).eq("id", userSession.id);
            }
            addNotification("Golden Spin unlocked: 7-Day VIP Pass awarded.");
            alert("🏆 Golden Spin reward: 7-Day VIP Pass.");
        } else {
            const rewardCoins = Number(selectedPrize.amount);
            await syncCoinsToDatabase(userSession.kuziCoins + rewardCoins);
            addNotification(`Golden Spin unlocked: +${rewardCoins} KuziCoin awarded.`);
            alert(`🏆 Golden Spin reward: +${rewardCoins} KuziCoins.`);
        }

        isGoldenSpinning = false;
        updateGoldenSpinUI();
    }, 3200);
}

function executeSpinProcess() {
    isSpinning = true;
    const prizeIndex = Math.floor(Math.random() * wheelSegments.length);
    const selectedPrize = wheelSegments[prizeIndex];
    const fullSpins = 5 * 360; 
    const targetDegrees = fullSpins + (360 - selectedPrize.centerAngle);
    currentRotation = currentRotation + targetDegrees + (360 - (currentRotation % 360));

    const wheel = document.getElementById("wheel");
    wheel.style.transform = `rotate(${currentRotation}deg)`;

    setTimeout(() => {
        syncCoinsToDatabase(userSession.kuziCoins + selectedPrize.amount);
        addNotification(`Lucky Spin reward received: +${selectedPrize.amount} KuziCoin.`);
        alert(`🎉 Congratulations! You won +${selectedPrize.amount} KuziCoins.`);
        isSpinning = false;
        updateSpinButtonUI();
    }, 3300);
}

function bindEventListeners() {
    bindViewModeControls();
    updateAdMissionUI();
    clearInterval(adCooldownInterval);
    adCooldownInterval = setInterval(() => {
        updateAdMissionUI();
        updateSpinButtonUI();
    }, 1000);

    document.querySelectorAll(".view-more-link").forEach(button => {
        button.addEventListener("click", () => loadMoreRow(button.dataset.moreCategory, button));
    });
    document.querySelectorAll(".movie-row-grid").forEach(grid => {
        grid.addEventListener("scroll", () => {
            if (grid.scrollLeft + grid.clientWidth < grid.scrollWidth - 120) return;
            const category = grid.id === "trendingGrid" ? "movies" : grid.id === "animeGrid" ? "anime" : "shows";
            const button = document.querySelector(`[data-more-category="${category}"]`);
            if (button) loadMoreRow(category, button);
        });
    });
    document.getElementById("goldenSpinBtn")?.addEventListener("click", runGoldenSpin);

    renderNotifications();
    const notificationCount = document.getElementById("notificationCount");
    if (notificationCount && notificationItems.length) {
        notificationCount.innerText = notificationItems.length;
        notificationCount.classList.remove("hidden");
    }

    document.getElementById("notificationBtn")?.addEventListener("click", () => {
        document.getElementById("notificationsModal")?.classList.remove("hidden");
    });
    document.getElementById("mobileHeaderNotificationBtn")?.addEventListener("click", () => {
        document.getElementById("notificationsModal")?.classList.remove("hidden");
    });
    document.getElementById("closeNotificationsBtn")?.addEventListener("click", () => {
        document.getElementById("notificationsModal")?.classList.add("hidden");
    });
    document.getElementById("clearNotificationsBtn")?.addEventListener("click", () => {
        notificationItems = [];
        localStorage.removeItem("kuzi_notifications");
        document.getElementById("notificationCount")?.classList.add("hidden");
        renderNotifications();
    });
    document.getElementById("notificationsList")?.addEventListener("click", (event) => {
        const removeButton = event.target.closest(".notification-remove-btn");
        if (!removeButton) return;
        notificationItems.splice(Number(removeButton.dataset.notificationIndex), 1);
        localStorage.setItem("kuzi_notifications", JSON.stringify(notificationItems));
        const notificationCount = document.getElementById("notificationCount");
        if (notificationItems.length) {
            notificationCount.innerText = notificationItems.length;
        } else {
            notificationCount?.classList.add("hidden");
        }
        renderNotifications();
    });

    document.getElementById("childModeToggle")?.addEventListener("change", (event) => {
        localStorage.setItem("kuzi_child_mode", String(event.target.checked));
        fetchAllCategoriesCatalog();
        addNotification(event.target.checked ? "Child Mode is on. Recommendations are now family-friendly." : "Child Mode is off. Your standard recommendations are restored.");
    });
    const childModeToggle = document.getElementById("childModeToggle");
    if (childModeToggle) childModeToggle.checked = localStorage.getItem("kuzi_child_mode") === "true";

    document.querySelectorAll(".watch-reward-btn").forEach(button => {
        button.dataset.label = button.firstChild.textContent.trim();
        button.addEventListener("click", () => claimWatchReward(button));
    });

    document.getElementById("copyRewardReferralBtn")?.addEventListener("click", async () => {
        if (!userSession.id) return alert("Please log in to share your referral link.");
        const referralLink = `${window.location.origin}?ref=${userSession.refCode}`;
        await navigator.clipboard.writeText(referralLink);
        alert("Referral link copied to clipboard.");
    });

    const searchInput = document.getElementById("searchInput");
    if (searchInput) {
        searchInput.value = "";
        searchInput.setAttribute("autocomplete", "off");
        searchInput.addEventListener("input", (e) => {
            const query = e.target.value.trim();
            
            if (searchTimer) clearTimeout(searchTimer);

            if (query.length >= 3) {
                searchTimer = setTimeout(() => {
                    searchAllContent(query);
                }, 180);
            } else {
                currentSearchQuery = "";
                currentCatalogPage = 1;

                document.body.classList.remove("search-mode");
                const heroBannerEl = document.querySelector(".hero-banner") || document.getElementById("heroBackdrop")?.parentElement;
                if (heroBannerEl) heroBannerEl.style.display = "";

                document.querySelectorAll(".category-section").forEach(section => {
                    section.classList.remove("search-results-section");
                    section.style.display = "block";
                });

                const trendingTitle = document.querySelector("#trendingGrid")?.closest(".category-section")?.querySelector("h3");
                if (trendingTitle) trendingTitle.innerText = `🔥 Trending`;

                if (query.length === 0) {
                    fetchAllCategoriesCatalog();
                }
            }
        });
    }

    const mobileSearchOverlay = document.getElementById("mobileSearchOverlay");
    const mobileSearchInput = document.getElementById("mobileSearchInput");
    document.getElementById("mobileHeaderSearchBtn")?.addEventListener("click", () => {
        mobileSearchOverlay?.classList.remove("hidden");
        mobileSearchOverlay?.setAttribute("aria-hidden", "false");
        mobileSearchInput?.focus();
    });
    document.getElementById("mobileSearchClose")?.addEventListener("click", () => {
        mobileSearchOverlay?.classList.add("hidden");
        mobileSearchOverlay?.setAttribute("aria-hidden", "true");
    });
    mobileSearchOverlay?.addEventListener("click", (event) => {
        if (event.target !== mobileSearchOverlay) return;
        mobileSearchOverlay.classList.add("hidden");
        mobileSearchOverlay.setAttribute("aria-hidden", "true");
    });
    mobileSearchInput?.addEventListener("input", (event) => {
        if (!searchInput) return;
        searchInput.value = event.target.value;
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    document.getElementById("mobileUserAvatarBtn")?.addEventListener("click", () => {
        if (!userSession.id) {
            document.querySelector('[data-mobile-tab="auth"]')?.click();
            return;
        }
        const drawerButton = document.getElementById("openDrawerBtn");
        if (drawerButton) drawerButton.click();
    });

    document.querySelectorAll("[data-mobile-tab]").forEach(button => {
        button.addEventListener("click", () => {
            const tab = button.dataset.mobileTab;
            if (tab === "rewards" && !userSession.id) {
                alert("Please log in to access rewards.");
                document.querySelector('[data-mobile-tab="auth"]')?.click();
                return;
            }
            document.querySelectorAll("[data-mobile-tab]").forEach(item => item.classList.toggle("active", item === button));
            document.body.classList.remove("mobile-discover", "mobile-auth-open", "mobile-rewards", "mobile-downloads");
            document.querySelectorAll(".mobile-page-view").forEach(view => view.classList.add("hidden"));
            if (tab === "discover") {
                document.getElementById("mobileDiscoverView")?.classList.remove("hidden");
                document.body.classList.add("mobile-discover");
                const activeDiscoverTab = document.querySelector("[data-discover-category].active");
                const discoverContent = document.getElementById("mobileDiscoverContent");
                if (activeDiscoverTab && discoverContent && !discoverContent.querySelector(".movie-card")) {
                    loadMobileDiscoverCategory(activeDiscoverTab.dataset.discoverCategory);
                }
            } else if (tab === "rewards") {
                document.getElementById("mobileRewardsView")?.classList.remove("hidden");
                document.body.classList.add("mobile-rewards");
            } else if (tab === "downloads") {
                document.getElementById("mobileDownloadsView")?.classList.remove("hidden");
                document.body.classList.add("mobile-downloads");
                renderDownloads();
            } else if (tab === "auth") {
                document.getElementById("mobileAuthView")?.classList.remove("hidden");
                document.body.classList.add("mobile-auth-open");
            }
        });
    });

    document.querySelectorAll("[data-discover-category]").forEach(button => {
        button.addEventListener("click", () => {
            const category = button.dataset.discoverCategory;
            document.querySelectorAll("[data-discover-category]").forEach(item => {
                const active = item === button;
                item.classList.toggle("active", active);
                item.setAttribute("aria-selected", String(active));
            });
            loadMobileDiscoverCategory(category);
        });
    });

    document.querySelectorAll("[data-close-mobile-tab]").forEach(button => {
        button.addEventListener("click", () => document.querySelector('[data-mobile-tab="home"]')?.click());
    });

    let mobileAuthMode = "login";
    document.querySelectorAll("[data-mobile-auth-mode]").forEach(button => {
        button.addEventListener("click", () => {
            mobileAuthMode = button.dataset.mobileAuthMode;
            document.querySelectorAll("[data-mobile-auth-mode]").forEach(item => {
                const active = item === button;
                item.classList.toggle("active", active);
                item.setAttribute("aria-selected", String(active));
            });
            const submitButton = document.getElementById("mobileAuthSubmit");
            if (submitButton) submitButton.innerText = mobileAuthMode === "signup" ? "Sign Up" : "Login";
            const passwordInput = document.getElementById("mobileAuthPassword");
            if (passwordInput) passwordInput.setAttribute("autocomplete", mobileAuthMode === "signup" ? "new-password" : "current-password");
        });
    });

    document.getElementById("mobileAuthSubmit")?.addEventListener("click", () => {
        const email = document.getElementById("mobileAuthEmail")?.value.trim();
        const password = document.getElementById("mobileAuthPassword")?.value.trim();
        if (!email || !password) return alert("Please enter both email address and password.");
        document.getElementById("authEmail").value = email;
        document.getElementById("authPassword").value = password;
        openAuthModal(mobileAuthMode);
        document.getElementById("modalActionBtn")?.click();
    });

    document.getElementById("vaultAnchorBtn").onclick = async () => {
        if (!userSession.id) return alert("Access Denied. Please log in first.");
        await refreshRewardSurface();
        document.getElementById("vaultModal").classList.remove("hidden");
    };
    document.getElementById("mobileOpenVaultBtn").onclick = async () => {
        if (!userSession.id) return alert("Access Denied. Please log in first.");
        await refreshRewardSurface();
        document.getElementById("vaultModal").classList.remove("hidden");
    };
    document.getElementById("downloadsAnchorBtn").onclick = () => {
        if (!userSession.id) return alert("Please log in to access downloads.");
        renderDownloads();
        document.getElementById("downloadsModal").classList.remove("hidden");
    };
    document.getElementById("closeDownloadsBtn").onclick = () => document.getElementById("downloadsModal").classList.add("hidden");
    document.getElementById("closeVaultBtn").onclick = () => document.getElementById("vaultModal").classList.add("hidden");
    
    document.getElementById("openDrawerBtn").onclick = () => {
        if (!userSession.id) return;
        renderLibraryUI();
        updateVipStatusLabel();
        document.getElementById("drawerOverlay").classList.remove("hidden");
    };
    document.getElementById("closeDrawerBtn").onclick = () => document.getElementById("drawerOverlay").classList.add("hidden");

    document.querySelectorAll("[data-library-tab]").forEach(tab => {
        tab.onclick = () => {
            const selectedType = tab.dataset.libraryTab;
            document.querySelectorAll("[data-library-tab]").forEach(item => item.classList.toggle("active", item === tab));
            document.getElementById("watchlistLibrary").classList.toggle("hidden", selectedType !== "watchlist");
            document.getElementById("historyLibrary").classList.toggle("hidden", selectedType !== "history");
        };
    });

    document.getElementById("copyRefBtn").onclick = () => {
        const refInput = document.getElementById("refLinkInput");
        refInput.select();
        navigator.clipboard.writeText(refInput.value);
        alert("Referral link copied to clipboard.");
    };

    document.getElementById("logoutBtn").onclick = async () => {
        if (supabaseClient) await supabaseClient.auth.signOut();
        location.reload();
    };

    document.getElementById("buyVipBtn").onclick = async () => {
        const { data: { user } = {} } = supabaseClient ? await supabaseClient.auth.getUser() : {};
        const accountId = user?.id;
        if (!accountId) return alert("Sign in to unlock your VIP experience.");
        userSession.id = accountId;
        if (userSession.isVip) return alert("Your VIP Pass is already active.");
        if (userSession.kuziCoins < 50) return alert("You need 50 KuziCoin to unlock VIP Pass.");

        const newBalance = userSession.kuziCoins - 50;
        const { error } = await supabaseClient.from("profiles").update({
            kuzi_coins: newBalance,
            is_vip: true
        }).eq("id", accountId);

        if (error) return alert("VIP Pass could not be activated right now. Please try again.");
        await saveVipActivation(accountId);
        userSession.isVip = true;
        await syncCoinsToDatabase(newBalance);
        updateVipCountdown();
        addNotification("Your 7-Day VIP Pass is active. Enjoy an ad-free Kuzi Box experience.");
        alert("VIP Pass unlocked. Enjoy an ad-free Kuzi Box experience.");
    };

    document.getElementById("closeOverviewBtn").onclick = () => document.getElementById("overviewModal").classList.add("hidden");
    document.getElementById("closePlayerBtn").onclick = () => {
        stopWatchRewardTimer();
        if (serverLoadTimeout) {
            clearTimeout(serverLoadTimeout);
            serverLoadTimeout = null;
        }
        document.getElementById("playerModal").classList.add("hidden");
        document.getElementById("cinemaIframe").src = "";
    };

    ["station1Btn", "station2Btn", "station3Btn"].forEach((id, index) => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.onclick = () => {
                if (!userSession.id) return alert("Please log in to claim commercial rewards.");
                const cooldownUntil = Number(localStorage.getItem(getAdCooldownKey(id)) || 0);
                if (cooldownUntil > Date.now()) return alert(`This mission is available in ${formatCooldown(cooldownUntil - Date.now())}.`);
                btn.disabled = true;
                alert(`Mission ${index + 1} is loading. Your reward will be ready after completion.`);
                setTimeout(() => {
                    const cooldownUntil = Date.now() + 5 * 60 * 1000;
                    localStorage.setItem(getAdCooldownKey(id), String(cooldownUntil));
                    saveAccountRewardState({ missions: { ...(accountRewardState.missions || {}), [id]: cooldownUntil } });
                    syncCoinsToDatabase(userSession.kuziCoins + 1);
                    addNotification("A KuziCoin reward has been added from your completed mission.");
                    alert("Reward Credited! +1 KuziCoin added.");
                    updateAdMissionUI();
                }, 2500);
            };
        }
    });
}

function openOverviewModal(item, categoryTag = "Movie") {
    activeMovie = item;
    activeCategoryTag = categoryTag;
    const title = item.title || item.name;

    document.getElementById("overviewTitle").innerText = title;
    document.getElementById("overviewRating").innerText = `⭐ ${item.vote_average ? item.vote_average.toFixed(1) : '0.0'}`;
    document.getElementById("overviewCategory").innerText = categoryTag;
    document.getElementById("overviewCost").innerText = "0 KC";
    document.getElementById("overviewSynopsis").innerText = item.overview || "No synopsis available.";
    document.getElementById("overviewPoster").src = `${IMAGE_BASE_URL}${item.poster_path}`;
    const watchlistButton = document.getElementById("toggleWatchlistBtn");
    watchlistButton.innerText = isInWatchlist(item.id) ? "♥ Saved to Watchlist" : "♡ Add to Watchlist";

    const dubSelect = document.getElementById("dubSelect");
    dubSelect.innerHTML = "";
    ["English Original", "Hindi Dubbed", "Japanese / Korean Sub"].forEach(opt => {
        const el = document.createElement("option");
        el.value = opt; el.innerText = opt;
        dubSelect.appendChild(el);
    });

    document.getElementById("overviewModal").classList.remove("hidden");
}

document.getElementById("toggleWatchlistBtn").onclick = () => {
    if (!activeMovie) return;
    if (isInWatchlist(activeMovie.id)) {
        removeLibraryItem("watchlist", activeMovie.id);
        document.getElementById("toggleWatchlistBtn").innerText = "♡ Add to Watchlist";
    } else {
        saveLibraryItem("watchlist", activeMovie, activeCategoryTag);
        document.getElementById("toggleWatchlistBtn").innerText = "♥ Saved to Watchlist";
    }
};

document.getElementById("startStreamBtn").onclick = () => {
    document.getElementById("overviewModal").classList.add("hidden");
    const title = activeMovie.title || activeMovie.name;
    saveLibraryItem("history", activeMovie, activeCategoryTag);
    document.getElementById("cinemaTitle").innerText = `Now Playing: ${title}`;
    recordGoldenMovie();
    
    injectServerSwitcherUI();
    activeServer = serverProviders[0];
    serverSwitchAttempts = 0;
    
    if (!userSession.isVip) {
        playPreRollAd(() => {
            updateEmbedSource();
            startWatchRewardTimer();
        });
    } else {
        updateEmbedSource();
        startWatchRewardTimer();
    }
    document.getElementById("playerModal").classList.remove("hidden");
};

document.getElementById("startDownloadBtn")?.addEventListener("click", () => {
    if (!userSession.id) return alert("Please log in to save downloads.");
    if (!activeMovie?.id) return;
    const downloads = getAccountDownloads().filter(item => item.id !== activeMovie.id);
    downloads.unshift({
        id: activeMovie.id,
        title: activeMovie.title || activeMovie.name,
        poster_path: activeMovie.poster_path,
        categoryTag: activeCategoryTag,
        savedAt: Date.now()
    });
    accountRewardState.downloads = downloads.slice(0, 50);
    saveAccountRewardState({ downloads: accountRewardState.downloads });
    renderDownloads();
    alert("Title saved to your Downloads.");
});

// --- AUTO-PLAY PRE-ROLL AD (NO BUTTON / AUTO-DISMISS) ---
let adTimerInterval = null;

function startWatchRewardTimer() {
    stopWatchRewardTimer();
    const watchState = getWatchRewardState();
    watchSeconds = watchState.seconds;
    isVideoPlaying = true;
    updateWatchRewardUI();

    watchTimerInterval = setInterval(() => {
        const playerModal = document.getElementById("playerModal");
        if (!isVideoPlaying || !playerModal || playerModal.classList.contains("hidden")) return;

        watchSeconds++;
        saveWatchRewardState({ ...getWatchRewardState(), seconds: watchSeconds });
        recordGoldenWatchMinute();
        updateWatchRewardUI();
        settlePendingReferral();
    }, 1000);
}

function stopWatchRewardTimer() {
    if (watchTimerInterval) {
        clearInterval(watchTimerInterval);
        watchTimerInterval = null;
    }
    isVideoPlaying = false;
}

window.addEventListener("message", (event) => {
    if (!event.data || typeof event.data !== "object") return;
    if (event.data.type === "videoPause" || event.data.event === "pause") isVideoPlaying = false;
    if (event.data.type === "videoPlay" || event.data.event === "play") isVideoPlaying = true;
});

document.addEventListener("visibilitychange", () => {
    const playerModal = document.getElementById("playerModal");
    if (!playerModal || playerModal.classList.contains("hidden")) return;
    isVideoPlaying = !document.hidden;
});

function getMidnightResetTimestamp() {
    const now = new Date();
    const nextReset = new Date(now);
    nextReset.setHours(24, 0, 0, 0);
    return nextReset.getTime();
}

function getWatchRewardState() {
    if (!userSession.id) return { seconds: 0, claimed: {}, resetAt: getMidnightResetTimestamp() };

    const key = `kuzi_watch_rewards_${userSession.id}`;
    const saved = JSON.parse(localStorage.getItem(key) || '{"seconds":0,"claimed":{},"resetAt":0}');
    const now = Date.now();
    const resetAt = Number(saved.resetAt || 0);

    if (!resetAt || now >= resetAt) {
        const freshState = { seconds: 0, claimed: {}, resetAt: getMidnightResetTimestamp() };
        localStorage.setItem(key, JSON.stringify(freshState));
        watchSeconds = 0;
        return freshState;
    }

    return saved;
}

function saveWatchRewardState(state) {
    if (userSession.id) {
        const nextState = { ...state, resetAt: Number(state.resetAt || getMidnightResetTimestamp()) };
        localStorage.setItem(`kuzi_watch_rewards_${userSession.id}`, JSON.stringify(nextState));
        saveAccountRewardState({ watchRewards: nextState });
    }
}

function updateWatchRewardUI() {
    const state = getWatchRewardState();
    const progress = document.getElementById("watchTimeProgress");
    if (progress) progress.innerText = `Watch time: ${Math.floor(state.seconds / 60)} minutes`;
    updateDailyResetTimers();

    document.querySelectorAll(".watch-reward-btn").forEach(button => {
        const threshold = Number(button.dataset.watchReward);
        const rewardKey = button.dataset.watchReward;
        const claimed = Boolean(state.claimed[rewardKey]);
        button.disabled = !userSession.id || state.seconds < threshold || claimed;
        if (claimed) button.innerHTML = `${button.dataset.label || button.innerText.split("+")[0].trim()} <span>Claimed</span>`;
    });
}

async function claimWatchReward(button) {
    if (!userSession.id) return alert("Please log in to claim watch rewards.");
    const state = getWatchRewardState();
    const rewardKey = button.dataset.watchReward;
    if (state.seconds < Number(rewardKey) || state.claimed[rewardKey]) return;

    state.claimed[rewardKey] = true;
    saveWatchRewardState(state);
    await syncCoinsToDatabase(userSession.kuziCoins + Number(button.dataset.rewardCoins));
    addNotification(`Watch-time reward claimed: +${button.dataset.rewardCoins} KuziCoin.`);
    updateWatchRewardUI();
    alert(`🎉 Watch reward claimed: +${button.dataset.rewardCoins} KuziCoin.`);
}

async function settlePendingReferral() {
    if (!userSession.id || watchSeconds < 3600 || isSettlingReferral) return;
    const referralKey = `kuzi_pending_referral_${userSession.id}`;
    const referralCode = localStorage.getItem(referralKey);
    if (!referralCode) return;

    isSettlingReferral = true;
    try {
        const { error } = await supabaseClient.rpc("process_referral", {
            new_user_id: userSession.id,
            ref_code: referralCode
        });
        if (!error) {
            localStorage.removeItem(referralKey);
            addNotification("Your referral milestone is complete. Both KuziCoin rewards are now unlocked.");
            const status = document.getElementById("referralRewardStatus");
            if (status) status.innerText = "Referral reward unlocked: both accounts have been credited.";
        }
    } finally {
        isSettlingReferral = false;
    }
}

function playPreRollAd(onAdFinished) {
    let adOverlay = document.getElementById("customPreRollAd");

    if (!adOverlay) {
        adOverlay = document.createElement("div");
        adOverlay.id = "customPreRollAd";
        adOverlay.style.cssText = "position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: #0f172a; z-index: 9999; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fff; text-align: center; padding: 20px;";
        adOverlay.innerHTML = `
            <div style="background: rgba(30, 41, 59, 0.95); padding: 35px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); max-width: 380px; width: 100%; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
                <h3 style="color: #38bdf8; margin-bottom: 8px; font-size: 17px; font-weight: 600;">Sponsored Message</h3>
                <p style="color: #94a3b8; font-size: 12px; margin-bottom: 20px; line-height: 1.4;">Free streaming is supported by sponsors. Your video will start automatically in:</p>
                <div id="adCountdown" style="font-size: 32px; font-weight: 700; color: #facc15; margin-bottom: 10px;">8</div>
                <div style="font-size: 11px; color: #64748b; letter-spacing: 0.5px;">PLEASE WAIT...</div>
            </div>
        `;
        const cinemaBody = document.querySelector(".cinema-body");
        if (cinemaBody) {
            cinemaBody.style.position = "relative";
            cinemaBody.appendChild(adOverlay);
        }
    } else {
        adOverlay.style.display = "flex";
    }

    if (adTimerInterval) {
        clearInterval(adTimerInterval);
        adTimerInterval = null;
    }

    let timeLeft = 8;
    const countdownEl = adOverlay.querySelector("#adCountdown");
    if (countdownEl) countdownEl.innerText = timeLeft;

    adTimerInterval = setInterval(() => {
        timeLeft--;
        if (countdownEl) countdownEl.innerText = timeLeft;

        if (timeLeft <= 0) {
            clearInterval(adTimerInterval);
            adTimerInterval = null;
            adOverlay.style.display = "none";
            onAdFinished();
        }
    }, 1000);
}

function normalizeTitleForMatch(value = "") {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractAllDebridCandidates(entry) {
    const candidates = [];
    const pushIfValid = (value) => {
        if (!value || typeof value !== 'string') return;
        const trimmed = value.trim();
        if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
    };

    if (entry && typeof entry === 'object') {
        pushIfValid(entry.link);
        pushIfValid(entry.url);
        pushIfValid(entry.streamUrl);
        if (Array.isArray(entry.streaming)) {
            entry.streaming.forEach(item => {
                pushIfValid(item?.link);
                pushIfValid(item?.url);
            });
        }
        if (Array.isArray(entry.files)) {
            entry.files.forEach(file => {
                pushIfValid(file?.link);
                pushIfValid(file?.url);
                pushIfValid(file?.filename);
            });
        }
    }

    return candidates;
}

async function resolveAllDebridStreamLink(movie) {
    if (!movie || !supabaseClient) return null;

    try {
        const { data: { session } = {} } = await supabaseClient.auth.getSession();
        if (!session?.access_token) return null;

        const title = movie.title || movie.name || "movie";
        const year = movie.release_date ? movie.release_date.slice(0, 4) : (movie.first_air_date ? movie.first_air_date.slice(0, 4) : "");
        const response = await fetch("/.netlify/functions/stream-proxy", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${session.access_token}`
            },
            body: JSON.stringify({
                provider: "alldebrid",
                title,
                year,
                mediaType: movie.media_type === "tv" || movie.first_air_date || movie.name ? "tv" : "movie"
            })
        });
        if (!response.ok) return null;
        const data = await response.json();
        return typeof data?.url === "string" && /^https:\/\//i.test(data.url) ? data.url : null;
    } catch (error) {
        console.warn("AllDebrid stream resolution failed:", error);
        return null;
    }
}

function injectServerSwitcherUI() {
    let switcherContainer = document.getElementById("serverSwitcherBar");
    if (!switcherContainer) {
        switcherContainer = document.createElement("div");
        switcherContainer.id = "serverSwitcherBar";
        switcherContainer.style.cssText = "display: none;";
        switcherContainer.innerHTML = `
            <span style="color:#64748b; font-size:12px; font-weight:600; margin-right:4px;">SERVERS:</span>
            <button onclick="switchServer('alldebrid')" class="srv-btn active-srv" data-srv="alldebrid" style="padding:4px 10px; background:#0284c7; color:#fff; border-radius:4px; border:none; cursor:pointer; font-size:11px; font-weight:500;">AllDebrid</button>
            <button onclick="switchServer('vidsrc')" class="srv-btn" data-srv="vidsrc" style="padding:4px 10px; background:#1e293b; color:#94a3b8; border-radius:4px; border:none; cursor:pointer; font-size:11px; font-weight:500;">VidSrcNs</button>
            <button onclick="switchServer('vidsrcme')" class="srv-btn" data-srv="vidsrcme" style="padding:4px 10px; background:#1e293b; color:#94a3b8; border-radius:4px; border:none; cursor:pointer; font-size:11px; font-weight:500;">VidSrcMe</button>
            <button onclick="switchServer('2embed')" class="srv-btn" data-srv="2embed" style="padding:4px 10px; background:#1e293b; color:#94a3b8; border-radius:4px; border:none; cursor:pointer; font-size:11px; font-weight:500;">2Embed</button>
            <button onclick="switchServer('watchv2_autoembed')" class="srv-btn" data-srv="watchv2_autoembed" style="padding:4px 10px; background:#1e293b; color:#94a3b8; border-radius:4px; border:none; cursor:pointer; font-size:11px; font-weight:500;">AutoEmbed V2</button>
            <button onclick="switchServer('superembed')" class="srv-btn" data-srv="superembed" style="padding:4px 10px; background:#1e293b; color:#94a3b8; border-radius:4px; border:none; cursor:pointer; font-size:11px; font-weight:500;">SuperEmbed</button>
            <button onclick="switchServer('rivestream')" class="srv-btn" data-srv="rivestream" style="padding:4px 10px; background:#1e293b; color:#94a3b8; border-radius:4px; border:none; cursor:pointer; font-size:11px; font-weight:500;">RiveStream</button>
            <button onclick="switchServer('nontongo')" class="srv-btn" data-srv="nontongo" style="padding:4px 10px; background:#1e293b; color:#94a3b8; border-radius:4px; border:none; cursor:pointer; font-size:11px; font-weight:500;">Nontongo</button>
        `;
        const cinemaBody = document.querySelector(".cinema-body");
        if (cinemaBody && cinemaBody.parentNode) {
            cinemaBody.parentNode.insertBefore(switcherContainer, cinemaBody);
        }
    }
}

function switchServer(provider) {
    if (!serverProviders.includes(provider)) return;
    activeServer = provider;
    serverSwitchAttempts = serverProviders.indexOf(provider);
    if (serverLoadTimeout) {
        clearTimeout(serverLoadTimeout);
        serverLoadTimeout = null;
    }
    document.querySelectorAll(".srv-btn").forEach(btn => {
        if (btn.getAttribute("data-srv") === provider) {
            btn.style.background = "#0284c7";
            btn.style.color = "#fff";
        } else {
            btn.style.background = "#1e293b";
            btn.style.color = "#94a3b8";
        }
    });
    updateEmbedSource();
}

function scheduleServerFallback() {
    if (serverLoadTimeout) clearTimeout(serverLoadTimeout);

    serverLoadTimeout = setTimeout(() => {
        if (serverSwitchAttempts >= serverProviders.length - 1) {
            serverLoadTimeout = null;
            return;
        }

        serverSwitchAttempts++;
        activeServer = serverProviders[serverSwitchAttempts];
        updateServerSwitcherState();
        updateEmbedSource();
    }, SERVER_LOAD_TIMEOUT_MS);
}

function updateServerSwitcherState() {
    document.querySelectorAll(".srv-btn").forEach(btn => {
        const isActive = btn.getAttribute("data-srv") === activeServer;
        btn.style.background = isActive ? "#0284c7" : "#1e293b";
        btn.style.color = isActive ? "#fff" : "#94a3b8";
        btn.classList.toggle("active-srv", isActive);
    });
}

function configureIframeSandbox(provider) {
    const iframe = document.getElementById("cinemaIframe");
    if (!iframe) return;

    if (provider === "autoembed") {
        iframe.removeAttribute("sandbox");
        return;
    }

    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-presentation");
}

async function updateEmbedSource() {
    const iframe = document.getElementById("cinemaIframe");
    const premiumVideo = document.getElementById("premiumVideoPlayer");
    const iframeWrapper = document.getElementById("iframeWrapper");
    const premiumPlayerWrapper = document.getElementById("premiumPlayerWrapper");
    
    if (!activeMovie || !activeMovie.id) return;
    const tmdbId = activeMovie.id;
    const isTvOrAnime = activeMovie.media_type === 'tv' || activeMovie.first_air_date || activeMovie.name;
    configureIframeSandbox(activeServer);

    if (premiumPlayerWrapper) premiumPlayerWrapper.style.display = "none";
    if (iframeWrapper) iframeWrapper.style.display = "block";

    if (activeServer === 'alldebrid') {
        const allDebridStreamUrl = await resolveAllDebridStreamLink(activeMovie);
        if (!allDebridStreamUrl) {
            const currentIndex = serverProviders.indexOf('alldebrid');
            const fallbackIndex = Math.min(currentIndex + 1, serverProviders.length - 1);
            activeServer = serverProviders[fallbackIndex];
            updateServerSwitcherState();
            return updateEmbedSource();
        }
        // AllDebrid returns a direct media URL, not a hosted embed player.
        // Keep the custom player disabled; external server selections use the iframe below.
        if (iframe) iframe.src = allDebridStreamUrl;
    } else if (activeServer === 'vidsrc') {
        premiumPlayerWrapper.style.display = "none";
        iframeWrapper.style.display = "block";
        iframe.src = isTvOrAnime ? `https://vidsrc.sbs/embed/tv/${tmdbId}/1/1` : `https://vidsrc.sbs/embed/movie/${tmdbId}`;
    } else if (activeServer === 'watchv2_autoembed') {
        premiumPlayerWrapper.style.display = "none";
        iframeWrapper.style.display = "block";
        iframe.src = isTvOrAnime ? `https://watch-v2.autoembed.app/{tmdbId}/${season}/${episode}` : `https://watch-v2.autoembed.app/{tmdbId}`;
    } else if (activeServer === 'vidsrcme') {
        premiumPlayerWrapper.style.display = "none";
        iframeWrapper.style.display = "block";
        iframe.src = isTvOrAnime ? `https://vidsrcme.ru/embed/tv/${tmdbId}/1/1` : `https://vidsrcme.ru/embed/movie/${tmdbId}`;
    } else if (activeServer === '2embed') {
        premiumPlayerWrapper.style.display = "none";
        iframeWrapper.style.display = "block";
        iframe.src = isTvOrAnime ? `https://www.2embed.online/embed/tv?id=${tmdbId}&s=1&e=1` : `https://www.2embed.online/embed/movie/${tmdbId}`;
    } else if (activeServer === 'superembed') {
        premiumPlayerWrapper.style.display = "none";
        iframeWrapper.style.display = "block";
        iframe.src = isTvOrAnime ? `https://www.superembed.stream/embed/tv/${tmdbId}/1/1` : `https://www.superembed.stream/embed/movie/${tmdbId}`;
    } else if (activeServer === 'rivestream') {
        premiumPlayerWrapper.style.display = "none";
        iframeWrapper.style.display = "block";
        iframe.src = isTvOrAnime ? `https://rivestream.xyz/embed?type=tv&id=${tmdbId}&season=1&episode=1` : `https://rivestream.xyz/embed?type=movie&id=${tmdbId}`;
    } else if (activeServer === 'nontongo') {
        premiumPlayerWrapper.style.display = "none";
        iframeWrapper.style.display = "block";
        iframe.src = isTvOrAnime ? `https://nontongo.win/embed/tv/${tmdbId}/1/1` : `https://nontongo.win/embed/movie/${tmdbId}`;
    }
    
    const quality = userSession.isVip ? "1080p" : "480p";
    const qualityBadge = document.getElementById("qualityBadge");
    if (qualityBadge) qualityBadge.innerText = quality;
    if (iframe.src && !iframe.src.includes("data:")) {
        iframe.src += iframe.src.includes("?") ? `&quality=${quality}` : `?quality=${quality}`;
    }
    scheduleServerFallback();
}

// Premium Player Initialization
function initPremiumPlayer(videoUrl) {
    const premiumVideo = document.getElementById("premiumVideoPlayer");
    const playerOverlay = document.getElementById("playerOverlay");
    
    if (!premiumVideo) return;
    
    premiumVideo.src = videoUrl;
    premiumVideo.load();
    
    // Show overlay initially
    playerOverlay?.classList.remove("hidden");
    
    // Setup all player controls
    setupPlayerControls();
}

function setupPlayerControls() {
    const video = document.getElementById("premiumVideoPlayer");
    const playerOverlay = document.getElementById("playerOverlay");
    const playPauseBtn = document.getElementById("playPauseBtn");
    const playButtonLarge = document.getElementById("playButtonLarge");
    const volumeBtn = document.getElementById("volumeBtn");
    const volumeSlider = document.getElementById("volumeSlider");
    const progressBar = document.getElementById("progressBar");
    const currentTimeEl = document.getElementById("currentTime");
    const durationEl = document.getElementById("duration");
    const fullscreenBtn = document.getElementById("fullscreenBtn");
    const playerContainer = document.getElementById("playerContainer");
    const qualityMenuBtn = document.getElementById("qualityMenuBtn");
    const speedMenuBtn = document.getElementById("speedMenuBtn");
    const qualityMenu = document.getElementById("qualityMenu");
    const speedMenu = document.getElementById("speedMenu");
    const subtitleMenu = document.getElementById("subtitleMenu");
    const audioMenu = document.getElementById("audioMenu");
    const qualityMenuBtn2 = document.getElementById("qualityMenuBtn");
    const speedMenuBtn2 = document.getElementById("speedMenuBtn");
    const subtitleMenuBtn = document.getElementById("subtitleMenuBtn");
    const audioMenuBtn = document.getElementById("audioMenuBtn");

    if (!video) return;

    // Play/Pause
    playPauseBtn?.addEventListener("click", togglePlayPause);
    playButtonLarge?.addEventListener("click", togglePlayPause);

    function togglePlayPause() {
        if (video.paused) {
            video.play();
            playerOverlay?.classList.add("hidden");
            playPauseBtn?.querySelector(".icon-pause")?.classList.remove("hidden");
            playPauseBtn?.querySelector(".icon-play")?.classList.add("hidden");
        } else {
            video.pause();
            playerOverlay?.classList.remove("hidden");
            playPauseBtn?.querySelector(".icon-pause")?.classList.add("hidden");
            playPauseBtn?.querySelector(".icon-play")?.classList.remove("hidden");
        }
    }

    // Video events
    video.addEventListener("play", () => {
        playerOverlay?.classList.add("hidden");
        playPauseBtn?.querySelector(".icon-pause")?.classList.remove("hidden");
        playPauseBtn?.querySelector(".icon-play")?.classList.add("hidden");
    });

    video.addEventListener("pause", () => {
        playPauseBtn?.querySelector(".icon-pause")?.classList.add("hidden");
        playPauseBtn?.querySelector(".icon-play")?.classList.remove("hidden");
    });

    video.addEventListener("timeupdate", () => {
        if (!progressBar.getAttribute("data-seeking")) {
            const percent = (video.currentTime / video.duration) * 100 || 0;
            progressBar.value = percent;
            currentTimeEl.textContent = formatTime(video.currentTime);
        }
    });

    video.addEventListener("loadedmetadata", () => {
        durationEl.textContent = formatTime(video.duration);
        progressBar.max = video.duration;
        
        // Detect and populate audio and subtitle tracks
        setTimeout(() => {
            detectAndPopulateAudioTracks(video, audioMenu);
            detectAndPopulateSubtitleTracks(video, subtitleMenu);
        }, 500);
    });

    video.addEventListener("ended", () => {
        playerOverlay?.classList.remove("hidden");
        playPauseBtn?.querySelector(".icon-pause")?.classList.add("hidden");
        playPauseBtn?.querySelector(".icon-play")?.classList.remove("hidden");
    });

    // Progress bar seek
    progressBar?.addEventListener("mousedown", () => progressBar.setAttribute("data-seeking", "true"));
    progressBar?.addEventListener("touchstart", () => progressBar.setAttribute("data-seeking", "true"));
    
    progressBar?.addEventListener("input", (e) => {
        video.currentTime = (e.target.value / 100) * video.duration;
        currentTimeEl.textContent = formatTime(video.currentTime);
    });

    progressBar?.addEventListener("mouseup", () => progressBar.removeAttribute("data-seeking"));
    progressBar?.addEventListener("touchend", () => progressBar.removeAttribute("data-seeking"));

    // Volume control
    volumeBtn?.addEventListener("click", () => {
        if (video.muted) {
            video.muted = false;
            volumeSlider.value = video.volume * 100;
            volumeBtn.querySelector(".icon-volume-high")?.classList.remove("hidden");
            volumeBtn.querySelector(".icon-volume-mute")?.classList.add("hidden");
        } else {
            video.muted = true;
            volumeBtn.querySelector(".icon-volume-high")?.classList.add("hidden");
            volumeBtn.querySelector(".icon-volume-mute")?.classList.remove("hidden");
        }
    });

    volumeSlider?.addEventListener("input", (e) => {
        video.volume = e.target.value / 100;
        if (video.volume > 0) {
            video.muted = false;
            volumeBtn.querySelector(".icon-volume-high")?.classList.remove("hidden");
            volumeBtn.querySelector(".icon-volume-mute")?.classList.add("hidden");
        }
    });

    // Quality selector
    document.querySelectorAll("#qualityOptions .menu-item").forEach(item => {
        item.addEventListener("click", (e) => {
            const quality = e.target.getAttribute("data-quality");
            document.querySelectorAll("#qualityOptions .menu-item").forEach(i => i.classList.remove("active"));
            e.target.classList.add("active");
            qualityMenuBtn.querySelector(".quality-text").textContent = quality.toUpperCase();
            qualityMenu.style.display = "none";
            qualityMenuBtn.classList.remove("active");
        });
    });

    // Speed selector
    document.querySelectorAll("#speedOptions .menu-item").forEach(item => {
        item.addEventListener("click", (e) => {
            const speed = parseFloat(e.target.getAttribute("data-speed"));
            video.playbackRate = speed;
            document.querySelectorAll("#speedOptions .menu-item").forEach(i => i.classList.remove("active"));
            e.target.classList.add("active");
            speedMenuBtn.querySelector(".speed-text").textContent = speed + "x";
            speedMenu.style.display = "none";
            speedMenuBtn.classList.remove("active");
        });
    });

    // Menu toggles
    qualityMenuBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        qualityMenu.style.display = qualityMenu.style.display === "none" ? "block" : "none";
        qualityMenuBtn.classList.toggle("active");
        speedMenu.style.display = "none";
        speedMenuBtn.classList.remove("active");
    });

    speedMenuBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        speedMenu.style.display = speedMenu.style.display === "none" ? "block" : "none";
        speedMenuBtn.classList.toggle("active");
        qualityMenu.style.display = "none";
        qualityMenuBtn.classList.remove("active");
    });

    subtitleMenuBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        subtitleMenu.style.display = subtitleMenu.style.display === "none" ? "block" : "none";
        subtitleMenuBtn.classList.toggle("active");
    });

    audioMenuBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        audioMenu.style.display = audioMenu.style.display === "none" ? "block" : "none";
        audioMenuBtn.classList.toggle("active");
    });

    // Close menus on outside click
    document.addEventListener("click", (e) => {
        if (!e.target.closest(".control-menu-wrapper")) {
            qualityMenu.style.display = "none";
            speedMenu.style.display = "none";
            subtitleMenu.style.display = "none";
            audioMenu.style.display = "none";
            document.querySelectorAll(".menu-btn").forEach(btn => btn.classList.remove("active"));
        }
    });

    // Fullscreen
    fullscreenBtn?.addEventListener("click", () => {
        playerContainer.classList.toggle("fullscreen");
        fullscreenBtn.querySelector(".icon-fullscreen")?.classList.toggle("hidden");
        fullscreenBtn.querySelector(".icon-fullscreen-exit")?.classList.toggle("hidden");
        
        if (playerContainer.classList.contains("fullscreen")) {
            if (playerContainer.requestFullscreen) {
                playerContainer.requestFullscreen().catch(() => {});
            } else if (playerContainer.webkitRequestFullscreen) {
                playerContainer.webkitRequestFullscreen();
            }
        } else {
            if (document.fullscreenElement) {
                document.exitFullscreen();
            } else if (document.webkitFullscreenElement) {
                document.webkitExitFullscreen();
            }
        }
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
        if (document.getElementById("playerModal").classList.contains("hidden")) return;
        
        switch(e.key.toLowerCase()) {
            case " ":
                e.preventDefault();
                togglePlayPause();
                break;
            case "f":
                fullscreenBtn?.click();
                break;
            case "m":
                volumeBtn?.click();
                break;
            case "arrowleft":
                e.preventDefault();
                video.currentTime = Math.max(0, video.currentTime - 5);
                break;
            case "arrowright":
                e.preventDefault();
                video.currentTime = Math.min(video.duration, video.currentTime + 5);
                break;
            case "arrowup":
                e.preventDefault();
                video.volume = Math.min(1, video.volume + 0.1);
                volumeSlider.value = video.volume * 100;
                break;
            case "arrowdown":
                e.preventDefault();
                video.volume = Math.max(0, video.volume - 0.1);
                volumeSlider.value = video.volume * 100;
                break;
            case ">":
                if (e.shiftKey) {
                    e.preventDefault();
                    video.playbackRate = Math.min(2, video.playbackRate + 0.25);
                }
                break;
            case "<":
                if (e.shiftKey) {
                    e.preventDefault();
                    video.playbackRate = Math.max(0.5, video.playbackRate - 0.25);
                }
                break;
        }
    });
}

// Detect available audio tracks and populate menu
function detectAndPopulateAudioTracks(video, audioMenu) {
    const audioOptions = audioMenu?.querySelector(".menu-options");
    if (!audioOptions || !video.audioTracks) return;

    // Clear existing options except for detecting tracks
    audioOptions.innerHTML = "";

    const detectedTracks = [];
    
    // Collect audio tracks from video element
    if (video.audioTracks && video.audioTracks.length > 0) {
        for (let i = 0; i < video.audioTracks.length; i++) {
            const track = video.audioTracks[i];
            const label = track.label || `Audio ${i + 1}`;
            const language = track.language || "";
            
            detectedTracks.push({
                index: i,
                label: label,
                language: language,
                kind: track.kind
            });
        }
    }

    // If no tracks detected, show default options
    if (detectedTracks.length === 0) {
        const defaultOptions = [
            { label: "English", lang: "en" },
            { label: "हिन्दी (Hindi)", lang: "hi" },
            { label: "Español", lang: "es" },
            { label: "Français", lang: "fr" },
            { label: "Português", lang: "pt" }
        ];
        
        defaultOptions.forEach(opt => {
            const item = document.createElement("div");
            item.className = "menu-item";
            item.setAttribute("data-audio", opt.lang);
            item.textContent = opt.label;
            audioOptions.appendChild(item);
        });
    } else {
        // Add detected tracks to menu
        detectedTracks.forEach((track, idx) => {
            const item = document.createElement("div");
            item.className = "menu-item";
            item.setAttribute("data-track-index", track.index);
            item.setAttribute("data-language", track.language);
            
            // Prefer Hindi if available
            if (track.language.toLowerCase().includes("hi") || track.label.toLowerCase().includes("hindi")) {
                item.classList.add("active");
                video.audioTracks[track.index].enabled = true;
            } else {
                video.audioTracks[track.index].enabled = false;
            }
            
            item.textContent = track.label || `${track.language} Audio`;
            item.addEventListener("click", () => selectAudioTrack(track.index, audioOptions));
            audioOptions.appendChild(item);
        });
    }

    // Attach click handlers to default option items if no tracks detected
    if (detectedTracks.length === 0) {
        audioOptions.querySelectorAll(".menu-item").forEach(item => {
            item.addEventListener("click", (e) => {
                audioOptions.querySelectorAll(".menu-item").forEach(i => i.classList.remove("active"));
                e.target.classList.add("active");
                // Note: Direct audio track switching not possible without re-encoding
                // This is a preference indicator for OTT platforms
            });
        });
    }
}

// Select audio track
function selectAudioTrack(trackIndex, audioOptions) {
    const video = document.getElementById("premiumVideoPlayer");
    if (!video || !video.audioTracks) return;

    // Disable all tracks
    for (let i = 0; i < video.audioTracks.length; i++) {
        video.audioTracks[i].enabled = false;
    }

    // Enable selected track
    if (trackIndex < video.audioTracks.length) {
        video.audioTracks[trackIndex].enabled = true;
    }

    // Update menu selection
    audioOptions?.querySelectorAll(".menu-item").forEach((item, idx) => {
        if (parseInt(item.getAttribute("data-track-index")) === trackIndex || idx === trackIndex) {
            item.classList.add("active");
        } else {
            item.classList.remove("active");
        }
    });

    // Close menu
    const audioMenu = document.getElementById("audioMenu");
    if (audioMenu) audioMenu.style.display = "none";
    const audioMenuBtn = document.getElementById("audioMenuBtn");
    if (audioMenuBtn) audioMenuBtn.classList.remove("active");
}

// Detect available subtitle tracks and populate menu
function detectAndPopulateSubtitleTracks(video, subtitleMenu) {
    const subtitleOptions = subtitleMenu?.querySelector(".menu-options");
    if (!subtitleOptions || !video.textTracks) return;

    // Clear existing options
    subtitleOptions.innerHTML = "";

    // Add "Off" option
    const offOption = document.createElement("div");
    offOption.className = "menu-item active";
    offOption.setAttribute("data-subtitle", "off");
    offOption.textContent = "Off";
    offOption.addEventListener("click", () => {
        for (let i = 0; i < video.textTracks.length; i++) {
            video.textTracks[i].mode = "hidden";
        }
        subtitleOptions.querySelectorAll(".menu-item").forEach(item => item.classList.remove("active"));
        offOption.classList.add("active");
    });
    subtitleOptions.appendChild(offOption);

    const detectedTracks = [];

    // Collect subtitle/caption tracks
    if (video.textTracks && video.textTracks.length > 0) {
        for (let i = 0; i < video.textTracks.length; i++) {
            const track = video.textTracks[i];
            if (track.kind === "subtitles" || track.kind === "captions") {
                const label = track.label || `Subtitle ${i + 1}`;
                const language = track.language || "";

                detectedTracks.push({
                    index: i,
                    label: label,
                    language: language,
                    kind: track.kind
                });
            }
        }
    }

    // If no tracks detected, show default options
    if (detectedTracks.length === 0) {
        const defaultOptions = [
            { label: "English", lang: "en" },
            { label: "हिन्दी (Hindi)", lang: "hi" },
            { label: "Español", lang: "es" },
            { label: "Français", lang: "fr" },
            { label: "Português", lang: "pt" }
        ];

        defaultOptions.forEach(opt => {
            const item = document.createElement("div");
            item.className = "menu-item";
            item.setAttribute("data-subtitle", opt.lang);
            item.textContent = opt.label;
            item.addEventListener("click", () => {
                subtitleOptions.querySelectorAll(".menu-item").forEach(i => i.classList.remove("active"));
                item.classList.add("active");
                // Note: Without proper subtitle tracks, this is a preference indicator
            });
            subtitleOptions.appendChild(item);
        });
    } else {
        // Add detected tracks to menu
        detectedTracks.forEach((track, idx) => {
            const item = document.createElement("div");
            item.className = "menu-item";
            item.setAttribute("data-track-index", track.index);
            item.setAttribute("data-language", track.language);
            item.textContent = track.label || `${track.language} Subtitle`;
            
            item.addEventListener("click", () => {
                selectSubtitleTrack(track.index, subtitleOptions);
            });
            subtitleOptions.appendChild(item);
        });
    }
}

// Select subtitle track
function selectSubtitleTrack(trackIndex, subtitleOptions) {
    const video = document.getElementById("premiumVideoPlayer");
    if (!video || !video.textTracks) return;

    // Disable all tracks
    for (let i = 0; i < video.textTracks.length; i++) {
        video.textTracks[i].mode = "hidden";
    }

    // Enable selected track
    if (trackIndex < video.textTracks.length) {
        video.textTracks[trackIndex].mode = "showing";
    }

    // Update menu selection
    subtitleOptions?.querySelectorAll(".menu-item").forEach((item, idx) => {
        if (parseInt(item.getAttribute("data-track-index")) === trackIndex || idx === trackIndex + 1) {
            item.classList.add("active");
        } else {
            item.classList.remove("active");
        }
    });

    // Close menu
    const subtitleMenu = document.getElementById("subtitleMenu");
    if (subtitleMenu) subtitleMenu.style.display = "none";
    const subtitleMenuBtn = document.getElementById("subtitleMenuBtn");
    if (subtitleMenuBtn) subtitleMenuBtn.classList.remove("active");
}

function formatTime(seconds) {
    if (isNaN(seconds)) return "00:00";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }
    return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

document.getElementById("cinemaIframe")?.addEventListener("load", () => {
    if (serverLoadTimeout) {
        clearTimeout(serverLoadTimeout);
        serverLoadTimeout = null;
    }
});

async function loadMoreRow(category, button) {
    if (!rowPages[category] || rowLoading[category]) return;
    const gridId = category === "movies" ? "trendingGrid" : category === "anime" ? "animeGrid" : "moviesGrid";
    const endpoint = category === "movies"
        ? `${TMDB_BASE_URL}/trending/movie/day?api_key=${TMDB_API_KEY}&page=${rowPages[category] + 1}`
        : category === "anime"
            ? `${TMDB_BASE_URL}/discover/tv?api_key=${TMDB_API_KEY}&with_genres=16&with_origin_country=JP&with_original_language=ja&page=${rowPages[category] + 1}`
            : `${TMDB_BASE_URL}/trending/tv/day?api_key=${TMDB_API_KEY}&page=${rowPages[category] + 1}`;

    rowLoading[category] = true;
    button.disabled = true;
    button.innerText = "Loading...";
    try {
        const response = await fetch(endpoint);
        const data = await response.json();
        const results = (data.results || []).filter(isAllowedContent).map(item => ({
            ...item,
            media_type: category === "movies" ? "movie" : "tv",
            isAnime: category === "anime"
        }));
        rowPages[category]++;
        renderMovieRow(gridId, results, true);
    } catch (error) {
        console.error("Error loading more content:", error);
    } finally {
        rowLoading[category] = false;
        button.disabled = false;
        button.innerText = "More >";
    }
}