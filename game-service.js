// Nebula — Valorant live API service
//
// Wraps the player-data (pd) and game-lifecycle (glz) endpoints for the
// Store / Nightmarket and Match Info features. Separate from auth-service.js
// so the main account-manager flow is never coupled to the live-API surface.
//
// All endpoints require:
//   - access_token (from SSID reauth / getCloudAuthTokens)
//   - entitlements_token
//   - X-Riot-ClientPlatform (already in auth-service)
//   - X-Riot-ClientVersion (fetched from valorant-api.com)
//
// Content lookups (skin → name/icon, agent → name, etc.) use the community
// valorant-api.com which is unauthenticated and free. Results are cached in
// memory for the lifetime of the main process.

const fetch = require('node-fetch');
const fs = require('fs').promises;

const RIOT_CLIENT_PLATFORM = Buffer.from(JSON.stringify({
    platformType: 'PC', platformOS: 'Windows',
    platformOSVersion: '10.0.19042.1.256.64bit', platformChipset: 'Unknown',
})).toString('base64');

// Region → pd/glz URL components.
//
// Riot's player-data endpoints live on FOUR physical shards — `pd.na`,
// `pd.eu`, `pd.ap`, `pd.kr`. BR and LATAM do NOT have their own pd shard
// (`pd.br.a.pvp.net` returns NXDOMAIN); they are served by `pd.na`.
//
// GLZ uses a two-part `glz-{regionTag}-1.{shard}` structure, so BR/LATAM
// keep their own region tag (for GLZ routing) while sharing the NA shard:
//   NA    → pd.na.a.pvp.net     + glz-na-1.na.a.pvp.net
//   BR    → pd.na.a.pvp.net     + glz-br-1.na.a.pvp.net
//   LATAM → pd.na.a.pvp.net     + glz-latam-1.na.a.pvp.net
//   EU    → pd.eu.a.pvp.net     + glz-eu-1.eu.a.pvp.net
//   AP    → pd.ap.a.pvp.net     + glz-ap-1.ap.a.pvp.net
//   KR    → pd.kr.a.pvp.net     + glz-kr-1.kr.a.pvp.net
const REGION_MAP = {
    NA:    { pdShard: 'na', glzRegion: 'na',    glzShard: 'na' },
    LATAM: { pdShard: 'na', glzRegion: 'latam', glzShard: 'na' },
    BR:    { pdShard: 'na', glzRegion: 'br',    glzShard: 'na' },
    EU:    { pdShard: 'eu', glzRegion: 'eu',    glzShard: 'eu' },
    AP:    { pdShard: 'ap', glzRegion: 'ap',    glzShard: 'ap' },
    KR:    { pdShard: 'kr', glzRegion: 'kr',    glzShard: 'kr' },
    PBE:   { pdShard: 'pbe', glzRegion: 'pbe',  glzShard: 'pbe' },
};

function regionInfo(region) {
    return REGION_MAP[(region || 'NA').toUpperCase()] || REGION_MAP.NA;
}

function pdUrl(region) {
    return `https://pd.${regionInfo(region).pdShard}.a.pvp.net`;
}

function glzUrl(region) {
    const r = regionInfo(region);
    return `https://glz-${r.glzRegion}-1.${r.glzShard}.a.pvp.net`;
}

// --- Riot Client version header (required by pd/glz endpoints) ---
let _cachedVersion = null;
async function getRiotClientVersion() {
    if (_cachedVersion) return _cachedVersion;
    try {
        const res = await fetch('https://valorant-api.com/v1/version');
        const data = await res.json();
        if (data.status === 200 && data.data?.riotClientVersion) {
            _cachedVersion = data.data.riotClientVersion;
            return _cachedVersion;
        }
    } catch { /* fall through */ }
    return 'release-09.02-shipping-62-2817827';
}

async function authHeaders(accessToken, entitlementsToken) {
    return {
        'Authorization': `Bearer ${accessToken}`,
        'X-Riot-Entitlements-JWT': entitlementsToken,
        'X-Riot-ClientPlatform': RIOT_CLIENT_PLATFORM,
        'X-Riot-ClientVersion': await getRiotClientVersion(),
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };
}

// Compact debug logger — prints HTTP method, status, URL path (no host noise)
// and a one-line summary of what came back. Easier to scan than full URLs.
function logCall(label, method, url, status, summary = '') {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const tag = status >= 200 && status < 300 ? '\x1b[32mOK\x1b[0m' : `\x1b[31m${status}\x1b[0m`;
    console.log(`[game] ${tag} ${method.padEnd(4)} ${label.padEnd(14)} ${path}${summary ? '  → ' + summary : ''}`);
}

// fetch with exponential backoff retry. Only retries on transient failures:
//   - network errors (thrown)
//   - HTTP 5xx
//   - HTTP 429 (rate limit) with respect for any `Retry-After` header
// Hard fails (401/403/404) return immediately with the original response so
// callers can handle them. Caps at 3 attempts by default to avoid hanging.
async function fetchWithRetry(url, options = {}, { maxAttempts = 3, baseDelayMs = 400 } = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const res = await fetch(url, options);
            // Success or hard failure — return immediately
            if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
                return res;
            }
            // Retryable: 5xx or 429
            if (attempt === maxAttempts) return res;
            // Respect Retry-After on 429
            let delay = baseDelayMs * Math.pow(2, attempt - 1);
            if (res.status === 429) {
                const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
                if (retryAfter > 0) delay = Math.min(retryAfter * 1000, 5000);
            }
            await new Promise(r => setTimeout(r, delay));
        } catch (e) {
            lastError = e;
            if (attempt === maxAttempts) throw e;
            await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, attempt - 1)));
        }
    }
    // Shouldn't reach here, but just in case
    if (lastError) throw lastError;
    throw new Error('fetchWithRetry exhausted attempts');
}

// ===========================================================================
// Content cache (valorant-api.com — unauthenticated)
// ===========================================================================

const contentCache = {
    skinLevels: null,   // { [uuid]: { name, icon, chromas } }
    agents: null,       // { [uuid]: { name, icon } }
    maps: null,         // { [uuid]: { name, splash } }
    buddyLevels: null,  // { [uuid]: { name, icon } }
    sprays: null,       // { [uuid]: { name, icon } }
    playerCards: null,  // { [uuid]: { name, wide, large, small } }
    ranks: null,        // tier number → { name, icon }
    seasons: null,      // { [uuid]: { name, parentName } } — "EPISODE 7 // ACT 2"
    bundles: null,      // { [uuid]: { name, description, icon } }
};

async function ensureSkinLevels() {
    if (contentCache.skinLevels) return contentCache.skinLevels;
    const res = await fetch('https://valorant-api.com/v1/weapons/skinlevels');
    const body = await res.json();
    const map = {};
    for (const s of body.data || []) {
        map[s.uuid] = { name: s.displayName, icon: s.displayIcon, streamedVideo: s.streamedVideo };
    }
    contentCache.skinLevels = map;
    return map;
}

async function ensureAgents() {
    if (contentCache.agents) return contentCache.agents;
    // No `isPlayableCharacter=true` filter — it excluded a couple of agents
    // around release windows and caused "Picking..." to show in Match Info
    // even after lock-in. Including every agent the API knows about is safer.
    // We also store each agent under both its lower-cased UUID (for safe
    // lookups regardless of how Riot returns the field) and original.
    const res = await fetch('https://valorant-api.com/v1/agents');
    const body = await res.json();
    const map = {};
    for (const a of body.data || []) {
        if (!a.uuid) continue;
        const entry = { name: a.displayName, icon: a.displayIconSmall || a.displayIcon, role: a.role?.displayName };
        map[a.uuid] = entry;
        map[a.uuid.toLowerCase()] = entry;
    }
    contentCache.agents = map;
    return map;
}

async function ensureMaps() {
    if (contentCache.maps) return contentCache.maps;
    const res = await fetch('https://valorant-api.com/v1/maps');
    const body = await res.json();
    const map = {};
    for (const m of body.data || []) {
        // Riot uses "mapUrl" as the identifier in match responses (e.g. /Game/Maps/Ascent/Ascent)
        if (m.mapUrl) map[m.mapUrl] = { name: m.displayName, splash: m.splash, listView: m.listViewIcon };
    }
    contentCache.maps = map;
    return map;
}

async function ensureRanks() {
    if (contentCache.ranks) return contentCache.ranks;
    const res = await fetch('https://valorant-api.com/v1/competitivetiers');
    const body = await res.json();
    // Use the latest tier set (last in array)
    const latest = (body.data || []).slice(-1)[0];
    const map = {};
    for (const t of latest?.tiers || []) {
        map[t.tier] = { name: t.tierName, icon: t.largeIcon || t.smallIcon, division: t.divisionName };
    }
    contentCache.ranks = map;
    return map;
}

async function ensurePlayerCards() {
    if (contentCache.playerCards) return contentCache.playerCards;
    const res = await fetch('https://valorant-api.com/v1/playercards');
    const body = await res.json();
    const map = {};
    for (const c of body.data || []) {
        map[c.uuid] = {
            name: c.displayName,
            wide: c.wideArt,
            large: c.largeArt,
            small: c.smallArt,
        };
    }
    contentCache.playerCards = map;
    return map;
}

// Buddies (gun charms). Bundles reference either the parent uuid or a
// buddy-level uuid. Map every level uuid to its PARENT's displayName —
// the level-level displayName is internal-y (e.g. "Ninja2" for level 2
// of the "Ninja" buddy) and not what we want to show.
async function ensureBuddyLevels() {
    if (contentCache.buddyLevels) return contentCache.buddyLevels;
    const res = await fetch('https://valorant-api.com/v1/buddies').then(r => r.json()).catch(() => ({ data: [] }));
    const map = {};
    for (const b of res.data || []) {
        map[b.uuid] = { name: b.displayName, icon: b.displayIcon };
        for (const lvl of b.levels || []) {
            map[lvl.uuid] = { name: b.displayName, icon: lvl.displayIcon || b.displayIcon };
        }
    }
    contentCache.buddyLevels = map;
    return map;
}

// Sprays. Same pattern — every level uuid resolves to the parent's clean
// displayName. fullTransparentIcon is preferred for parents (alpha channel
// reads well on dark cards).
async function ensureSprays() {
    if (contentCache.sprays) return contentCache.sprays;
    const res = await fetch('https://valorant-api.com/v1/sprays').then(r => r.json()).catch(() => ({ data: [] }));
    const map = {};
    for (const s of res.data || []) {
        const parentIcon = s.fullTransparentIcon || s.fullIcon || s.displayIcon;
        map[s.uuid] = { name: s.displayName, icon: parentIcon };
        for (const lvl of s.levels || []) {
            map[lvl.uuid] = { name: s.displayName, icon: lvl.displayIcon || parentIcon };
        }
    }
    contentCache.sprays = map;
    return map;
}

// Full skin catalog for the wishlist browser. One entry per skin (NOT per
// level — Riot's store daily offers use the level-1 UUID to represent the
// whole skin so we key on that too). Grouped by weapon, flattened for search.
let _skinCatalog = null;
// Second-layer filter: display-name patterns that identify skins we know
// aren't worth showing in the catalog. The primary filter is the live
// /store/v1/offers cross-reference, but the user wants VCT Classics
// excluded even though they're technically buyable — they're always in the
// team-vote capsule and clutter the list without offering new content.
// `/vct/i` (no word boundary) catches "VCT25", "VCT 2024", "VCT Champions",
// "VCT x TSM Classic", etc. — any skin with VCT anywhere in the name.
const NON_BUYABLE_NAME_PATTERNS = [
    /^standard /i,
    /^random favorite/i,
    /^melee$/i,                          // default melee weapon — every player owns it, not a skin
    /vct/i,                              // VCT25 x Team Classics, VCT Champions, VCT Capsule, etc.
    /champions? \d{4}/i,                 // "Champions 2021", "Champion 2022"
    /masters /i,                         // "Masters Tokyo", "Masters Madrid"
    /battle ?pass/i,
    /episode \d+ \/\/ act \d+/i,         // "Episode 7 // Act 2" style battlepass labels
    /game changers/i,
];

function isLikelyBuyable(skinName) {
    if (!skinName) return false;
    for (const re of NON_BUYABLE_NAME_PATTERNS) {
        if (re.test(skinName)) return false;
    }
    return true;
}

// Set of skin level UUIDs that come from a battlepass contract. Built once
// per session by walking valorant-api's `/v1/contracts` endpoint and
// identifying contracts that look like battlepasses.
//
// Discriminator: any contract whose chapters reward >= 5 skin levels in
// total. Battlepasses contain ~12-13 skins; the alternative "agent gear"
// contracts each contain exactly 1 (the signature melee). Name patterns
// vary across years ("IGNITION : ACT 1", "Season 2026 // Act II", etc.)
// so the count threshold is more reliable than name matching.
let _battlepassSkinIds = null;
async function ensureBattlepassSkinIds() {
    if (_battlepassSkinIds) return _battlepassSkinIds;
    const ids = new Set();
    try {
        const res = await fetch('https://valorant-api.com/v1/contracts');
        const body = await res.json();
        for (const contract of body.data || []) {
            const skinUuids = [];
            for (const ch of contract?.content?.chapters || []) {
                for (const lvl of ch.levels || []) {
                    if (lvl.reward?.type === 'EquippableSkinLevel' && lvl.reward.uuid) {
                        skinUuids.push(lvl.reward.uuid);
                    }
                }
                for (const fr of ch.freeRewards || []) {
                    if (fr.type === 'EquippableSkinLevel' && fr.uuid) {
                        skinUuids.push(fr.uuid);
                    }
                }
            }
            // 5+ skin rewards = battlepass; 1 = agent gear contract
            if (skinUuids.length >= 5) {
                for (const id of skinUuids) ids.add(id);
            }
        }
        console.log(`[game] battlepass exclusion set: ${ids.size} skin level UUIDs`);
    } catch (e) {
        console.warn(`[game] contracts fetch failed: ${e.message}`);
    }
    _battlepassSkinIds = ids;
    return ids;
}

async function ensureSkinCatalog() {
    if (_skinCatalog) return _skinCatalog;
    const [weaponsRes, battlepassIds] = await Promise.all([
        fetch('https://valorant-api.com/v1/weapons'),
        ensureBattlepassSkinIds(),
    ]);
    const body = await weaponsRes.json();
    const list = [];
    let bpFiltered = 0;
    for (const weapon of body.data || []) {
        const weaponName = weapon.displayName;
        const weaponCategory = weapon.shopData?.category || weapon.category || 'Other';
        for (const skin of weapon.skins || []) {
            // Level 1 UUID is the store-facing identifier — use it as the
            // wishlist key so matching with store offers works out of the box.
            const levelOne = skin.levels?.[0];
            if (!levelOne?.uuid) continue;
            if (!isLikelyBuyable(skin.displayName)) continue;
            // Cross-reference with battlepass contract rewards — these can't
            // be bought from the store and shouldn't appear in the wishlist
            // browser. Some battlepass skins eventually rotate into the
            // store via "Borealis" / re-release bundles, but the vast
            // majority don't, so excluding by default is the right call.
            if (battlepassIds.has(levelOne.uuid)) { bpFiltered++; continue; }
            // Image priority chain. Prefer chroma fullRender (the actual
            // in-game weapon art) over skin.displayIcon because
            // valorant-api.com serves a gray X placeholder as the
            // "official" displayIcon for some skins (e.g. Sovereign
            // Guardian) — the chromas and levels have the real renders.
            let icon = null;
            for (const ch of skin.chromas || []) { if (ch.fullRender) { icon = ch.fullRender; break; } }
            if (!icon) {
                for (const lvl of skin.levels || []) { if (lvl.displayIcon) { icon = lvl.displayIcon; break; } }
            }
            if (!icon) icon = skin.displayIcon || null;
            if (!icon) {
                for (const ch of skin.chromas || []) { if (ch.displayIcon) { icon = ch.displayIcon; break; } }
            }
            // Skip skins with no usable image at all — they'd just render
            // as broken/placeholder rows in the browser, which is what the
            // user reported.
            if (!icon) continue;
            list.push({
                uuid: levelOne.uuid,
                name: skin.displayName,
                icon,
                weapon: weaponName,
                category: weaponCategory,
            });
        }
    }
    list.sort((a, b) => a.weapon.localeCompare(b.weapon) || a.name.localeCompare(b.name));
    console.log(`[game] skin catalog built: ${list.length} buyable skins (${bpFiltered} battlepass excluded)`);
    _skinCatalog = list;
    return list;
}

// Featured bundles metadata — maps bundle UUIDs to display names + hero art.
// The storefront response gives us a bundle UUID under `FeaturedBundle.Bundle.DataAssetID`;
// this cache resolves it to a name + thumbnail for the UI.
async function ensureBundles() {
    if (contentCache.bundles) return contentCache.bundles;
    const res = await fetch('https://valorant-api.com/v1/bundles');
    const body = await res.json();
    const map = {};
    for (const b of body.data || []) {
        map[b.uuid] = {
            name: b.displayName,
            description: b.description,
            icon: b.displayIcon,
            verticalPromo: b.verticalPromoImage,
        };
    }
    contentCache.bundles = map;
    return map;
}

// Seasons list from valorant-api.com. Gotcha: episodes have `type: null` in
// this API (only acts have `type: "EAresSeasonType::Act"`). So we identify
// episodes by the absence of a parentUuid AND a display name starting with
// "EPISODE", then key acts by their parentUuid to assemble the full
// "EPISODE 10 · ACT 2" label.
async function ensureSeasons() {
    if (contentCache.seasons) return contentCache.seasons;
    const res = await fetch('https://valorant-api.com/v1/seasons');
    const body = await res.json();
    const raw = body.data || [];

    // Pass 1: collect episodes (top-level entries with no parent and a real name)
    const episodes = {};
    for (const s of raw) {
        if (!s.parentUuid && s.displayName && s.displayName !== 'Closed Beta') {
            episodes[s.uuid] = s.displayName;
        }
    }

    // Pass 2: build the act map, joining episode name via parentUuid
    const map = {};
    for (const s of raw) {
        if (s.type === 'EAresSeasonType::Act') {
            const episodeName = episodes[s.parentUuid] || '';
            map[s.uuid] = {
                name: s.displayName,
                parentName: episodeName,
                full: episodeName ? `${episodeName} · ${s.displayName}` : s.displayName,
                startTime: s.startTime || null,
                endTime: s.endTime || null,
            };
        }
    }
    // Also register episodes themselves under their own uuid so an MMR record
    // that somehow references the episode directly still resolves.
    for (const [uuid, name] of Object.entries(episodes)) {
        if (!map[uuid]) map[uuid] = { name, parentName: '', full: name, startTime: null, endTime: null };
    }

    contentCache.seasons = map;
    return map;
}

// ===========================================================================
// Storefront
// ===========================================================================

// Skin level entitlement type UUID — used with the /store/v1/entitlements
// endpoint to fetch the set of skin levels the player owns. There are other
// item type UUIDs for agents, buddies, sprays, cards, titles, etc., but we
// only care about skin levels for the daily store owned/unowned indicator.
const ITEM_TYPE_SKIN_LEVEL = 'e7c63390-eda7-46e0-bb7a-a6abdacd2433';

// All currently-buyable skin level UUIDs from /store/v1/offers. Riot's
// source of truth for "what can I actually buy right now". Anything NOT in
// this set (battlepass skins, VCT capsule items not currently cycled, agent
// contract rewards, etc.) is excluded from the browse-skins catalog.
// Cached session-lifetime — offers change only when a new act rolls out.
let _buyableSkinIds = null;
async function fetchBuyableSkinOfferIds({ accessToken, entitlementsToken, region }) {
    if (_buyableSkinIds) return _buyableSkinIds;
    const url = `${pdUrl(region)}/store/v1/offers`;
    try {
        const res = await fetchWithRetry(url, {
            headers: await authHeaders(accessToken, entitlementsToken),
        });
        if (!res.ok) {
            logCall('offers', 'GET', url, res.status);
            return new Set();
        }
        const data = await res.json();
        const ids = new Set();
        for (const offer of data?.Offers || []) {
            for (const reward of offer?.Rewards || []) {
                if (reward.ItemTypeID === ITEM_TYPE_SKIN_LEVEL && reward.ItemID) {
                    ids.add(reward.ItemID);
                }
            }
            // OfferID typically matches the skin level UUID too — add it as a fallback
            if (offer.OfferID) ids.add(offer.OfferID);
        }
        logCall('offers', 'GET', url, res.status, `${ids.size} buyable skin levels`);
        _buyableSkinIds = ids;
        return ids;
    } catch (e) {
        console.warn(`[game] offers fetch error: ${e.message}`);
        return new Set();
    }
}

async function fetchOwnedSkinLevels({ accessToken, entitlementsToken, region, puuid }) {
    const url = `${pdUrl(region)}/store/v1/entitlements/${puuid}/${ITEM_TYPE_SKIN_LEVEL}`;
    try {
        const res = await fetchWithRetry(url, {
            headers: await authHeaders(accessToken, entitlementsToken),
        });
        if (!res.ok) {
            logCall('entitlements', 'GET', url, res.status);
            return new Set();
        }
        const data = await res.json();
        const owned = new Set();
        for (const entry of data?.Entitlements ?? []) {
            const id = entry.ItemID ?? entry.itemID;
            if (id) owned.add(id);
        }
        logCall('entitlements', 'GET', url, res.status, `owned=${owned.size}`);
        return owned;
    } catch (e) {
        console.warn(`[game] entitlements error: ${e.message}`);
        return new Set();
    }
}

async function fetchStorefront({ accessToken, entitlementsToken, region, puuid }) {
    const url = `${pdUrl(region)}/store/v3/storefront/${puuid}`;
    const res = await fetchWithRetry(url, {
        method: 'POST',
        headers: await authHeaders(accessToken, entitlementsToken),
        body: '{}',
    });
    if (!res.ok) {
        logCall('storefront', 'POST', url, res.status);
        throw new Error(`Storefront HTTP ${res.status}`);
    }
    const data = await res.json();
    const dailyCount = data.SkinsPanelLayout?.SingleItemStoreOffers?.length || 0;
    const nmCount = data.BonusStore?.BonusStoreOffers?.length || 0;
    logCall('storefront', 'POST', url, res.status, `daily=${dailyCount} nightmarket=${nmCount}`);
    return data;
}

// Normalize a raw storefront response into a shape the renderer can consume
// directly. Resolves every skin UUID to { name, icon, price, owned } using the
// content cache + entitlements so the frontend doesn't need to make any
// follow-up lookups.
async function getStore(ctx) {
    const { accessToken, entitlementsToken, region, puuid } = ctx;
    // Buddies/sprays/cards needed alongside skins — bundles mix all four.
    const [raw, skins, bundles, owned, buddies, sprays, cards] = await Promise.all([
        fetchStorefront({ accessToken, entitlementsToken, region, puuid }),
        ensureSkinLevels(),
        ensureBundles(),
        fetchOwnedSkinLevels({ accessToken, entitlementsToken, region, puuid }),
        ensureBuddyLevels(),
        ensureSprays(),
        ensurePlayerCards(),
    ]);

    // Daily featured (SkinsPanelLayout)
    const daily = {
        remainingSeconds: raw.SkinsPanelLayout?.SingleItemOffersRemainingDurationInSeconds || 0,
        items: [],
    };
    const dailyIds = raw.SkinsPanelLayout?.SingleItemStoreOffers || [];
    for (const offer of dailyIds) {
        const skinUuid = offer.OfferID;
        const meta = skins[skinUuid] || { name: 'Unknown Skin', icon: null };
        const cost = Object.values(offer.Cost || {})[0] || 0;
        daily.items.push({
            uuid: skinUuid,
            name: meta.name,
            icon: meta.icon,
            cost,
            owned: owned.has(skinUuid),
        });
    }

    // Nightmarket (BonusStore) — only present when active
    let nightmarket = null;
    if (raw.BonusStore?.BonusStoreOffers?.length) {
        nightmarket = {
            remainingSeconds: raw.BonusStore.BonusStoreRemainingDurationInSeconds || 0,
            items: [],
        };
        for (const offer of raw.BonusStore.BonusStoreOffers) {
            const skinUuid = offer.Offer?.OfferID;
            const meta = skins[skinUuid] || { name: 'Unknown Skin', icon: null };
            const basePrice = Object.values(offer.Offer?.Cost || {})[0] || 0;
            const discounted = Object.values(offer.DiscountCosts || {})[0] || 0;
            const discountPct = offer.DiscountPercent || 0;
            nightmarket.items.push({
                uuid: skinUuid,
                name: meta.name,
                icon: meta.icon,
                basePrice,
                discountedPrice: discounted,
                discountPercent: discountPct,
                seen: !!offer.IsSeen,
                owned: owned.has(skinUuid),
            });
        }
    }

    // Featured bundle — the big hero bundle that rotates weekly. The v3
    // storefront response has `FeaturedBundle.Bundle` (single) or
    // `FeaturedBundle.Bundles[]` depending on version; check both.
    const featuredBundles = [];
    const bundleSources = raw.FeaturedBundle?.Bundles || (raw.FeaturedBundle?.Bundle ? [raw.FeaturedBundle.Bundle] : []);
    for (const b of bundleSources) {
        const bundleMeta = bundles[b.DataAssetID] || { name: 'Unknown Bundle', icon: null };
        const totalPrice = b.TotalBaseCost ? Object.values(b.TotalBaseCost)[0] : 0;
        const discountedTotal = b.TotalDiscountedCost ? Object.values(b.TotalDiscountedCost)[0] : totalPrice;
        const discountPct = b.TotalBaseCost && totalPrice > 0
            ? Math.round((1 - (discountedTotal / totalPrice)) * 100)
            : 0;
        const items = [];
        for (const item of b.Items || []) {
            const itemUuid = item.Item?.ItemID;
            // Try each cache by uuid — UUIDs are globally unique across
            // Riot content types, so whichever cache hits tells us what
            // the item is. Avoids dependency on the ItemTypeID dispatch
            // table (which differs across bundles for buddies/sprays).
            let meta = null;
            let kind = null;
            if (skins[itemUuid]) {
                meta = skins[itemUuid]; kind = 'skin';
            } else if (buddies[itemUuid]) {
                meta = buddies[itemUuid]; kind = 'buddy';
            } else if (sprays[itemUuid]) {
                meta = sprays[itemUuid]; kind = 'spray';
            } else if (cards[itemUuid]) {
                const c = cards[itemUuid];
                meta = { name: c.name, icon: c.wide || c.large || c.small };
                kind = 'card';
            }
            items.push({
                uuid: itemUuid,
                name: meta?.name || 'Bundle Item',
                icon: meta?.icon || null,
                kind,
                basePrice: item.BasePrice || 0,
                discountedPrice: item.DiscountedPrice || 0,
                owned: kind === 'skin' && owned.has(itemUuid),
            });
        }
        featuredBundles.push({
            uuid: b.DataAssetID,
            name: bundleMeta.name,
            icon: bundleMeta.icon,
            verticalPromo: bundleMeta.verticalPromo,
            totalPrice,
            discountedTotal,
            discountPct,
            remainingSeconds: b.DurationRemainingInSeconds || 0,
            items,
        });
    }

    // Accessory store (buddies/sprays/cards) — parsed light, not shown by default
    const accessories = {
        remainingSeconds: raw.AccessoryStore?.AccessoryStoreRemainingDurationInSeconds || 0,
        count: raw.AccessoryStore?.AccessoryStoreOffers?.length || 0,
    };

    return { daily, nightmarket, featuredBundles, accessories };
}

// ===========================================================================
// Name cache (process-lifetime) — backs the "yoinker" fallback.
//
// The live /name-service/v2/players endpoint increasingly returns empty
// gameName/tagLine for players Riot flagged with the newer server-side
// incognito enforcement. The research notes that /match-details/v1/matches
// STILL embeds real names in post-game responses with no incognito flag at
// all — so we pre-populate a puuid→name map from the user's recent match
// history and use it as a fallback in buildPlayer.
// ===========================================================================

const nameCache = new Map(); // puuid → { gameName, tagLine }
// Negative cache: puuids that Henrikdev returned 404 for. We DON'T re-ask
// the same dead puuids on every refresh — that would burn the rate limit
// for nothing. Entries expire after a week so we eventually retry in case
// Henrikdev's community cache picks them up later.
const henrikNegativeCache = new Map(); // puuid → timestamp of last 404
const HENRIK_NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Rank cache with short TTL — avoids re-fetching MMR for every player on
// manual Match Info refreshes. Ranks change slowly; 60s is plenty.
const rankCache = new Map(); // puuid → { rank, cachedAt }
const RANK_CACHE_TTL_MS = 60 * 1000;
// Match IDs we've already pulled details for during this session. Skipping
// them on subsequent populateNameCacheFromHistory calls saves N match-detail
// calls per refresh once the user has been playing for a while.
const processedMatches = new Set();
let nameCacheLastPopulatedAt = 0;
const NAME_CACHE_TTL_MS = 30 * 60 * 1000; // re-populate at most every 30 minutes
let nameCacheFilePath = null;
let nameCacheDirty = false;
let nameCacheSaveTimer = null;
// Auto-disable the match-history yoinker when Riot's incognito enforcement
// has flattened it. After 3 consecutive `withName === 0` populates we stop
// trying for the rest of the session — that's ~10 wasted match-detail
// calls saved every 30 min. Reset the counter the moment we see a populate
// recover any name (in case Riot rolls the change back).
let yoinkerEmptyStreak = 0;
const YOINKER_DISABLE_AFTER = 3;

// Load the persisted name cache from disk on startup. Called once by main
// with the user-data directory path. Failures are non-fatal — we just start
// with an empty in-memory map.
async function loadNameCache(filePath) {
    nameCacheFilePath = filePath;
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const obj = JSON.parse(raw);
        let count = 0;
        // File format: { [puuid]: {gameName, tagLine}, _henrikNeg: { [puuid]: timestamp } }.
        // The reserved `_henrikNeg` key holds the negative cache; everything
        // else is a positive entry. Old-format files (no _henrikNeg key)
        // still iterate cleanly because the loop skips _henrikNeg explicitly.
        const negatives = obj._henrikNeg || {};
        for (const [puuid, data] of Object.entries(obj)) {
            if (puuid === '_henrikNeg') continue;
            if (data?.gameName) { nameCache.set(puuid, data); count++; }
        }
        let negCount = 0;
        const now = Date.now();
        for (const [puuid, ts] of Object.entries(negatives)) {
            if (now - ts < HENRIK_NEGATIVE_TTL_MS) {
                henrikNegativeCache.set(puuid, ts);
                negCount++;
            }
        }
        console.log(`[game] name cache: loaded ${count} entries + ${negCount} negative-cache entries`);
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[game] name cache load failed: ${e.message}`);
    }
}

// Debounced save — coalesces multiple populate calls into one disk write.
function scheduleSaveCache() {
    if (!nameCacheFilePath || !nameCacheDirty) return;
    if (nameCacheSaveTimer) clearTimeout(nameCacheSaveTimer);
    nameCacheSaveTimer = setTimeout(async () => {
        nameCacheSaveTimer = null;
        if (!nameCacheDirty) return;
        try {
            const obj = Object.fromEntries(nameCache.entries());
            // Stash the negative cache under a reserved key so it persists with the
            // positive cache in a single file. UUIDs never start with underscores.
            obj._henrikNeg = Object.fromEntries(henrikNegativeCache.entries());
            await fs.writeFile(nameCacheFilePath, JSON.stringify(obj), 'utf-8');
            nameCacheDirty = false;
            console.log(`[game] name cache: saved ${nameCache.size} entries (+ ${henrikNegativeCache.size} negative)`);
        } catch (e) {
            console.warn(`[game] name cache save failed: ${e.message}`);
        }
    }, 1000);
}

// Optional `queue` param filters at the endpoint level (e.g. 'competitive').
// Omit it for the name-cache populate which wants every queue.
async function fetchMatchHistory({ accessToken, entitlementsToken, region, puuid }, limit = 20, queue = null) {
    const queueParam = queue ? `&queue=${queue}` : '';
    const url = `${pdUrl(region)}/match-history/v1/history/${puuid}?endIndex=${limit}${queueParam}`;
    try {
        const res = await fetchWithRetry(url, { headers: await authHeaders(accessToken, entitlementsToken) });
        if (!res.ok) {
            logCall('match-history', 'GET', url, res.status);
            return [];
        }
        const data = await res.json();
        const ids = (data.History || []).map(m => m.MatchID).filter(Boolean);
        logCall('match-history', 'GET', url, res.status, `${ids.length} matches${queue ? ` (${queue})` : ''}`);
        return ids;
    } catch (e) {
        console.warn(`[game] match-history error: ${e.message}`);
        return [];
    }
}

async function fetchMatchDetails({ accessToken, entitlementsToken, region }, matchId) {
    const url = `${pdUrl(region)}/match-details/v1/matches/${matchId}`;
    try {
        const res = await fetchWithRetry(url, { headers: await authHeaders(accessToken, entitlementsToken) });
        if (!res.ok) {
            logCall('match-details', 'GET', url, res.status);
            return null;
        }
        const data = await res.json();
        logCall('match-details', 'GET', url, res.status, `players=${data.players?.length || 0}`);
        return data;
    } catch (e) {
        console.warn(`[game] match-details error: ${e.message}`);
        return null;
    }
}

// Pre-populate the name cache from the user's recent matches. Cheap to call
// multiple times — TTL-guarded, and we skip any match-detail we've already
// pulled this session so repeated refreshes don't burn API quota re-fetching
// identical data.
async function populateNameCacheFromHistory(ctx) {
    if (Date.now() - nameCacheLastPopulatedAt < NAME_CACHE_TTL_MS) return;
    if (yoinkerEmptyStreak >= YOINKER_DISABLE_AFTER) return; // Riot patched it; don't waste calls
    nameCacheLastPopulatedAt = Date.now();

    const matchIds = await fetchMatchHistory(ctx, 10);
    if (!matchIds.length) return;
    const newMatchIds = matchIds.filter(id => !processedMatches.has(id));
    if (!newMatchIds.length) {
        console.log(`[game] name cache: no new matches (${matchIds.length} already processed)`);
        return;
    }
    console.log(`[game] name cache: fetching ${newMatchIds.length} new match(es), skipping ${matchIds.length - newMatchIds.length} already-processed`);

    const detailsList = await Promise.all(newMatchIds.map(id => fetchMatchDetails(ctx, id)));
    let changed = 0;
    let withName = 0, withoutName = 0;
    for (let i = 0; i < newMatchIds.length; i++) {
        processedMatches.add(newMatchIds[i]);
        const details = detailsList[i];
        if (!details?.players) continue;
        for (const p of details.players) {
            const subject = p.subject || p.Subject;
            const gameName = p.gameName || p.GameName;
            const tagLine = p.tagLine || p.TagLine;
            if (!subject) continue;
            if (gameName) {
                const existing = nameCache.get(subject);
                const newTag = tagLine || '';
                if (!existing || existing.gameName !== gameName || (existing.tagLine || '') !== newTag) {
                    nameCache.set(subject, { gameName, tagLine: newTag });
                    changed++;
                }
                withName++;
            } else {
                withoutName++;
            }
        }
    }
    // Always log the with/without breakdown — when `withName=0` across every
    // recent match, that's the signal that Riot has tightened server-side
    // incognito enforcement on /match-details/ too, killing the yoinker fallback.
    console.log(`[game] name cache populate: ${changed} new/updated · with=${withName} without=${withoutName} (total=${nameCache.size})`);
    if (withName === 0) {
        yoinkerEmptyStreak++;
        if (yoinkerEmptyStreak >= YOINKER_DISABLE_AFTER) {
            console.log(`[game] name cache populate: ${YOINKER_DISABLE_AFTER} consecutive empty pulls — disabling yoinker for this session`);
        }
    } else {
        // Recovered (Riot rolled back, or this account's region isn't yet
        // affected). Reset so future drops re-trigger the disable logic.
        if (yoinkerEmptyStreak > 0) console.log(`[game] name cache populate: yoinker recovered (${withName} names) — re-enabling`);
        yoinkerEmptyStreak = 0;
    }
    if (changed) {
        nameCacheDirty = true;
        scheduleSaveCache();
    }
}

// Last-resort lookup via Henrikdev's community Valorant API. This is a
// third-party service (api.henrikdev.xyz) that proxies Riot's APIs but
// crucially caches every puuid → name resolution it has ever served. For
// strangers blocked by Riot's server-side incognito, the only path to a
// name is hitting a service that cached the mapping BEFORE Riot enabled
// enforcement. Requires a free API key from https://docs.henrikdev.xyz.
async function resolveNameViaHenrikdev(puuid, apiKey) {
    if (!puuid || !apiKey) return null;
    const url = `https://api.henrikdev.xyz/valorant/v2/by-puuid/account/${encodeURIComponent(puuid)}`;
    try {
        const res = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'Authorization': apiKey,
            },
        });
        if (!res.ok) {
            if (res.status === 401) logCall('henrikdev', 'GET', url, res.status, 'invalid API key');
            else if (res.status === 404) {
                logCall('henrikdev', 'GET', url, res.status, 'not in their cache');
                // Stamp the negative cache so we don't re-ask for a week
                henrikNegativeCache.set(puuid, Date.now());
                nameCacheDirty = true;
            } else if (res.status === 429) logCall('henrikdev', 'GET', url, res.status, 'rate limited');
            else {
                const body = await res.text().catch(() => '');
                logCall('henrikdev', 'GET', url, res.status, body.slice(0, 100));
            }
            return null;
        }
        const json = await res.json();
        const name = json?.data?.name;
        const tag = json?.data?.tag;
        if (name && tag) {
            logCall('henrikdev', 'GET', url, res.status, `→ ${name}#${tag}`);
            // If this puuid was previously negative, clear it
            if (henrikNegativeCache.delete(puuid)) nameCacheDirty = true;
            return { gameName: name, tagLine: tag };
        }
        // Henrikdev's `data` has the puuid + metadata but `name`/`tag` came
        // back empty — Riot has flagged this puuid incognito at the source
        // (name-service strips it, match-details strips it, and Henrikdev's
        // cache now reflects that on its own refresh). Stamp the negative
        // cache so we don't burn rate limit re-asking for a week.
        if (json?.data && (name === '' || tag === '')) {
            logCall('henrikdev', 'GET', url, res.status, 'empty name (riot incognito at source)');
            henrikNegativeCache.set(puuid, Date.now());
            nameCacheDirty = true;
            return null;
        }
        // Unexpected shape — keep the body dump so we catch real API changes.
        const dump = JSON.stringify(json).slice(0, 300);
        logCall('henrikdev', 'GET', url, res.status, `unexpected body=${dump}`);
        return null;
    } catch (e) {
        console.warn(`[game] henrikdev error: ${e.message}`);
        return null;
    }
}

// Resolve "name#tag" → puuid via Henrikdev's by-name endpoint. Used by the
// "blacklist by Riot ID" feature — needs a real puuid because the blacklist
// has always been puuid-keyed (so flagging survives name changes). Throws
// with a user-friendly message on every failure path so the renderer can
// show it as-is in a toast.
async function resolvePuuidByRiotId(riotId, apiKey) {
    if (!apiKey) throw new Error('Henrikdev API key required. Set it in Settings.');
    if (!riotId || typeof riotId !== 'string') throw new Error('Riot ID is required.');
    const trimmed = riotId.trim();
    const hashIdx = trimmed.lastIndexOf('#');
    if (hashIdx <= 0 || hashIdx === trimmed.length - 1) {
        throw new Error('Invalid Riot ID — expected format "name#tag" (e.g. v1ni#cius).');
    }
    const name = trimmed.slice(0, hashIdx).trim();
    const tag = trimmed.slice(hashIdx + 1).trim();
    if (!name || !tag) throw new Error('Invalid Riot ID — name and tag must both be non-empty.');

    const url = `https://api.henrikdev.xyz/valorant/v2/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
    let res;
    try {
        res = await fetch(url, { headers: { 'Accept': 'application/json', 'Authorization': apiKey } });
    } catch (e) {
        throw new Error(`Lookup failed: ${e.message}`);
    }
    if (res.status === 401 || res.status === 403) {
        logCall('henrikdev.byname', 'GET', url, res.status, 'invalid API key');
        throw new Error('Henrikdev rejected the API key. Check Settings.');
    }
    if (res.status === 404) {
        logCall('henrikdev.byname', 'GET', url, res.status, 'not found');
        throw new Error(`No player found with Riot ID "${name}#${tag}". Check spelling and tag.`);
    }
    if (res.status === 429) {
        logCall('henrikdev.byname', 'GET', url, res.status, 'rate limited');
        throw new Error('Rate limited by Henrikdev. Try again in a minute.');
    }
    if (!res.ok) {
        logCall('henrikdev.byname', 'GET', url, res.status);
        throw new Error(`Lookup failed (HTTP ${res.status}).`);
    }
    const json = await res.json();
    const puuid = json?.data?.puuid;
    if (!puuid) throw new Error('Lookup succeeded but no puuid was returned.');
    // Riot IDs are case-insensitive on lookup, so prefer the canonical casing
    // from the response. Region is needed for matchlist queries downstream.
    const canonicalName = json?.data?.name || name;
    const canonicalTag = json?.data?.tag || tag;
    const region = (json?.data?.region || '').toLowerCase() || null;
    logCall('henrikdev.byname', 'GET', url, res.status, `→ ${puuid.slice(0, 8)} (${canonicalName}#${canonicalTag}, ${region || '?'})`);
    return { puuid, name: canonicalName, tag: canonicalTag, region };
}

// Build a name timeline for the target puuid from Henrikdev's stored
// matches. Henrikdev only annotates a fraction of stored matches with
// gameName/tag (newer ones; older matches are summary-only). We sort
// every match chronologically, and for each unnamed match in the gap
// BETWEEN two consecutive known observations of the same name, we
// attribute it to that name — that part is solid. Matches BEFORE the
// first known observation are NOT attributed (they're likely older
// Riot IDs Henrikdev didn't annotate; falsely claiming them for the
// oldest known name would misrepresent player history).
//
// Returns: { names: [...{ name, tag, knownFirstSeen, knownLastSeen,
// knownCount, inferredCount, isCurrent }], unattributedCount }.
//
// One Henrikdev call (stored-matches). 5-min in-memory cache keys by
// puuid|region so repeat lookups are free. Riot's match-details was
// tested as a name source and confirmed to return empty names on every
// player record (incognito enforcement); Henrikdev's annotated subset
// is the only viable input.
const nameHistoryCache = new Map(); // key: puuid|region → { result, cachedAt }
const NAME_HISTORY_TTL_MS = 5 * 60 * 1000;

async function getNameHistory(targetPuuid, region, apiKey) {
    if (!apiKey) throw new Error('Henrikdev API key required. Set it in Settings.');
    if (!targetPuuid) throw new Error('puuid required.');
    if (!region) throw new Error('region required.');

    const cacheKey = `${targetPuuid}|${region.toLowerCase()}`;
    const cached = nameHistoryCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < NAME_HISTORY_TTL_MS) {
        console.log(`[game] henrikdev.history: cache HIT for ${targetPuuid.slice(0, 8)}`);
        return cached.result;
    }

    const headers = { 'Accept': 'application/json', 'Authorization': apiKey };
    const reg = region.toLowerCase();
    const storedUrl = `https://api.henrikdev.xyz/valorant/v1/by-puuid/stored-matches/${encodeURIComponent(reg)}/${encodeURIComponent(targetPuuid)}`;

    // 429 retry with 3s backoff before bubbling the error.
    let stored;
    {
        const fetchStored = async (retried = false) => {
            const r = await fetch(storedUrl, { headers });
            if (r.status === 401 || r.status === 403) throw new Error('Henrikdev rejected the API key.');
            if (r.status === 429) {
                if (!retried) {
                    console.warn('[game] henrikdev.stored: 429, backing off 3s and retrying once');
                    await new Promise(rs => setTimeout(rs, 3000));
                    return fetchStored(true);
                }
                throw new Error('Rate limited by Henrikdev. Wait ~60s and try again.');
            }
            if (r.status === 404) { logCall('henrikdev.stored', 'GET', storedUrl, r.status, 'none cached'); return []; }
            if (!r.ok) { logCall('henrikdev.stored', 'GET', storedUrl, r.status); return []; }
            const j = await r.json();
            const arr = j?.data || [];
            logCall('henrikdev.stored', 'GET', storedUrl, r.status, `${arr.length} entries`);
            return arr;
        };
        stored = await fetchStored();
    }

    const targetLower = targetPuuid.toLowerCase();
    const getPuuid = (p) => (p?.puuid || p?.subject || p?.Subject || '').toString();

    // Locate the target's record inside a stored-match envelope. Stored-
    // matches puts the queried player's data in `stats`; we still try
    // alternate shapes defensively in case Henrikdev mixes formats.
    const findTargetPlayer = (m) => {
        if (m?.stats && getPuuid(m.stats).toLowerCase() === targetLower) return m.stats;
        if (m?.stats?.player) return m.stats.player;
        if (Array.isArray(m?.players)) {
            return m.players.find(p => getPuuid(p).toLowerCase() === targetLower) || null;
        }
        if (Array.isArray(m?.players?.all_players)) {
            return m.players.all_players.find(p => getPuuid(p).toLowerCase() === targetLower) || null;
        }
        return null;
    };

    // Build a chronological event list: [{ ts, name|null, tag|null }],
    // oldest first. `name` is null when Henrikdev didn't annotate the
    // match — those entries get attributed via the timeline walk below.
    const events = [];
    for (const m of stored) {
        const startedAtStr = m?.meta?.started_at || m?.meta?.startedAt
            || m?.metadata?.started_at || m?.metadata?.startedAt || null;
        if (!startedAtStr) continue;
        const ts = new Date(startedAtStr).getTime();
        if (!Number.isFinite(ts)) continue;
        const me = findTargetPlayer(m);
        const name = me?.name || me?.gameName || null;
        const tag = me?.tag || me?.tagLine || '';
        events.push({ ts, name: name || null, tag: name ? tag : null });
    }
    events.sort((a, b) => a.ts - b.ts);

    // Per-name aggregates. knownFirst/knownLast track ONLY confirmed
    // observation dates (Henrikdev annotated the match). knownCount /
    // inferredCount count matches accordingly. Unnamed matches before
    // any known observation are NOT attributed — they're surfaced
    // separately as `unattributedCount` so the user can see there's
    // missing history (likely older Riot IDs Henrikdev didn't annotate).
    const stats = new Map(); // key: name#tag → aggregate
    const bumpKnown = (key, name, tag, ts) => {
        const s = stats.get(key) || {
            name, tag, knownFirstSeen: ts, knownLastSeen: ts, knownCount: 0, inferredCount: 0,
        };
        if (ts < s.knownFirstSeen) s.knownFirstSeen = ts;
        if (ts > s.knownLastSeen) s.knownLastSeen = ts;
        s.knownCount++;
        stats.set(key, s);
    };
    const bumpInferred = (key) => {
        const s = stats.get(key);
        if (!s) return;
        s.inferredCount++;
    };

    let currentKey = null;
    let unattributedCount = 0;

    for (const e of events) {
        if (e.name) {
            currentKey = `${e.name}#${e.tag || ''}`;
            bumpKnown(currentKey, e.name, e.tag || '', e.ts);
        } else if (currentKey) {
            // Unnamed match AFTER first known observation — attribute to
            // most recent known name. Across rename boundaries the next
            // known observation switches currentKey on its iteration.
            bumpInferred(currentKey);
        } else {
            // Unnamed match BEFORE any known observation. Don't claim it
            // for any current name — could be one of N unknown older
            // Riot IDs Henrikdev never annotated.
            unattributedCount++;
        }
    }

    // Sort newest-active first. The name carrying the most recent KNOWN
    // observation is the player's current Riot ID.
    const namesList = Array.from(stats.values()).sort((a, b) => b.knownLastSeen - a.knownLastSeen);
    for (const n of namesList) n.isCurrent = `${n.name}#${n.tag}` === currentKey;

    const result = { names: namesList, unattributedCount };
    const knownEvents = events.filter(e => e.name).length;
    console.log(`[game] henrikdev.history: stored=${stored.length} events=${events.length} known=${knownEvents} → ${namesList.length} name period(s), ${unattributedCount} unattributed`);

    if (events.length > 0 && knownEvents === 0) {
        const sample = stored[0];
        console.warn(`[game] henrikdev.history: no name annotations at all. First match top-level keys: ${Object.keys(sample || {}).join(',')}`);
        if (sample?.stats) console.warn(`[game] henrikdev.history: stats keys: ${Object.keys(sample.stats).join(',')}`);
    }

    nameHistoryCache.set(cacheKey, { result, cachedAt: Date.now() });
    return result;
}

// ===========================================================================
// Match info (pregame + coregame)
// ===========================================================================

async function getCurrentMatchId({ accessToken, entitlementsToken, region, puuid }) {
    // Try coregame first (in-match). Fall back to pregame (agent select).
    const headers = await authHeaders(accessToken, entitlementsToken);

    const coreUrl = `${glzUrl(region)}/core-game/v1/players/${puuid}`;
    try {
        const res = await fetchWithRetry(coreUrl, { headers });
        if (res.ok) {
            const data = await res.json();
            if (data.MatchID) {
                logCall('coregame.player', 'GET', coreUrl, res.status, `matchId=${data.MatchID.slice(0, 8)}`);
                return { matchId: data.MatchID, phase: 'INGAME' };
            }
        }
        logCall('coregame.player', 'GET', coreUrl, res.status, 'no match');
    } catch (e) { console.warn(`[game] coregame.player error: ${e.message}`); }

    const preUrl = `${glzUrl(region)}/pregame/v1/players/${puuid}`;
    try {
        const res = await fetchWithRetry(preUrl, { headers });
        if (res.ok) {
            const data = await res.json();
            if (data.MatchID) {
                logCall('pregame.player', 'GET', preUrl, res.status, `matchId=${data.MatchID.slice(0, 8)}`);
                return { matchId: data.MatchID, phase: 'PREGAME' };
            }
        }
        logCall('pregame.player', 'GET', preUrl, res.status, 'no match');
    } catch (e) { console.warn(`[game] pregame.player error: ${e.message}`); }

    return null;
}

async function fetchPregameMatch({ accessToken, entitlementsToken, region, matchId }) {
    const url = `${glzUrl(region)}/pregame/v1/matches/${matchId}`;
    const res = await fetchWithRetry(url, { headers: await authHeaders(accessToken, entitlementsToken) });
    if (!res.ok) {
        logCall('pregame.match', 'GET', url, res.status);
        throw new Error(`Pregame HTTP ${res.status}`);
    }
    const data = await res.json();
    logCall('pregame.match', 'GET', url, res.status, `ally=${data.AllyTeam?.Players?.length || 0}`);
    return data;
}

async function fetchCoregameMatch({ accessToken, entitlementsToken, region, matchId }) {
    const url = `${glzUrl(region)}/core-game/v1/matches/${matchId}`;
    const res = await fetchWithRetry(url, { headers: await authHeaders(accessToken, entitlementsToken) });
    if (!res.ok) {
        logCall('coregame.match', 'GET', url, res.status);
        throw new Error(`Coregame HTTP ${res.status}`);
    }
    const data = await res.json();
    logCall('coregame.match', 'GET', url, res.status, `players=${data.Players?.length || 0}`);
    return data;
}

// Resolve puuids → { gameName, tagLine } via Riot's batched name-service.
// Batched up to 10 per request (Riot's documented cap). Empty gameName in
// the response means Riot is enforcing server-side incognito for that puuid
// and won't reveal the name — fall back to the match-details cache.
async function resolveNames({ accessToken, entitlementsToken, region, puuids }) {
    if (!puuids.length) return {};
    const headers = await authHeaders(accessToken, entitlementsToken);
    const map = {};

    for (let i = 0; i < puuids.length; i += 10) {
        const batch = puuids.slice(i, i + 10);
        const url = `${pdUrl(region)}/name-service/v2/players`;
        try {
            const res = await fetchWithRetry(url, { method: 'PUT', headers, body: JSON.stringify(batch) });
            if (!res.ok) {
                logCall('name-service', 'PUT', url, res.status);
                continue;
            }
            const arr = await res.json();
            let revealed = 0, hidden = 0;
            for (const p of arr || []) {
                map[p.Subject] = {
                    gameName: p.GameName || '',
                    tagLine: p.TagLine || '',
                    displayName: p.DisplayName || '',
                };
                if (p.GameName) revealed++; else hidden++;
            }
            logCall('name-service', 'PUT', url, res.status, `batch=${batch.length} revealed=${revealed} hidden=${hidden}`);
        } catch (e) {
            console.warn(`[game] name-service error: ${e.message}`);
        }
    }

    return map;
}

// Optional rank lookup — one call per player. Cached for 60s so rapid
// manual refreshes of Match Info don't re-fetch MMR for every player.
//
// Cache key includes region because the same puuid queried against the
// wrong shard returns placeholder data (Version=0 / null tier) and we don't
// want to memoize that under a key that the right-shard call would also hit.
//
// In-flight dedup via `rankInFlight` map: if a second call comes in while
// the first is still pending, both share the same Promise instead of firing
// duplicate requests. Important for "user mashes refresh" scenarios.
const rankInFlight = new Map();
async function resolveRank({ accessToken, entitlementsToken, region, puuid }) {
    const key = `${puuid}:${(region || 'NA').toUpperCase()}`;
    const cached = rankCache.get(key);
    if (cached && Date.now() - cached.cachedAt < RANK_CACHE_TTL_MS) return cached.rank;
    const inFlight = rankInFlight.get(key);
    if (inFlight) return inFlight;

    const promise = (async () => {
        const url = `${pdUrl(region)}/mmr/v1/players/${puuid}`;
        try {
            const res = await fetchWithRetry(url, { headers: await authHeaders(accessToken, entitlementsToken) });
            if (!res.ok) {
                logCall('mmr', 'GET', url, res.status);
                return null;
            }
            const data = await res.json();
            const latestSeason = data?.LatestCompetitiveUpdate;
            const tier = latestSeason?.TierAfterUpdate ?? latestSeason?.TierBeforeUpdate ?? 0;
            const rr = latestSeason?.RankedRatingAfterUpdate ?? 0;
            const rank = { tier, rr };
            rankCache.set(key, { rank, cachedAt: Date.now() });
            return rank;
        } catch (e) {
            console.warn(`[game] mmr error: ${e.message}`);
            return null;
        } finally {
            rankInFlight.delete(key);
        }
    })();
    rankInFlight.set(key, promise);
    return promise;
}

// Normalize whichever match phase we're in into a single response shape.
// `options.henrikdevApiKey` enables the Henrikdev community-cache fallback
// for puuids both name-service and the local match-history cache failed to
// resolve. Optional — skipped silently when no key is configured.
async function getMatchInfo({ accessToken, entitlementsToken, region, puuid }, options = {}) {
    const ctx = { accessToken, entitlementsToken, region, puuid };
    const current = await getCurrentMatchId(ctx);
    if (!current) return { inMatch: false };

    const { matchId, phase } = current;
    // Fire the post-game name cache populate in the BACKGROUND. It walks
    // up to 20 match-detail fetches which used to dominate the critical
    // path on the first match-info call after launch (sometimes 10+
    // seconds). The cache it builds is only a fallback for incognito-name
    // resolution on FUTURE calls — buildPlayer reads from `nameCache.get()`
    // which has whatever's already in memory + any persisted entries from
    // disk on app startup. First call may miss a freshly-changed name; the
    // second call always has it.
    populateNameCacheFromHistory(ctx).catch(() => {});

    const [agents, maps, ranks, playerCards] = await Promise.all([
        ensureAgents(),
        ensureMaps(),
        ensureRanks(),
        ensurePlayerCards(),
    ]);

    let raw, mapId, yourTeam, rawAllyPlayers, rawEnemyPlayers;

    if (phase === 'PREGAME') {
        raw = await fetchPregameMatch({ accessToken, entitlementsToken, region, matchId });
        mapId = raw.MapID;
        yourTeam = raw.AllyTeam?.TeamID;
        rawAllyPlayers = raw.AllyTeam?.Players || [];
        rawEnemyPlayers = []; // hidden until match starts
    } else {
        raw = await fetchCoregameMatch({ accessToken, entitlementsToken, region, matchId });
        mapId = raw.MapID;
        const me = (raw.Players || []).find(p => p.Subject === puuid);
        yourTeam = me?.TeamID;
        rawAllyPlayers = (raw.Players || []).filter(p => p.TeamID === yourTeam);
        rawEnemyPlayers = (raw.Players || []).filter(p => p.TeamID !== yourTeam);
    }

    const mapName = maps[mapId]?.name || 'Unknown';
    // Blue = attackers, Red = defenders (pre-OT; overtime swaps but we report the initial side)
    // Standard Valorant bomb-defusal maps: first half has Red = Attackers,
    // Blue = Defenders. Sides swap at halftime, but pregame/early-game shows
    // the starting side. Confirmed against vRY's reference implementation.
    const yourSide = yourTeam === 'Red' ? 'Attack' : 'Defense';

    // Fetch names + ranks in parallel.
    const allPuuids = [...rawAllyPlayers, ...rawEnemyPlayers].map(p => p.Subject).filter(Boolean);
    const [names, rankResults] = await Promise.all([
        resolveNames({ accessToken, entitlementsToken, region, puuids: allPuuids }),
        Promise.all(allPuuids.map(p => resolveRank({ accessToken, entitlementsToken, region, puuid: p }))),
    ]);
    const rankByPuuid = {};
    allPuuids.forEach((p, i) => { rankByPuuid[p] = rankResults[i]; });

    // Henrikdev community-cache fallback for puuids that BOTH name-service and
    // the local match-history cache failed to resolve. Last shot at getting
    // a name for true strangers — works because henrikdev has cached names
    // from millions of past lookups, including from before Riot's server-side
    // incognito enforcement kicked in. Skipped if no API key configured.
    if (options.henrikdevApiKey) {
        const now = Date.now();
        const stillUnresolved = allPuuids.filter(id => {
            const nameOk = names[id]?.gameName || names[id]?.displayName;
            const cacheOk = nameCache.get(id)?.gameName;
            if (nameOk || cacheOk) return false;
            // Skip puuids we already 404'd on within the negative-cache TTL
            const negTs = henrikNegativeCache.get(id);
            if (negTs && now - negTs < HENRIK_NEGATIVE_TTL_MS) return false;
            return true;
        });
        const skippedAsDead = allPuuids.filter(id => {
            const negTs = henrikNegativeCache.get(id);
            return negTs && now - negTs < HENRIK_NEGATIVE_TTL_MS && !names[id]?.gameName && !nameCache.get(id)?.gameName;
        }).length;

        if (stillUnresolved.length) {
            console.log(`[game] henrikdev fallback: trying ${stillUnresolved.length} puuid(s)${skippedAsDead ? ` (skipped ${skippedAsDead} known-dead)` : ''}`);
            const henrikResults = await Promise.all(
                stillUnresolved.map(p => resolveNameViaHenrikdev(p, options.henrikdevApiKey))
            );
            let hits = 0;
            stillUnresolved.forEach((id, i) => {
                if (henrikResults[i]) {
                    nameCache.set(id, henrikResults[i]);
                    nameCacheDirty = true;
                    hits++;
                }
            });
            if (hits || nameCacheDirty) scheduleSaveCache();
            console.log(`[game] henrikdev: ${hits}/${stillUnresolved.length} resolved`);
        } else if (skippedAsDead) {
            console.log(`[game] henrikdev fallback: all ${skippedAsDead} unresolved puuid(s) are in negative cache, skipped`);
        }
    }


    let resolvedNS = 0, resolvedCache = 0, totalHidden = 0;

    const buildPlayer = (p) => {
        const n = names[p.Subject];
        // Character id casing varies — coregame gives `CharacterID`, pregame
        // sometimes `characterId`. Check both and fall back to lowercased
        // lookup so a new agent released today still matches in our cache.
        const rawAgentId = p.CharacterID || p.characterId || '';
        const agentUuid = rawAgentId ? rawAgentId : null;
        let agent = null;
        if (agentUuid) {
            agent = agents[agentUuid] || agents[agentUuid.toLowerCase()];
            if (!agent) console.warn(`[game] agent id ${agentUuid} not in content cache (run refresh?)`);
        }
        const rank = rankByPuuid[p.Subject];
        const rankMeta = rank ? ranks[rank.tier] : null;

        // Player card art (wide background for their row in Match Info)
        const cardId = p.PlayerIdentity?.PlayerCardID;
        const cardMeta = cardId ? playerCards[cardId] : null;

        // Display name resolution (progressive fallback):
        //   1. name-service gameName#tagLine (primary, bypasses client-side incognito)
        //   2. name-service DisplayName field (some regions populate this instead)
        //   3. post-game name cache — populated from match-history+match-details,
        //      which embeds real names with no incognito flag, catching players
        //      that the newer server-side enforcement blocks in name-service
        //   4. "Hidden" — never seen in your recent matches either
        let displayName;
        if (n?.gameName) {
            displayName = `${n.gameName}#${n.tagLine}`;
            resolvedNS++;
        } else if (n?.displayName) {
            displayName = n.displayName;
            resolvedNS++;
        } else {
            const cached = nameCache.get(p.Subject);
            if (cached?.gameName) {
                displayName = `${cached.gameName}#${cached.tagLine}`;
                resolvedCache++;
                console.log(`[game]    cache HIT  ${p.Subject.slice(0, 8)} → ${displayName}`);
            } else {
                displayName = 'Hidden';
                totalHidden++;
                const inCache = nameCache.has(p.Subject);
                console.log(`[game]    HIDDEN     ${p.Subject.slice(0, 8)} (in cache: ${inCache ? 'yes (empty name)' : 'no'})`);
            }
        }

        // Smurf heuristic: low account level + high competitive rank.
        // Not definitive — pros often smurf on new accounts for streaming,
        // and some players hide level — but catches the common case.
        const level = p.PlayerIdentity?.AccountLevel || 0;
        const tier = rank?.tier || 0;
        const isSmurf = level > 0 && level < 40 && tier >= 17; // Diamond 1+ under level 40

        return {
            puuid: p.Subject,
            name: displayName,
            agent: agent ? { name: agent.name, icon: agent.icon, role: agent.role } : null,
            locked: p.CharacterSelectionState === 'locked',
            rank: rankMeta ? { tier: rank.tier, name: rankMeta.name, icon: rankMeta.icon, rr: rank.rr } : null,
            isIncognito: !!p.PlayerIdentity?.Incognito,
            accountLevel: level,
            card: cardMeta ? { id: cardId, wide: cardMeta.wide, large: cardMeta.large } : null,
            isSmurf,
            partyId: (options.partyMap && options.partyMap[p.Subject]) || null,
        };
    };

    // Pull out the user's own entry so we can surface their player card +
    // agent + rank at the top of the UI, then drop them from the ally list
    // to avoid duplicating them in the team view.
    const selfRawIndex = rawAllyPlayers.findIndex(p => p.Subject === puuid);
    const selfRaw = selfRawIndex >= 0 ? rawAllyPlayers[selfRawIndex] : null;
    const allyWithoutSelf = selfRawIndex >= 0
        ? [...rawAllyPlayers.slice(0, selfRawIndex), ...rawAllyPlayers.slice(selfRawIndex + 1)]
        : rawAllyPlayers;

    const self = selfRaw ? buildPlayer(selfRaw) : null;

    // Free-for-all detection: in DM and similar FFA modes, every player has
    // a unique TeamID so "ally" collapses to just the viewing player. When
    // that's the case, we flag the match as FFA and the frontend renders
    // a single "Players" panel instead of split ally/enemy panels.
    const isFreeForAll =
        phase === 'INGAME' &&
        allyWithoutSelf.length === 0 &&
        rawEnemyPlayers.length >= 2;

    const result = {
        inMatch: true,
        phase,
        matchId,
        isFreeForAll,
        map: { id: mapId, name: mapName, splash: maps[mapId]?.splash },
        yourSide,
        gameMode: raw.ModeID || raw.GameMode || 'Unknown',
        self,
        ally: allyWithoutSelf.map(buildPlayer),
        enemy: rawEnemyPlayers.map(buildPlayer),
    };


    console.log(`[game] resolution summary: name-service=${resolvedNS}, cache=${resolvedCache}, hidden=${totalHidden}, cache size=${nameCache.size}`);
    return result;
}

// Build the player's last-N act history from MMR seasonal data. Each entry
// is the rank the player ENDED that act in.
//
// Field semantics in QueueSkills.competitive.SeasonalInfoBySeasonID:
//   Rank            = HIGHEST tier ever achieved that season (peak)
//   CompetitiveTier = ending/current tier for that season
//   RankedRating    = ending RR (0-100 below Immortal, accumulating ladder
//                     points at Immortal+)
//   WinsByTier      = win count distribution across every tier touched
//
// Earlier code used `Rank || CompetitiveTier` which surfaced the peak —
// wrong for "ended in" semantics. Flipped to prefer CompetitiveTier so the
// badge matches what the player actually finished the act at.
function buildActHistory(mmrData, seasons, ranks, limit = 3, excludeSeasonId = null) {
    const seasonal = mmrData?.QueueSkills?.competitive?.SeasonalInfoBySeasonID || {};
    const entries = [];
    for (const [seasonId, season] of Object.entries(seasonal)) {
        if (excludeSeasonId && seasonId === excludeSeasonId) continue; // skip current act
        const meta = seasons[seasonId];
        if (!meta || !meta.startTime) continue; // skip episodes / unknown UUIDs
        const games = season?.NumberOfGames || 0;
        const winsByTier = season?.WinsByTier || {};
        const hadActivity = games > 0 || Object.keys(winsByTier).length > 0;
        if (!hadActivity) continue;
        const endTier = season.CompetitiveTier || season.Rank || 0;
        const peakTier = season.Rank || season.CompetitiveTier || 0;
        const rr = season.RankedRating || 0;
        const rankMeta = ranks[endTier];
        const peakMeta = ranks[peakTier];
        entries.push({
            seasonId,
            act: meta.full || meta.name,
            startTime: meta.startTime,
            tier: endTier,
            name: rankMeta?.name || 'Unranked',
            icon: rankMeta?.icon || null,
            peakTier,
            peakName: peakMeta?.name || null,
            rr,
            games,
        });
    }
    entries.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    return entries.slice(0, limit);
}

// Compute the ALL-TIME peak from the MMR response's seasonal data and
// identify the season (act) that peak was reached in. Returns
// { tier, rr, seasonId, games }.
//
// `QueueSkills.competitive.SeasonalInfoBySeasonID[season].WinsByTier` stores
// every tier the player has ever won at, across every act — this is the
// only source for historical peak tier beyond the 100-game window of the
// competitiveupdates endpoint.
//
// Selection logic:
//   1. First pass: find the highest tier the player ever hit (peakTier).
//   2. Second pass: among seasons that hit peakTier, prefer those where the
//      ENDING tier (CompetitiveTier/Rank) also equals peakTier. These are
//      the only seasons whose RankedRating field is meaningful for "peak RR"
//      — for any other season, RankedRating is the value at a LOWER tier
//      after dropping back down, which would misrepresent the player's peak.
//   3. Among matching seasons, pick the one with the highest RankedRating.
//   4. Tie-break by recency (most recent startTime wins).
//   5. If NO season ended at the peak tier, fall back to the most recent
//      season that hit it, and return RR=0 (we can't infer peak RR from
//      season-level data alone).
function findAllTimePeak(mmrData, seasonsMeta = {}) {
    const seasonal = mmrData?.QueueSkills?.competitive?.SeasonalInfoBySeasonID || {};

    // Pass 1: max tier ever hit
    let peakTier = 0;
    for (const season of Object.values(seasonal)) {
        for (const tierStr of Object.keys(season?.WinsByTier || {})) {
            const t = parseInt(tierStr, 10);
            if (t > peakTier) peakTier = t;
        }
        if ((season?.Rank ?? 0) > peakTier) peakTier = season.Rank;
        if ((season?.CompetitiveTier ?? 0) > peakTier) peakTier = season.CompetitiveTier;
    }
    if (peakTier === 0) return { tier: 0, rr: 0, seasonId: null, games: 0 };

    // Pass 2: collect all candidates that hit peakTier, with their effective
    // peak-RR (RankedRating only if they ended AT peakTier).
    const candidates = [];
    for (const [seasonId, season] of Object.entries(seasonal)) {
        const hitPeak =
            !!(season?.WinsByTier?.[String(peakTier)]) ||
            (season?.Rank ?? 0) === peakTier ||
            (season?.CompetitiveTier ?? 0) === peakTier;
        if (!hitPeak) continue;
        const endTier = (season?.CompetitiveTier ?? 0) || (season?.Rank ?? 0);
        const endedAtPeak = endTier === peakTier;
        const effRR = endedAtPeak ? (season?.RankedRating || 0) : 0;
        const startTime = seasonsMeta[seasonId]?.startTime
            ? new Date(seasonsMeta[seasonId].startTime).getTime()
            : 0;
        candidates.push({
            seasonId,
            endedAtPeak,
            effRR,
            startTime,
            games: season?.NumberOfGames || 0,
        });
    }

    // Sort: ended-at-peak first, then highest RR, then most recent.
    candidates.sort((a, b) => {
        if (a.endedAtPeak !== b.endedAtPeak) return a.endedAtPeak ? -1 : 1;
        if (b.effRR !== a.effRR) return b.effRR - a.effRR;
        return b.startTime - a.startTime;
    });

    const winner = candidates[0];
    return {
        tier: peakTier,
        rr: winner?.effRR || 0,
        seasonId: winner?.seasonId || null,
        games: winner?.games || 0,
    };
}

// Walks the competitiveupdates endpoint to find the highest (tier, RR) ever
// observed across recent rank changes. Riot caps per-request at 20 entries
// so we page through multiple calls to cover the most recent ~100 games.
// The `queue=competitive` param is required — without it the endpoint
// returns all queue types including unranked (tier=0) which skews results.
async function findPeakFromUpdates(ctx, targetPuuid) {
    let peakTier = 0, peakRR = 0;
    const headers = await authHeaders(ctx.accessToken, ctx.entitlementsToken);
    const PAGE = 20;
    const MAX_PAGES = 5; // up to 100 recent competitive matches

    for (let page = 0; page < MAX_PAGES; page++) {
        const start = page * PAGE;
        const end = start + PAGE;
        const url = `${pdUrl(ctx.region)}/mmr/v1/players/${targetPuuid}/competitiveupdates?startIndex=${start}&endIndex=${end}&queue=competitive`;
        try {
            const res = await fetchWithRetry(url, { headers });
            if (!res.ok) {
                logCall('competitiveupdates', 'GET', url, res.status);
                break;
            }
            const data = await res.json();
            const matches = data?.Matches || [];
            if (page === 0) logCall('competitiveupdates', 'GET', url, res.status, `${matches.length} updates`);
            if (!matches.length) break;
            for (const update of matches) {
                const tier = update.TierAfterUpdate ?? 0;
                const rr = update.RankedRatingAfterUpdate ?? 0;
                if (tier > peakTier || (tier === peakTier && rr > peakRR)) {
                    peakTier = tier;
                    peakRR = rr;
                }
            }
            if (matches.length < PAGE) break; // last page
        } catch (e) {
            console.warn(`[game] competitiveupdates error: ${e.message}`);
            break;
        }
    }
    return { tier: peakTier, rr: peakRR };
}

// Lightweight rank-only fetch used by the Account Manager tab to display a
// rank badge next to each account. Current tier + RR from the MMR endpoint,
// all-time peak tier + act from QueueSkills.SeasonalInfoBySeasonID,
// peak RR from recent competitiveupdates (best-effort).
async function getAccountRank(ctx) {
    const [ranks, seasons] = await Promise.all([ensureRanks(), ensureSeasons()]);
    const url = `${pdUrl(ctx.region)}/mmr/v1/players/${ctx.puuid}`;
    try {
        const [mmrRes, recentPeak] = await Promise.all([
            fetchWithRetry(url, { headers: await authHeaders(ctx.accessToken, ctx.entitlementsToken) }),
            findPeakFromUpdates(ctx, ctx.puuid),
        ]);
        if (!mmrRes.ok) {
            logCall('mmr.account', 'GET', url, mmrRes.status);
            return null;
        }
        const data = await mmrRes.json();
        const latest = data?.LatestCompetitiveUpdate;
        const currentTier = latest?.TierAfterUpdate ?? latest?.TierBeforeUpdate ?? 0;
        const currentRR = latest?.RankedRatingAfterUpdate ?? 0;
        const currentSeasonId = latest?.SeasonID;
        const currentAct = currentSeasonId ? seasons[currentSeasonId]?.full : null;

        // Peak rank: tier + season + games. Riot only exposes the season's
        // ENDING RR via SeasonalInfoBySeasonID — never the in-act peak RR —
        // so the UI doesn't display peak RR (would be misleading) and we
        // don't bother computing it. Tier is still the player's actual peak
        // because findAllTimePeak walks WinsByTier, which records every
        // tier ever won at.
        const allTimePeak = findAllTimePeak(data, seasons);
        let peakTier = allTimePeak.tier;
        let peakSeasonId = allTimePeak.seasonId;
        let peakGames = allTimePeak.games;
        if (currentTier > peakTier) {
            peakTier = currentTier;
            peakSeasonId = currentSeasonId;
            peakGames = data?.QueueSkills?.competitive?.SeasonalInfoBySeasonID?.[currentSeasonId]?.NumberOfGames || 0;
        }
        // recentPeak (from competitiveupdates) can still bump the tier if
        // there's been a promotion in the last ~100 games that hasn't been
        // committed to SeasonalInfoBySeasonID yet.
        if (recentPeak.tier > peakTier) {
            peakTier = recentPeak.tier;
            peakSeasonId = currentSeasonId;
            peakGames = data?.QueueSkills?.competitive?.SeasonalInfoBySeasonID?.[currentSeasonId]?.NumberOfGames || 0;
        }

        const currentSeasonal = currentSeasonId ? data?.QueueSkills?.competitive?.SeasonalInfoBySeasonID?.[currentSeasonId] : null;
        const currentGames = currentSeasonal?.NumberOfGames || 0;

        const currentMeta = ranks[currentTier];
        const peakMeta = ranks[peakTier];
        const peakAct = peakSeasonId ? seasons[peakSeasonId]?.full : null;
        logCall('mmr.account', 'GET', url, mmrRes.status, `cur=${currentTier}/${currentRR}/${currentAct || '?'}/${currentGames}g peak=${peakTier}/${peakAct || '?'}/${peakGames}g`);
        return {
            current: currentMeta ? { tier: currentTier, name: currentMeta.name, icon: currentMeta.icon, rr: currentRR, act: currentAct, games: currentGames } : null,
            peak: peakMeta ? { tier: peakTier, name: peakMeta.name, icon: peakMeta.icon, act: peakAct, games: peakGames } : null,
        };
    } catch (e) {
        console.warn(`[game] account rank error: ${e.message}`);
        return null;
    }
}

// Walks a match-details response for a specific player and computes HS%,
// damage dealt/received, and rounds played. Returns null if the round-level
// data isn't present (old matches / certain modes).
function computePerMatchShotStats(details, targetPuuid) {
    const rounds = details?.roundResults ?? details?.RoundResults ?? [];
    if (!rounds.length) return null;
    let hs = 0, bs = 0, ls = 0;
    let dmgDealt = 0, dmgReceived = 0;
    let roundsCounted = 0;

    for (const round of rounds) {
        const playerStatsArr = round.playerStats ?? round.PlayerStats ?? [];
        const me = playerStatsArr.find(p => (p.subject ?? p.Subject) === targetPuuid);
        if (!me) continue;
        roundsCounted++;

        const damageArr = me.damage ?? me.Damage ?? [];
        for (const dmg of damageArr) {
            hs += Number(dmg.headshots ?? dmg.Headshots ?? 0);
            bs += Number(dmg.bodyshots ?? dmg.Bodyshots ?? 0);
            ls += Number(dmg.legshots ?? dmg.Legshots ?? 0);
            dmgDealt += Number(dmg.damage ?? dmg.Damage ?? 0);
        }
        // Damage received: walk OTHER players' damage arrays for entries targeting us
        for (const other of playerStatsArr) {
            if ((other.subject ?? other.Subject) === targetPuuid) continue;
            const otherDamage = other.damage ?? other.Damage ?? [];
            for (const dmg of otherDamage) {
                if ((dmg.receiver ?? dmg.Receiver) === targetPuuid) {
                    dmgReceived += Number(dmg.damage ?? dmg.Damage ?? 0);
                }
            }
        }
    }

    const totalShots = hs + bs + ls;
    return {
        headshots: hs,
        bodyshots: bs,
        legshots: ls,
        hsPercent: totalShots > 0 ? Math.round((hs / totalShots) * 100) : 0,
        damageDealt: dmgDealt,
        damageReceived: dmgReceived,
        roundsPlayed: roundsCounted,
    };
}

// Full player stats for the click-to-inspect modal. Combines MMR (current +
// peak with RR + peak act name) and the last 10 competitive matches with
// per-match KDA, score, HS%, ACS, and DDΔ.
async function getPlayerStats(ctx, targetPuuid) {
    const [ranks, agents, maps, seasons] = await Promise.all([
        ensureRanks(), ensureAgents(), ensureMaps(), ensureSeasons(),
    ]);
    const headers = await authHeaders(ctx.accessToken, ctx.entitlementsToken);

    // 1. MMR current + all-time peak (parallelized MMR + competitiveupdates).
    let current = null, peak = null, actHistory = [];
    try {
        const mmrUrl = `${pdUrl(ctx.region)}/mmr/v1/players/${targetPuuid}`;
        const [res, recentPeak] = await Promise.all([
            fetchWithRetry(mmrUrl, { headers }),
            findPeakFromUpdates(ctx, targetPuuid),
        ]);
        if (res.ok) {
            const data = await res.json();
            const latest = data?.LatestCompetitiveUpdate;
            const curTier = latest?.TierAfterUpdate ?? latest?.TierBeforeUpdate ?? 0;
            const curRR = latest?.RankedRatingAfterUpdate ?? 0;
            const curSeasonId = latest?.SeasonID;
            const curAct = curSeasonId ? seasons[curSeasonId]?.full : null;

            // Peak rank: tier + season + games. Peak RR is intentionally NOT
            // computed because Riot only exposes per-season ENDING RR, never
            // in-act peak RR — surfacing the ending value misled users into
            // thinking it was their actual peak. Tier comes from
            // findAllTimePeak which walks WinsByTier (every tier ever won at).
            const allTime = findAllTimePeak(data, seasons);
            let peakTier = allTime.tier;
            let peakSeasonId = allTime.seasonId;
            let peakGames = allTime.games;
            if (curTier > peakTier) {
                peakTier = curTier;
                peakSeasonId = curSeasonId;
                peakGames = data?.QueueSkills?.competitive?.SeasonalInfoBySeasonID?.[curSeasonId]?.NumberOfGames || 0;
            }
            if (recentPeak.tier > peakTier) {
                peakTier = recentPeak.tier;
                peakSeasonId = curSeasonId;
                peakGames = data?.QueueSkills?.competitive?.SeasonalInfoBySeasonID?.[curSeasonId]?.NumberOfGames || 0;
            }

            const currentSeasonal = curSeasonId ? data?.QueueSkills?.competitive?.SeasonalInfoBySeasonID?.[curSeasonId] : null;
            const currentGames = currentSeasonal?.NumberOfGames || 0;

            const peakAct = peakSeasonId ? seasons[peakSeasonId]?.full : null;
            current = ranks[curTier] ? { tier: curTier, name: ranks[curTier].name, icon: ranks[curTier].icon, rr: curRR, act: curAct, games: currentGames } : null;
            peak = ranks[peakTier] ? { tier: peakTier, name: ranks[peakTier].name, icon: ranks[peakTier].icon, act: peakAct, games: peakGames } : null;
            // Last 3 acts the player played, EXCLUDING the current act — the
            // current act has its own card already and showing it twice is
            // redundant. Pass the current season id so buildActHistory can
            // skip it.
            actHistory = buildActHistory(data, seasons, ranks, 3, curSeasonId);
            logCall('stats.mmr', 'GET', mmrUrl, res.status, `cur=${curTier}/${curRR}/${curAct || '?'}/${currentGames}g peak=${peakTier}/${peakAct || '?'}/${peakGames}g acts=${actHistory.length}`);
        }
    } catch (e) { console.warn(`[game] stats.mmr error: ${e.message}`); }

    // 2. Match history (recent 10 competitive) + per-match details
    const historyMatchIds = (await fetchMatchHistory({ ...ctx, puuid: targetPuuid }, 10, 'competitive')).slice(0, 10);
    const matchDetails = await Promise.all(historyMatchIds.map(id => fetchMatchDetails(ctx, id)));

    const matches = [];
    // Aggregates across all fetched matches
    let wins = 0, losses = 0;
    let totalKills = 0, totalDeaths = 0, totalAssists = 0;
    let totalScore = 0, totalRounds = 0;
    let totalHeadshots = 0, totalTrackedShots = 0;
    let totalDmgDealt = 0, totalDmgReceived = 0;

    for (const details of matchDetails) {
        if (!details?.players || !details?.matchInfo) continue;
        const me = details.players.find(p => (p.subject ?? p.Subject) === targetPuuid);
        if (!me) continue;

        const stats = me.stats ?? me.Stats ?? {};
        const k = Number(stats.kills ?? stats.Kills ?? 0);
        const d = Number(stats.deaths ?? stats.Deaths ?? 0);
        const a = Number(stats.assists ?? stats.Assists ?? 0);
        const score = Number(stats.score ?? stats.Score ?? 0);
        const roundsPlayed = Number(stats.roundsPlayed ?? stats.RoundsPlayed ?? 0);
        totalKills += k; totalDeaths += d; totalAssists += a;
        totalScore += score; totalRounds += roundsPlayed;

        const myTeamId = me.teamId ?? me.TeamID;
        const teams = details.teams ?? details.Teams ?? [];
        const myTeam = teams.find(t => (t.teamId ?? t.TeamID) === myTeamId);
        const enemyTeam = teams.find(t => (t.teamId ?? t.TeamID) !== myTeamId);
        const won = Boolean(myTeam?.won ?? myTeam?.Won);
        if (won) wins++; else losses++;

        const myRounds = Number(myTeam?.roundsWon ?? myTeam?.RoundsWon ?? 0);
        const enemyRounds = Number(enemyTeam?.roundsWon ?? enemyTeam?.RoundsWon ?? 0);
        const scoreStr = `${myRounds}-${enemyRounds}`;

        // Per-match ACS, HS%, DDΔ, ADR
        const acs = roundsPlayed > 0 ? Math.round(score / roundsPlayed) : 0;
        const shotStats = computePerMatchShotStats(details, targetPuuid);
        const hsPercent = shotStats?.hsPercent ?? 0;
        const adr = shotStats && shotStats.roundsPlayed > 0
            ? Math.round(shotStats.damageDealt / shotStats.roundsPlayed)
            : 0;
        const ddDelta = shotStats && shotStats.roundsPlayed > 0
            ? Math.round((shotStats.damageDealt - shotStats.damageReceived) / shotStats.roundsPlayed)
            : 0;
        if (shotStats) {
            totalHeadshots += shotStats.headshots;
            totalTrackedShots += shotStats.headshots + shotStats.bodyshots + shotStats.legshots;
            totalDmgDealt += shotStats.damageDealt;
            totalDmgReceived += shotStats.damageReceived;
        }

        const agentId = me.characterId ?? me.CharacterID;
        const mapId = details.matchInfo.mapId ?? details.matchInfo.MapId;
        const queueId = details.matchInfo.queueId ?? details.matchInfo.QueueID ?? '';
        const agent = agents[agentId];
        const mapMeta = maps[mapId];
        matches.push({
            matchId: details.matchInfo.matchId ?? details.matchInfo.MatchId,
            map: mapMeta?.name ?? 'Unknown',
            agent: agent ? { uuid: agentId, name: agent.name, icon: agent.icon } : null,
            kills: k, deaths: d, assists: a,
            won,
            score: scoreStr,
            acs,
            hsPercent,
            adr,
            ddDelta,
            queueId,
            gameStart: details.matchInfo.gameStartMillis ?? details.matchInfo.GameStartMillis ?? 0,
        });
    }

    const kd = totalDeaths > 0 ? (totalKills / totalDeaths) : totalKills;
    const winRate = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;
    const avgAcs = totalRounds > 0 ? Math.round(totalScore / totalRounds) : 0;
    const avgHsPercent = totalTrackedShots > 0 ? Math.round((totalHeadshots / totalTrackedShots) * 100) : 0;
    const avgAdr = totalRounds > 0 ? Math.round(totalDmgDealt / totalRounds) : 0;
    const avgDdDelta = totalRounds > 0 ? Math.round((totalDmgDealt - totalDmgReceived) / totalRounds) : 0;

    return {
        puuid: targetPuuid,
        current,
        peak,
        actHistory,
        recent: {
            wins, losses,
            kd: Math.round(kd * 100) / 100,
            winRate,
            kills: totalKills, deaths: totalDeaths, assists: totalAssists,
            acs: avgAcs,
            hsPercent: avgHsPercent,
            adr: avgAdr,
            ddDelta: avgDdDelta,
        },
        matches,
    };
}

// Today's session stats for the Account Manager "Today: 8W 4L · +40 RR"
// widget. Fetches the account's last 20 competitive matches, filters to
// those started after local midnight, computes W/L + K/D + RR delta.
// Returns null if the account has no competitive data today.
async function getSessionStats(ctx) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const cutoffMs = todayStart.getTime();

    // Fetch competitive history then details in parallel for matches that
    // started today. Cap at 20 history entries — nobody plays >20 comp games
    // in a single day (and if they do, the oldest aren't session stats).
    const historyIds = await fetchMatchHistory(ctx, 20, 'competitive');
    if (!historyIds.length) return null;

    const detailsList = await Promise.all(historyIds.map(id => fetchMatchDetails(ctx, id)));
    let wins = 0, losses = 0, k = 0, d = 0, a = 0;
    let rrDelta = 0;
    let games = 0;

    for (const details of detailsList) {
        if (!details?.matchInfo || !details?.players) continue;
        const started = details.matchInfo.gameStartMillis || details.matchInfo.GameStartMillis || 0;
        if (started < cutoffMs) continue; // before midnight → not today
        const me = details.players.find(p => (p.subject ?? p.Subject) === ctx.puuid);
        if (!me) continue;
        games++;
        const stats = me.stats ?? me.Stats ?? {};
        k += Number(stats.kills ?? stats.Kills ?? 0);
        d += Number(stats.deaths ?? stats.Deaths ?? 0);
        a += Number(stats.assists ?? stats.Assists ?? 0);
        const myTeamId = me.teamId ?? me.TeamID;
        const teams = details.teams ?? details.Teams ?? [];
        const myTeam = teams.find(t => (t.teamId ?? t.TeamID) === myTeamId);
        if (myTeam?.won || myTeam?.Won) wins++; else losses++;
    }

    if (!games) return null;

    // RR delta: walk today's competitiveupdates (page 1 is plenty)
    try {
        const url = `${pdUrl(ctx.region)}/mmr/v1/players/${ctx.puuid}/competitiveupdates?startIndex=0&endIndex=20&queue=competitive`;
        const res = await fetchWithRetry(url, {
            headers: await authHeaders(ctx.accessToken, ctx.entitlementsToken),
        });
        if (res.ok) {
            const data = await res.json();
            for (const update of data?.Matches || []) {
                const ts = update.MatchStartTime ?? 0;
                if (ts < cutoffMs) break; // updates are newest-first, stop at yesterday
                rrDelta += Number(update.RankedRatingEarned ?? 0);
            }
        }
    } catch { /* RR delta best-effort */ }

    const kd = d > 0 ? Math.round((k / d) * 100) / 100 : k;
    return { games, wins, losses, kd, kills: k, deaths: d, assists: a, rrDelta };
}

module.exports = {
    getStore,
    getMatchInfo,
    getAccountRank,
    getPlayerStats,
    getSessionStats,
    ensureSkinCatalog,
    fetchBuyableSkinOfferIds,
    loadNameCache,
    resolvePuuidByRiotId,
    getNameHistory,
    // exposed for testing / diagnostics
    _ensureSkinLevels: ensureSkinLevels,
    _ensureAgents: ensureAgents,
};
