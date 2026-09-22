const ALLDEBRID_API_BASE_URL = "https://api.alldebrid.com/v4";
const MAX_REQUESTS_PER_WINDOW = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const requestLog = new Map();

const responseHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
};

function json(statusCode, body) {
    return {
        statusCode,
        headers: responseHeaders,
        body: JSON.stringify(body)
    };
}

function normalizeTitle(value = "") {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function extractLinks(entry) {
    const links = [];
    const add = (value) => {
        if (typeof value !== "string") return;
        const link = value.trim();
        if (link && !links.includes(link)) links.push(link);
    };

    if (!entry || typeof entry !== "object") return links;
    add(entry.link);
    add(entry.url);
    add(entry.streamUrl);
    for (const item of [ ...(Array.isArray(entry.streaming) ? entry.streaming : []), ...(Array.isArray(entry.files) ? entry.files : []) ]) {
        add(item?.link);
        add(item?.url);
    }
    return links;
}

function getClientKey(event, userId) {
    const forwardedFor = event.headers?.["x-forwarded-for"] || event.headers?.["X-Forwarded-For"] || "";
    const ip = forwardedFor.split(",")[0].trim() || "unknown";
    return `${userId}:${ip}`;
}

function isRateLimited(key) {
    const now = Date.now();
    const recent = (requestLog.get(key) || []).filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);
    recent.push(now);
    requestLog.set(key, recent);
    return recent.length > MAX_REQUESTS_PER_WINDOW;
}

async function authenticateRequest(event) {
    const authorization = event.headers?.authorization || event.headers?.Authorization || "";
    const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    if (!match || !supabaseUrl || !supabaseAnonKey) return null;

    const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
        headers: {
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${match[1]}`
        }
    });
    if (!response.ok) return null;
    return response.json();
}

async function searchAllDebrid(query, apiKey) {
    const url = new URL(`${ALLDEBRID_API_BASE_URL}/search`);
    url.searchParams.set("apikey", apiKey);
    url.searchParams.set("query", query);
    const response = await fetch(url);
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload?.data) ? payload.data : [];
}

async function unlockAllDebridLink(link, apiKey) {
    const url = new URL(`${ALLDEBRID_API_BASE_URL}/link/unlock`);
    url.searchParams.set("apikey", apiKey);
    url.searchParams.set("link", link);
    const response = await fetch(url);
    if (!response.ok) return null;
    const payload = await response.json();
    const unlockedLink = payload?.data?.link;
    return typeof unlockedLink === "string" && /^https:\/\//i.test(unlockedLink) ? unlockedLink : null;
}

async function handler(event) {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: responseHeaders, body: "" };
    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
    if (!process.env.ALLDEBRID_API_KEY) return json(503, { error: "Stream service unavailable" });

    let user;
    try {
        user = await authenticateRequest(event);
    } catch {
        return json(401, { error: "Authentication failed" });
    }
    if (!user?.id) return json(401, { error: "Authentication required" });

    const rateLimitKey = getClientKey(event, user.id);
    if (isRateLimited(rateLimitKey)) return json(429, { error: "Too many stream requests" });

    let request;
    try {
        if (Number(event.headers?.["content-length"] || 0) > 8192) return json(413, { error: "Request too large" });
        request = JSON.parse(event.body || "{}");
    } catch {
        return json(400, { error: "Invalid JSON body" });
    }

    if (request.provider !== "alldebrid") return json(400, { error: "Unsupported provider" });
    const title = typeof request.title === "string" ? request.title.trim() : "";
    const year = typeof request.year === "string" && /^\d{4}$/.test(request.year) ? request.year : "";
    const mediaType = request.mediaType === "tv" ? "tv" : request.mediaType === "movie" ? "movie" : null;
    if (!title || title.length > 200 || !mediaType) return json(400, { error: "Invalid stream selection" });

    try {
        const items = await searchAllDebrid(`${title} ${year}`.trim(), process.env.ALLDEBRID_API_KEY);
        const normalizedTitle = normalizeTitle(title);
        let candidate = null;

        for (const item of items) {
            const itemTitle = normalizeTitle(item?.title || item?.name || item?.filename || "");
            const itemYear = String(item?.year || item?.release_year || item?.date || "").slice(0, 4);
            const titleMatches = itemTitle && normalizedTitle && (itemTitle === normalizedTitle || itemTitle.includes(normalizedTitle) || normalizedTitle.includes(itemTitle));
            const yearMatches = !year || !itemYear || itemYear === year;
            const link = extractLinks(item).find((value) => /^https?:\/\//i.test(value));
            if (!link) continue;
            if ((titleMatches && yearMatches) || (!candidate && titleMatches) || (!candidate && yearMatches)) candidate = link;
            if (titleMatches && yearMatches) break;
        }

        if (!candidate) candidate = extractLinks(items[0]).find((value) => /^https?:\/\//i.test(value));
        if (!candidate) return json(404, { error: "Stream not found" });

        const url = await unlockAllDebridLink(candidate, process.env.ALLDEBRID_API_KEY);
        return url ? json(200, { url }) : json(502, { error: "Stream unlock failed" });
    } catch {
        return json(502, { error: "Stream provider unavailable" });
    }
}

exports.handler = handler;
