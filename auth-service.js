const fetch = require('node-fetch');
const crypto = require('crypto');
const https = require('https');
const zlib = require('zlib');

// Constants
const AUTH_ENDPOINTS = {
  AUTHORIZE: 'https://auth.riotgames.com/authorize',
  ENTITLEMENTS: 'https://entitlements.auth.riotgames.com/api/token/v1',
  USERINFO: 'https://auth.riotgames.com/userinfo',
};

const RIOT_CLIENT_PLATFORM = Buffer.from(JSON.stringify({
  platformType: 'PC', platformOS: 'Windows',
  platformOSVersion: '10.0.19042.1.256.64bit', platformChipset: 'Unknown'
})).toString('base64');

// Region to SGP shard mapping for player-preferences
const REGION_SGP_MAP = {
  'NA': 'usw2', 'LATAM': 'usw2', 'BR': 'usw2',
  'EU': 'euc1', 'AP': 'apse1', 'KR': 'apne1',
};

// TLS cipher suites that match the real Riot Client fingerprint (bypasses Cloudflare)
const RIOT_CIPHERS = [
  'TLS_CHACHA20_POLY1305_SHA256', 'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-AES128-SHA', 'ECDHE-RSA-AES128-SHA',
  'ECDHE-ECDSA-AES256-SHA', 'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256', 'AES256-GCM-SHA384', 'AES128-SHA', 'AES256-SHA', 'DES-CBC3-SHA',
].join(':');

const RIOT_SIGALGS = [
  'ecdsa_secp256r1_sha256', 'rsa_pss_rsae_sha256', 'rsa_pkcs1_sha256',
  'ecdsa_secp384r1_sha384', 'rsa_pss_rsae_sha384', 'rsa_pkcs1_sha384',
  'rsa_pss_rsae_sha512', 'rsa_pkcs1_sha512', 'rsa_pkcs1_sha1',
].join(':');

const riotAgent = new https.Agent({
  ciphers: RIOT_CIPHERS, sigalgs: RIOT_SIGALGS,
  secureOptions: crypto.constants.SSL_OP_NO_ENCRYPT_THEN_MAC,
  minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3',
  rejectUnauthorized: false, ALPNProtocols: ['http/1.1'], keepAlive: true,
});

let _cachedBuild = null;
async function getRiotClientBuild() {
  if (_cachedBuild) return _cachedBuild;
  try {
    const res = await fetch('https://valorant-api.com/v1/version');
    const data = await res.json();
    if (data.status === 200 && data.data?.riotClientBuild) {
      _cachedBuild = data.data.riotClientBuild;
      return _cachedBuild;
    }
  } catch (e) { /* fallback */ }
  return '111.0.0.3261.5663';
}

async function getRiotHeaders() {
  const build = await getRiotClientBuild();
  return {
    'Content-Type': 'application/json',
    'User-Agent': `RiotClient/${build} rso-auth (Windows;10;;Professional, x64)`,
    'Accept': 'application/json',
    'Cache-Control': 'no-cache',
  };
}

class AuthService {
  constructor(store) {
    this.store = store;
    this.accounts = this.store.get('accounts', []);
    // safeStorage is lazy-loaded to ensure it's available after app.ready
    this._safeStorage = null;
  }

  _getSafeStorage() {
    if (!this._safeStorage) {
      this._safeStorage = require('electron').safeStorage;
    }
    return this._safeStorage;
  }

  // --- Cookie Storage (safeStorage-backed) ---

  async storeCookiesSecurely(accountId, cookies) {
    if (!cookies || typeof cookies !== 'object') throw new Error('Invalid cookies.');
    const safe = this._getSafeStorage();
    const data = { ssid: cookies.ssid, clid: cookies.clid, csid: cookies.csid, tdid: cookies.tdid, sub: cookies.sub || accountId, asid: cookies.asid || '' };
    if (safe.isEncryptionAvailable()) {
      const encrypted = safe.encryptString(JSON.stringify(data));
      this.store.set(`secure.${accountId}`, encrypted.toString('base64'));
    } else {
      // Fallback: obfuscated storage (not ideal but functional)
      this.store.set(`secure.${accountId}`, Buffer.from(JSON.stringify(data)).toString('base64'));
    }
  }

  async retrieveCookiesSecurely(accountId) {
    try {
      const raw = this.store.get(`secure.${accountId}`);
      if (!raw) return null;
      const safe = this._getSafeStorage();
      if (safe.isEncryptionAvailable()) {
        const decrypted = safe.decryptString(Buffer.from(raw, 'base64'));
        return JSON.parse(decrypted);
      } else {
        return JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
      }
    } catch (e) {
      return null;
    }
  }

  async deleteCookiesSecurely(accountId) {
    this.store.delete(`secure.${accountId}`);
  }

  // --- Account CRUD ---

  getAccounts() {
    this.accounts = this.store.get('accounts', []);
    return this.accounts.map(acc => ({ ...acc }));
  }

  getAccountById(accountId) {
    this.accounts = this.store.get('accounts', []);
    const account = this.accounts.find(acc => acc.id === accountId);
    return account ? { ...account } : null;
  }

  async addAccountFromTokens(accessToken, idToken, cookies, fallbackPuuid = null) {
    try {
      // Try to fetch user info for nice display name + region. Fall back to PUUID-only metadata.
      let puuid, gameName = null, tagLine = null, detectedRegion = 'NA';
      try {
        const userInfo = await this._getUserInfo(accessToken);
        puuid = userInfo.sub;
        gameName = userInfo.acct?.game_name;
        tagLine = userInfo.acct?.tag_line;
        // PAS is authoritative — userInfo.affinity leaks LoL region for legacy
        // accounts, so check the Valorant-specific PAS endpoint first and only
        // fall back to userInfo-derived detection if PAS fails.
        const pasRegion = await this._getValorantRegionFromPas(accessToken);
        detectedRegion = pasRegion || this._detectRegion(userInfo);
      } catch (e) {
        if (!fallbackPuuid) throw e;
        puuid = fallbackPuuid;
      }

      const hasRiotId = gameName && tagLine;
      const accountData = {
        id: puuid,
        username: gameName || `User (${puuid.substring(0, 5)})`,
        region: detectedRegion,
        puuid,
        displayName: hasRiotId ? `${gameName}#${tagLine}` : (gameName || `User (${puuid.substring(0, 5)})`),
        nickname: '',
        sortOrder: this.accounts.length,
        lastUsed: Date.now(),
        createdAt: Date.now()
      };

      this._saveAccount(accountData);
      await this.storeCookiesSecurely(accountData.id, {
        ssid: cookies.ssid || '', clid: cookies.clid || '',
        csid: cookies.csid || '', tdid: cookies.tdid || '',
        sub: accountData.id, asid: cookies.asid || ''
      });

      return { success: true, account: { ...accountData } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }


  async removeAccount(accountId) {
    this.accounts = this.store.get('accounts', []);
    this.accounts = this.accounts.filter(a => a.id !== accountId);
    this.store.set('accounts', this.accounts);
    await this.deleteCookiesSecurely(accountId);
    return { success: true };
  }

  // --- Account metadata operations ---

  async updateLastUsed(accountId) {
    this.accounts = this.store.get('accounts', []);
    const idx = this.accounts.findIndex(a => a.id === accountId);
    if (idx > -1) {
      this.accounts[idx].lastUsed = Date.now();
      this.store.set('accounts', this.accounts);
    }
  }

  setNickname(accountId, nickname) {
    this.accounts = this.store.get('accounts', []);
    const idx = this.accounts.findIndex(a => a.id === accountId);
    if (idx > -1) {
      this.accounts[idx].nickname = nickname;
      this.store.set('accounts', this.accounts);
      return { success: true };
    }
    return { success: false, error: 'Account not found.' };
  }

  reorderAccounts(orderedIds) {
    this.accounts = this.store.get('accounts', []);
    const idToAccount = new Map(this.accounts.map(a => [a.id, a]));
    const reordered = orderedIds.map((id, i) => {
      const acc = idToAccount.get(id);
      if (acc) { acc.sortOrder = i; return acc; }
      return null;
    }).filter(Boolean);
    // Append any accounts not in the ordered list
    for (const acc of this.accounts) {
      if (!orderedIds.includes(acc.id)) reordered.push(acc);
    }
    this.accounts = reordered;
    this.store.set('accounts', this.accounts);
    return { success: true };
  }

  // --- Session health ---

  async checkSession(accountId) {
    return this.checkSessionWithCookies(accountId, await this.retrieveCookiesSecurely(accountId));
  }

  async checkSessionWithCookies(accountId, cookies) {
    if (!cookies?.ssid) return { valid: false, reason: 'No SSID cookie.' };
    try {
      // First attempt
      let result = await this._performSSIDAuth(cookies.ssid, cookies.clid, cookies.csid, cookies.tdid);

      // Retry once on transient failure (network blip, 5xx, rate limit, 200 HTML form)
      if (!result.success && result.transient) {
        await new Promise(r => setTimeout(r, 1500));
        result = await this._performSSIDAuth(cookies.ssid, cookies.clid, cookies.csid, cookies.tdid);
      }

      if (result.success) {
        await this.storeCookiesSecurely(accountId, {
          ssid: result.ssid, clid: result.clid || '', csid: result.csid || '',
          tdid: result.tdid || '', sub: accountId
        });
        return { valid: true };
      }

      // Still transient after retry → mark unknown, NOT expired. The UI shows
      // an amber icon and the user can re-check; we don't trash trusted cookies
      // because Riot was flaky for a moment.
      if (result.transient) {
        return { valid: null, reason: result.message || 'Could not verify session (network).' };
      }

      // Definitive expiry only
      return { valid: false, reason: result.message || 'Session expired (~1-3 weeks lifespan).' };
    } catch (e) {
      // Unexpected exception → also treat as unknown, not expired
      return { valid: null, reason: `Verification error: ${e.message}` };
    }
  }

  // --- Auth methods ---

  async refreshAuth(accountId) {
    try {
      const cookies = await this.retrieveCookiesSecurely(accountId);
      if (!cookies?.ssid) throw new Error('No stored SSID cookie.');

      const authResult = await this._performSSIDAuth(cookies.ssid, cookies.clid, cookies.csid, cookies.tdid);
      if (!authResult.success) throw new Error(authResult.message || 'SSID re-auth failed.');

      const entitlements = await this._getEntitlements(authResult.accessToken);
      await this.storeCookiesSecurely(accountId, {
        ssid: authResult.ssid, clid: authResult.clid || '',
        csid: authResult.csid || '', tdid: authResult.tdid || '', sub: accountId
      });
      await this.updateLastUsed(accountId);

      return { success: true, accessToken: authResult.accessToken, idToken: authResult.idToken, entitlementsToken: entitlements.entitlements_token };
    } catch (error) {
      return { success: false, error: error.message, needsRelogin: true };
    }
  }

  // --- Cloud Settings Auth (uses riot-client client_id for proper RBAC permissions) ---

  async getCloudAuthTokens(ssid, clid, csid, tdid) {
    const cookieMap = {};
    if (ssid) cookieMap.ssid = ssid;
    if (clid) cookieMap.clid = clid;
    if (csid) cookieMap.csid = csid;
    if (tdid) cookieMap.tdid = tdid;
    if (!cookieMap.ssid) throw new Error('No SSID cookie.');

    const build = await getRiotClientBuild();
    const ua = `RiotClient/${build} rso-auth (Windows;10;;Professional, x64)`;
    const nonce = crypto.randomBytes(16).toString('base64url');
    const url = `${AUTH_ENDPOINTS.AUTHORIZE}?redirect_uri=http%3A%2F%2Flocalhost%2Fredirect&client_id=riot-client&response_type=token%20id_token&nonce=${nonce}&scope=openid%20link%20ban%20lol_region%20lol%20summoner%20offline_access`;

    const response = await fetch(url, {
      agent: riotAgent, redirect: 'manual',
      headers: { 'User-Agent': ua, 'Cookie': this._formatCookies(cookieMap) },
    });
    const loc = response.headers.get('location');
    if (!loc || !loc.includes('access_token')) throw new Error('Session expired. Launch the account first.');
    const accessToken = new URLSearchParams(loc.split('#')[1]).get('access_token');

    const entR = await fetch(AUTH_ENDPOINTS.ENTITLEMENTS, {
      method: 'POST', agent: riotAgent,
      headers: { 'User-Agent': ua, 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!entR.ok) throw new Error('Entitlements failed.');
    const { entitlements_token } = await entR.json();
    return { accessToken, entitlementsToken: entitlements_token };
  }

  // --- Cloud Settings (via SGP player-preferences) ---

  _getSgpPrefsUrl(region) {
    const shard = REGION_SGP_MAP[(region || 'NA').toUpperCase()] || 'usw2';
    return `https://player-preferences-${shard}.pp.sgp.pvp.net/playerPref/v3`;
  }

  async getCloudSettings(accessToken, entitlementsToken, region) {
    const url = `${this._getSgpPrefsUrl(region)}/getPreference/Ares.PlayerSettings`;
    const build = await getRiotClientBuild();
    const res = await fetch(url, {
      agent: riotAgent,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'X-Riot-Entitlements-JWT': entitlementsToken,
        'X-Riot-ClientPlatform': RIOT_CLIENT_PLATFORM,
        'User-Agent': `RiotClient/${build} rso-auth (Windows;10;;Professional, x64)`,
      },
    });
    if (!res.ok) throw new Error(`Failed to get settings: ${res.status}`);
    const body = await res.json();
    if (!body.data) throw new Error('No settings data returned.');
    return body;
  }

  async putCloudSettings(accessToken, entitlementsToken, region, settingsBlob) {
    const url = `${this._getSgpPrefsUrl(region)}/savePreference`;
    const build = await getRiotClientBuild();
    const res = await fetch(url, {
      method: 'PUT', agent: riotAgent,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'X-Riot-Entitlements-JWT': entitlementsToken,
        'X-Riot-ClientPlatform': RIOT_CLIENT_PLATFORM,
        'Content-Type': 'application/json',
        'User-Agent': `RiotClient/${build} rso-auth (Windows;10;;Professional, x64)`,
      },
      body: JSON.stringify({ type: 'Ares.PlayerSettings', data: settingsBlob.data }),
    });
    if (!res.ok) throw new Error(`Failed to save settings: ${res.status}`);
    return res.json();
  }

  // Decode a cloud settings blob (base64 → decompress → JSON). The order
  // matters: Riot currently serves raw deflate, so inflateRaw comes first
  // and becomes the round-trip format. gzip/zlib are fallbacks for legacy
  // blobs. Returns an explicit string tag so the encoder can round-trip
  // safely even when arrow-function source text isn't available (e.g.
  // minified bundles, different Node versions).
  _decodeSettingsBlob(base64Data) {
    const buf = Buffer.from(base64Data, 'base64');
    const tryMethods = [
      { name: 'inflateRaw', fn: () => zlib.inflateRawSync(buf) },
      { name: 'gzip',       fn: () => zlib.gunzipSync(buf) },
      { name: 'inflate',    fn: () => zlib.inflateSync(buf) },
    ];
    let lastErr;
    for (const m of tryMethods) {
      try {
        const settings = JSON.parse(m.fn().toString('utf-8'));
        return { settings, method: m.name };
      } catch (e) { lastErr = e; }
    }
    throw new Error('Could not decode settings blob: ' + lastErr?.message);
  }

  // Encode settings back to base64 using the same compression method that
  // decoded them. Must match what Valorant's client expects on read-back,
  // otherwise it fails with "Error retrieving settings from server" and
  // falls back to defaults. Defaults to inflateRaw (Riot's current format)
  // if the caller lost track of the decode method.
  _encodeSettingsBlob(settings, method = 'inflateRaw') {
    const buf = Buffer.from(JSON.stringify(settings), 'utf-8');
    if (method === 'gzip')    return zlib.gzipSync(buf).toString('base64');
    if (method === 'inflate') return zlib.deflateSync(buf).toString('base64');
    return zlib.deflateRawSync(buf).toString('base64');
  }

  // Mirror source cloud settings onto target for each enabled category. "Mirror"
  // means: for any key matching the category's patterns, target ends up with
  // EXACTLY what source has — including absences. If source doesn't have a key,
  // it's removed from target so Valorant re-creates it at default on next launch.
  // This handles the common case where Valorant only persists non-default values
  // (e.g. MouseSensitivityADS=1.0 is never written, so source's cloud+local are
  // both missing it; target's old custom value must be wiped to match).
  mergeSelectiveSettings(sourceSettings, targetSettings, categories, patterns, excludePatterns = [], additiveCategories = new Set()) {
    const merged = JSON.parse(JSON.stringify(targetSettings));
    const exclude = excludePatterns;

    const isExcluded = (key) => exclude.some(p => key.toLowerCase().includes(p.toLowerCase()));
    const matchesAny = (key, pats) => !isExcluded(key) && pats.some(p => key.toLowerCase().includes(p.toLowerCase()));

    if (categories.keybinds) {
      merged.actionMappings = sourceSettings.actionMappings || merged.actionMappings;
      merged.axisMappings = sourceSettings.axisMappings || merged.axisMappings;
    }

    // `additive` skips the mirror-wipe step: target keys that match the pattern
    // but aren't in source are preserved instead of being removed. Used for
    // blob keys like SavedCrosshairProfileData where target's saved profiles
    // shouldn't be deleted just because source happens not to have customized
    // them.
    const mergeArray = (arrayName, pats, additive) => {
      if (!merged[arrayName]) merged[arrayName] = [];
      const srcArr = sourceSettings[arrayName] || [];
      const srcKeysForPattern = new Set(
        srcArr
          .filter(s => s.settingEnum && matchesAny(s.settingEnum, pats))
          .map(s => s.settingEnum)
      );

      if (!additive) {
        // Mirror wipe — remove target keys that match the pattern but aren't in source.
        merged[arrayName] = merged[arrayName].filter(s => {
          if (!s.settingEnum) return true;
          if (!matchesAny(s.settingEnum, pats)) return true;
          return srcKeysForPattern.has(s.settingEnum);
        });
      }

      // Overwrite or append source values for matching keys.
      for (const src of srcArr) {
        if (!src.settingEnum || !matchesAny(src.settingEnum, pats)) continue;
        const idx = merged[arrayName].findIndex(s => s.settingEnum === src.settingEnum);
        if (idx >= 0) merged[arrayName][idx] = { ...src };
        else merged[arrayName].push({ ...src });
      }
    };

    for (const [cat, enabled] of Object.entries(categories)) {
      if (!enabled || cat === 'keybinds') continue;
      const pats = patterns[cat];
      if (!pats || !pats.length) continue;
      const additive = additiveCategories.has(cat);
      mergeArray('floatSettings', pats, additive);
      mergeArray('boolSettings', pats, additive);
      mergeArray('stringSettings', pats, additive);
      mergeArray('intSettings', pats, additive);
    }

    return merged;
  }

  // Update the stored region for an account in place. Used by
  // resolveLiveAuthTokens to self-heal legacy accounts that were saved
  // with the wrong region before PAS-based detection existed.
  updateAccountRegion(accountId, region) {
    if (!region) return false;
    this.accounts = this.store.get('accounts', []);
    const idx = this.accounts.findIndex(a => a.id === accountId);
    if (idx < 0) return false;
    if (this.accounts[idx].region === region) return false;
    this.accounts[idx] = { ...this.accounts[idx], region };
    this.store.set('accounts', this.accounts);
    return true;
  }

  // --- Private helpers ---

  // PAS (Player Affinity Service) is the Valorant-authoritative source for
  // a player's game region. Hits riot-geo with the access token and parses
  // the returned JWT — `affinity` in its payload is the actual Valorant
  // shard (na/eu/ap/kr/br/latam/pbe). Returns null on any failure so the
  // caller can fall back to userInfo-based detection.
  async _getValorantRegionFromPas(accessToken) {
    try {
      const url = 'https://riot-geo.pas.si.riotgames.com/pas/v1/service/chat';
      const response = await fetch(url, {
        method: 'GET',
        agent: riotAgent,
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
      });
      if (!response.ok) return null;
      const body = (await response.text()).trim();
      // PAS sometimes returns a raw JWT, sometimes JSON-wrapped `{ token }`
      let jwt = body;
      if (body.startsWith('{')) {
        try { jwt = JSON.parse(body).token || body; } catch { /* use raw */ }
      }
      if (!jwt || jwt.split('.').length !== 3) return null;
      const payloadB64 = jwt.split('.')[1];
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
      const affinity = (payload.affinity || '').toLowerCase();
      // STRICT match only — the /pas/v1/service/chat affinity reflects the
      // CHAT server, not the Valorant game region. Values like `us-br1`
      // (chat POP in Brazil) can actually belong to accounts playing on the
      // NA game shard, so prefix-guessing here mis-labels accounts. Only
      // accept the canonical exact values; fall through to the shard
      // probe for anything else.
      const map = { na: 'NA', eu: 'EU', ap: 'AP', kr: 'KR', br: 'BR', latam: 'LATAM', pbe: 'PBE' };
      return map[affinity] || null;
    } catch {
      return null;
    }
  }

  // Authoritative region detection by probing every Valorant pd shard in
  // parallel and picking whichever one returns 200 for the player's own
  // MMR lookup. This is the ground truth: the shard that serves the data
  // IS the game region, regardless of what PAS chat affinity claims.
  // Returns the Nebula-internal region name (NA/EU/AP/KR/BR/LATAM) or null
  // if no shard responds 200 (expired session, network error, etc.).
  async _probeValorantRegion({ accessToken, entitlementsToken, puuid }) {
    // PRIMARY: decode the access token JWT. Riot encodes the Valorant game
    // region cluster as `pp.c` — set at token issuance. Cluster codes:
    //   "am"  → Americas (NA/BR/LATAM — needs userInfo.country to split)
    //   "eu"  → EU
    //   "ap"  → AP
    //   "kr"  → KR
    //   "pbe" → PBE
    // This is the ground truth and requires at most one extra API call
    // (userInfo, only for Americas accounts).
    try {
      const parts = accessToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
        const c = (payload?.pp?.c || '').toLowerCase();

        if (c === 'eu')  return 'EU';
        if (c === 'ap')  return 'AP';
        if (c === 'kr')  return 'KR';
        if (c === 'pbe') return 'PBE';

        if (c === 'am' || c === 'na' || c === 'us' || c === 'br' || c === 'latam' || c === 'la' || c === 'la1' || c === 'la2') {
          // Americas cluster — NA/BR/LATAM all share pd.na but have distinct
          // glz-{region}-1.na prefixes. Disambiguate via userInfo.country,
          // which is the account's creation country and maps cleanly to the
          // real game region.
          try {
            const userInfo = await this._getUserInfo(accessToken);
            const country = (userInfo.country || '').toLowerCase();
            if (['bra', 'br'].includes(country)) return 'BR';
            const latamCountries = ['arg','ar','chl','cl','col','co','per','pe','mex','mx','ury','uy','pry','py','ecu','ec','ven','ve','bol','bo','cri','cr','pan','pa','gtm','gt','hnd','hn','slv','sv','nic','ni','dom','do','cub','cu'];
            if (latamCountries.includes(country)) return 'LATAM';
            return 'NA';
          } catch { return 'NA'; }
        }

        if (c) console.warn(`[auth] unknown pp.c cluster "${c}" — falling back to shard probe`);
      }
    } catch (e) {
      console.warn(`[auth] access token JWT parse failed: ${e.message}`);
    }

    // FALLBACK: match-history probe. The access token `pp.c` should always
    // be present, but if Riot changes the JWT shape or the value is an
    // unrecognized region code, probe the shards directly. match-history is
    // the only pd endpoint that reliably discriminates (mmr returns 200 on
    // every shard with placeholder data).
    const shards = [
      { code: 'na', region: 'NA' },
      { code: 'eu', region: 'EU' },
      { code: 'ap', region: 'AP' },
      { code: 'kr', region: 'KR' },
    ];
    const build = await getRiotClientBuild();
    const version = await this._getRiotClientVersionForHeader();
    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'X-Riot-Entitlements-JWT': entitlementsToken,
      'X-Riot-ClientPlatform': RIOT_CLIENT_PLATFORM,
      'X-Riot-ClientVersion': version,
      'User-Agent': `RiotClient/${build} rso-auth (Windows;10;;Professional, x64)`,
    };
    const results = await Promise.all(shards.map(async ({ code, region }) => {
      try {
        const res = await fetch(
          `https://pd.${code}.a.pvp.net/match-history/v1/history/${puuid}?endIndex=1`,
          { agent: riotAgent, headers },
        );
        return { region, status: res.status };
      } catch {
        return { region, status: 0 };
      }
    }));
    const winner = results.find(r => r.status === 200);
    if (!winner) return null;

    // pd.na serves NA + BR + LATAM. Disambiguate via userInfo.country.
    if (winner.region === 'NA') {
      try {
        const userInfo = await this._getUserInfo(accessToken);
        const country = (userInfo.country || '').toLowerCase();
        if (['bra', 'br'].includes(country)) return 'BR';
        const latamCountries = ['arg','ar','chl','cl','col','co','per','pe','mex','mx','ury','uy','pry','py','ecu','ec','ven','ve','bol','bo','cri','cr','pan','pa','gtm','gt','hnd','hn','slv','sv','nic','ni','dom','do','cub','cu'];
        if (latamCountries.includes(country)) return 'LATAM';
      } catch { /* fall through to NA */ }
    }
    return winner.region;
  }

  // Lazy-cached Riot client version — required by pd/glz endpoints. Mirrors
  // game-service.js's getRiotClientVersion but lives here so auth-service
  // doesn't need to import from game-service (circular).
  async _getRiotClientVersionForHeader() {
    if (this._cachedClientVersion) return this._cachedClientVersion;
    try {
      const res = await fetch('https://valorant-api.com/v1/version');
      const data = await res.json();
      if (data.status === 200 && data.data?.riotClientVersion) {
        this._cachedClientVersion = data.data.riotClientVersion;
        return this._cachedClientVersion;
      }
    } catch { /* fall through */ }
    return 'release-09.02-shipping-62-2817827';
  }

  _detectRegion(userInfo) {
    let shard = null;
    const affinity = userInfo.affinity;
    if (affinity) {
      const keys = ['pp', 'live.valorant', 'live', 'pbe'];
      for (const key of keys) {
        if (affinity[key] && typeof affinity[key] === 'string') { shard = affinity[key].toLowerCase(); break; }
      }
      if (!shard) {
        const first = Object.values(affinity).find(v => typeof v === 'string');
        if (first) shard = first.toLowerCase();
      }
    }

    const directMap = { eu: 'EU', europe: 'EU', ap: 'AP', apac: 'AP', kr: 'KR', korea: 'KR', br: 'BR', latam: 'LATAM', na: 'NA', pbe: 'PBE' };
    if (shard && directMap[shard] && shard !== 'am' && shard !== 'americas') return directMap[shard];

    const country = (userInfo.country || '').toLowerCase();
    if (['bra', 'br'].includes(country)) return 'BR';
    if (['arg', 'ar', 'chl', 'cl', 'col', 'co', 'per', 'pe', 'mex', 'mx', 'ury', 'uy', 'pry', 'py', 'ecu', 'ec', 'ven', 've', 'bol', 'bo', 'cri', 'cr', 'pan', 'pa', 'gtm', 'gt', 'hnd', 'hn', 'slv', 'sv', 'nic', 'ni', 'dom', 'do', 'cub', 'cu'].includes(country)) return 'LATAM';
    if (['deu', 'de', 'gbr', 'gb', 'fra', 'fr', 'esp', 'es', 'ita', 'it', 'nld', 'nl', 'pol', 'pl', 'swe', 'se', 'nor', 'no', 'dnk', 'dk', 'fin', 'fi', 'prt', 'pt', 'aut', 'at', 'bel', 'be', 'che', 'ch', 'cze', 'cz', 'rou', 'ro', 'hun', 'hu', 'tur', 'tr', 'rus', 'ru', 'ukr', 'ua', 'irl', 'ie', 'bgr', 'bg', 'hrv', 'hr', 'svk', 'sk', 'ltu', 'lt', 'lva', 'lv', 'est', 'ee', 'srb', 'rs', 'grc', 'gr'].includes(country)) return 'EU';
    if (['jpn', 'jp', 'aus', 'au', 'sgp', 'sg', 'tha', 'th', 'phl', 'ph', 'idn', 'id', 'mys', 'my', 'vnm', 'vn', 'twn', 'tw', 'hkg', 'hk', 'ind', 'in', 'nzl', 'nz'].includes(country)) return 'AP';
    if (['kor', 'kr'].includes(country)) return 'KR';

    return 'NA';
  }

  async _performSSIDAuth(ssid, clid, csid, tdid) {
    const cookieMap = {};
    if (ssid) cookieMap.ssid = ssid;
    if (clid) cookieMap.clid = clid;
    if (csid) cookieMap.csid = csid;
    if (tdid) cookieMap.tdid = tdid;
    if (!cookieMap.ssid) return { success: false, message: 'SSID required.', transient: false };

    try {
      const nonce = crypto.randomBytes(16).toString('base64url');
      const url = `${AUTH_ENDPOINTS.AUTHORIZE}?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in&client_id=play-valorant-web-prod&response_type=token%20id_token&nonce=${nonce}&scope=account%20openid`;

      const response = await fetch(url, {
        method: 'GET', agent: riotAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Cookie': this._formatCookies(cookieMap),
        },
        redirect: 'manual'
      });

      const redirectUrl = response.headers.get('location');

      // Success: 30x to opt_in URL with access_token in fragment
      if (response.status >= 300 && response.status < 400 && redirectUrl && redirectUrl.includes('access_token')) {
        const params = new URLSearchParams(redirectUrl.split('#')[1]);
        const accessToken = params.get('access_token');
        const idToken = params.get('id_token');
        if (!accessToken || !idToken) {
          return { success: false, message: 'Tokens not found in redirect.', transient: true };
        }
        const latest = this._extractCookies(response, { ...cookieMap });
        return { success: true, accessToken, idToken, ssid: latest.ssid || ssid, clid: latest.clid || clid, csid: latest.csid || csid, tdid: latest.tdid || tdid };
      }

      // Definitive expiry: 30x to login page (no access_token in URL)
      if (response.status >= 300 && response.status < 400 && redirectUrl && /login|auth/i.test(redirectUrl) && !redirectUrl.includes('access_token')) {
        return { success: false, message: 'Session expired.', needsRelogin: true, transient: false };
      }

      // 401/403: definitively unauthorized
      if (response.status === 401 || response.status === 403) {
        return { success: false, message: 'Session rejected by Riot.', needsRelogin: true, transient: false };
      }

      // 5xx, 429, 200 with HTML form, or anything else ambiguous → don't claim expired
      return { success: false, message: `Auth check inconclusive (HTTP ${response.status}).`, transient: true };
    } catch (error) {
      // Network error, DNS failure, TLS error, timeout — all transient
      return { success: false, error: 'network_error', message: error.message, transient: true };
    }
  }

  async _getEntitlements(accessToken) {
    const headers = await getRiotHeaders();
    const response = await fetch(AUTH_ENDPOINTS.ENTITLEMENTS, {
      method: 'POST', agent: riotAgent,
      headers: { ...headers, 'Authorization': `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`Entitlements failed: ${response.status}`);
    return await response.json();
  }

  async _getUserInfo(accessToken) {
    const headers = await getRiotHeaders();
    const response = await fetch(AUTH_ENDPOINTS.USERINFO, {
      method: 'GET', agent: riotAgent,
      headers: { ...headers, 'Authorization': `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`User info failed: ${response.status}`);
    return await response.json();
  }

  _saveAccount(accountData) {
    this.accounts = this.store.get('accounts', []);
    const idx = this.accounts.findIndex(a => a.id === accountData.id);
    if (idx >= 0) {
      const existing = this.accounts[idx];
      this.accounts[idx] = { ...existing, ...accountData, createdAt: existing.createdAt, nickname: existing.nickname || accountData.nickname || '', sortOrder: existing.sortOrder ?? accountData.sortOrder ?? idx };
    } else {
      this.accounts.push({ ...accountData, sortOrder: accountData.sortOrder ?? this.accounts.length });
    }
    this.store.set('accounts', this.accounts);
  }

  _extractCookies(response, existing = {}) {
    const headers = response.headers.raw?.()?.['set-cookie'] || [];
    headers.forEach(str => {
      const parts = str.split(';')[0].split('=');
      if (parts.length >= 2) {
        const name = parts[0].trim();
        const value = parts.slice(1).join('=').trim();
        if (name && value) existing[name] = value;
      }
    });
    return existing;
  }

  _formatCookies(obj) {
    return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

module.exports = { AuthService };
