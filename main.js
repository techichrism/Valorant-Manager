const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const store = require('electron-store');

// Set app name + AUMID. Packaged builds get this registered against
// Nebula.exe by the NSIS installer, which is what makes native toast
// notifications reach Action Center. Dev (`npm start`) can't replicate
// that identity binding from a different executable, so toasts there
// route to the tray-balloon fallback inside fireNotification — but
// production users get proper Windows toasts.
app.setName('Nebula');
if (process.platform === 'win32') app.setAppUserModelId('com.v1niii.nebula');

// Native Windows toast with a tray-balloon fallback when Windows rejects
// the toast (typical in dev mode — HRESULT 0x80414114 because the AUMID
// isn't bound to the running executable's identity). Used by both the
// startup wishlist scan and the in-match blacklist alert.
//
// Icon is loaded via NativeImage so packaged builds work — passing a raw
// __dirname path resolves inside app.asar, which Windows toast can't read.
// NativeImage handles the ASAR -> on-disk extraction transparently.
function fireNotification(title, body) {
    if (!Notification.isSupported()) return;
    let n;
    try {
        n = new Notification({
            title,
            body,
            icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')),
        });
    } catch (e) {
        console.warn(`[notify] threw: ${e.message}`);
        return;
    }
    n.on('show', () => console.log(`[notify] shown: ${title}`));
    n.on('failed', (_e, err) => {
        console.warn(`[notify] native failed (${err}) — falling back to tray balloon`);
        if (tray && typeof tray.displayBalloon === 'function') {
            try { tray.displayBalloon({ title, content: body, iconType: 'info' }); } catch {}
        }
    });
    n.show();
}
const { AuthService } = require('./auth-service');
const { AuthLaunchService, KEY_PATTERNS, EXCLUDE_KEY_PATTERNS, ADDITIVE_CATEGORIES } = require('./auth-launch-service');
const gameService = require('./game-service');
const deceive = require('./deceive-manager');

const appStore = new store({ clearInvalidConfig: true });
const authService = new AuthService(appStore);
const authLaunchService = new AuthLaunchService(appStore, authService);

let mainWindow;
let tray = null;
let valorantProcessWatcher = null;
let watchedAccountId = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        title: 'Nebula',
        width: 750, height: 700,
        resizable: false,
        maximizable: false,
        autoHideMenuBar: true, menuBarVisible: false, show: false, center: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true, nodeIntegration: false,
        },
        icon: path.join(__dirname, 'assets/icon.ico')
    });

    mainWindow.setMenu(null);
    mainWindow.show();

    const devMode = !app.isPackaged && process.argv.includes('--dev');
    if (devMode) {
        mainWindow.loadURL('http://localhost:5173');
    } else {
        mainWindow.loadFile(path.join(__dirname, 'renderer/dist/index.html'));
    }

    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.webContents.send('confirm-close');
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        stopValorantWatcher();
    });
}

function createTray() {
    const iconPath = path.join(__dirname, 'assets/icon.png');
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip('Nebula - Valorant Account Manager');
    rebuildTrayMenu();
    tray.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

// Rebuilds the tray right-click menu with the current account list as
// quick-launch shortcuts. Called on startup and whenever the account list
// changes (add/remove/reorder/nickname).
function rebuildTrayMenu() {
    if (!tray) return;
    const accounts = authService.getAccounts() || [];
    const template = [
        { label: 'Show Nebula', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    ];
    if (accounts.length) {
        template.push({ type: 'separator' });
        template.push({ label: 'Launch', enabled: false });
        // Limit to 10 to keep the menu compact; users with more accounts can
        // still use the main window.
        for (const acc of accounts.slice(0, 10)) {
            const label = acc.nickname
                ? `${acc.nickname} (${acc.displayName || acc.username})`
                : (acc.displayName || acc.username || 'Unknown');
            template.push({
                label,
                click: () => launchFromTray(acc.id),
            });
        }
    }
    template.push({ type: 'separator' });
    template.push({ label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } });
    tray.setContextMenu(Menu.buildFromTemplate(template));
}

// Kicks off a launch from the tray menu. Surfaces the main window first so
// the user sees the launching status indicator, then calls the same shared
// launch function the IPC handler uses.
function launchFromTray(accountId) {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    performLaunch(accountId).catch(e => console.warn('[tray] launch failed:', e?.message));
}

function setupAutoUpdater() {
    // Lazy-require so the lazy `autoUpdater` getter (which touches
    // app.getVersion) doesn't fire in dev mode when this function is skipped.
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;

    const sendToRenderer = (channel, payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(channel, payload);
        }
    };

    autoUpdater.on('checking-for-update', () => {
        console.log('[updater] Checking for updates...');
    });

    autoUpdater.on('update-available', (info) => {
        console.log(`[updater] Update available: v${info.version}`);
        sendToRenderer('update-status', { type: 'available', version: info.version });
    });

    autoUpdater.on('update-not-available', (info) => {
        console.log(`[updater] No updates. Current: v${info.version}`);
    });

    autoUpdater.on('download-progress', (progress) => {
        console.log(`[updater] Downloading: ${progress.percent.toFixed(1)}%`);
    });

    autoUpdater.on('update-downloaded', (info) => {
        console.log(`[updater] Update v${info.version} downloaded, will install on quit.`);
        sendToRenderer('update-status', { type: 'downloaded', version: info.version });
    });

    autoUpdater.on('error', (err) => {
        console.error('[updater] Error:', err.message);
    });

    // Initial check on startup
    autoUpdater.checkForUpdates().catch((e) => console.error('[updater] Check failed:', e.message));

    // Re-check every 4 hours so long-running sessions still get updates
    setInterval(() => {
        autoUpdater.checkForUpdates().catch(() => {});
    }, 4 * 60 * 60 * 1000);
}

ipcMain.handle('install-update-now', () => {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.quitAndInstall();
});

// Single-instance lock: if Nebula is already running, quit this new process
// and focus/restore the existing window instead. Without this, every launch
// spawns a fresh tray icon and window, leaving orphans in Task Manager.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            if (!mainWindow.isVisible()) mainWindow.show();
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        createWindow();
        createTray();
        if (app.isPackaged) setupAutoUpdater();

        // Appear-offline is now handled by bundled Deceive.exe (see
        // deceive-manager.js). Silently check for a Deceive update on
        // startup — only when the user actually has the feature turned on,
        // so we don't hit GitHub for users who never use Appear Offline.
        if (appStore.get('appearOffline', false)) {
            setTimeout(() => {
                deceive.checkForUpdate()
                    .then(r => { if (r?.to) console.log(`[deceive] updated ${r.from || 'unknown'} → ${r.to}`); })
                    .catch(e => console.log(`[deceive] update failed: ${e.message}`));
            }, 3000);
        }

        // Load the persisted name cache for the Match Info "yoinker" fallback.
        // Stored in userData so it survives across Nebula restarts and grows
        // organically as the user plays — every match adds new puuid → name
        // mappings that persist forever.
        const nameCachePath = path.join(app.getPath('userData'), 'name-cache.json');
        gameService.loadNameCache(nameCachePath).catch(() => {});

        // Proactive region self-heal: some accounts stick to a wrong stored
        // region because their live-API calls (rank, store) never succeed
        // on this session and so never flow through resolveLiveAuthTokens.
        // Walk every account once at startup, ask PAS for the real Valorant
        // region, and update the store. Silent on failure — accounts with
        // expired sessions are simply skipped and retried on next launch.
        setTimeout(() => { scanAllAccountRegions().catch(() => {}); }, 2000);

        // One-time self-heal: wipe Data/Sessions once for users carrying
        // latent corruption from versions that snapshotted/restored it.
        if (!appStore.get('sessionsFolderHealed_v339', false)) {
            setTimeout(async () => {
                const fs = require('fs').promises;
                const sessionsPath = path.join(process.env.LOCALAPPDATA, 'Riot Games', 'Riot Client', 'Data', 'Sessions');
                try {
                    await fs.rm(sessionsPath, { recursive: true, force: true });
                    console.log('[main] Data/Sessions self-heal: cleared.');
                } catch (e) {
                    console.log(`[main] Data/Sessions self-heal: skipped (${e.message})`);
                }
                appStore.set('sessionsFolderHealed_v339', true);
            }, 4000);
        }

        // Wishlist watch on startup — check each account's daily store
        // against the wishlist and surface a Windows notification per
        // account that has hits. Avoids forcing the user to open the
        // Store tab to know a wished skin is up.
        setTimeout(() => { checkWishlistOnStartup().catch(() => {}); }, 6000);

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') { /* tray keeps app alive */ }
});

app.on('before-quit', () => { app.isQuitting = true; deceive.kill(); });

// No longer need to scrub YAML on quit - snapshot/restore handles auth state

// --- Account IPC ---

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('get-accounts', () => authService.getAccounts());

// Login via Riot Client: launches the actual Riot Client for the user to log in,
// then snapshots the auth files for future account switching
ipcMain.handle('login-with-riot', async () => {
    try {
        const account = await authLaunchService.addViaRiotClient();
        rebuildTrayMenu();
        return { success: true, account };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('import-current-account', async () => {
    try {
        const account = await authLaunchService.importCurrentAccount();
        rebuildTrayMenu();
        return account ? { success: true, account } : { success: false, error: 'Could not import account.' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('remove-account', async (event, accountId) => {
    try {
        // Stop any active watcher on this account FIRST. Otherwise its next
        // tick would re-run snapshotAccountData and recreate the snapshot
        // dir we're about to delete.
        if (watchedAccountId === accountId) stopValorantWatcher();
        await authService.removeAccount(accountId);
        await authLaunchService.deleteSnapshot(accountId);
        regionVerifiedThisSession.delete(accountId);
        invalidateLiveAuthCache(accountId);
        rebuildTrayMenu();
        return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('set-nickname', async (event, accountId, nickname) => {
    const result = authService.setNickname(accountId, nickname);
    rebuildTrayMenu();
    return result;
});

ipcMain.handle('reorder-accounts', async (event, orderedIds) => {
    const result = authService.reorderAccounts(orderedIds);
    rebuildTrayMenu();
    return result;
});

ipcMain.handle('check-session', async (event, accountId) => {
    // Check if Riot Client is running and authed as this account
    const auth = await authLaunchService.getAuthenticatedAccount();
    if (auth && auth.puuid === accountId) return { valid: true };
    // Try stored cookies
    const result = await authService.checkSession(accountId);
    if (result.valid) return result;
    // Fallback to snapshot cookies
    const snapCookies = await authLaunchService.extractCookiesFromSnapshot(accountId);
    if (snapCookies?.ssid) return authService.checkSessionWithCookies(accountId, snapCookies);
    return result;
});

// Launch lock with staleness detection. Without the staleness check, any
// code path that fails to call `releaseLaunchLock()` (e.g. an unresolved
// Promise during re-login) traps the user — they can't launch anything
// until they restart Nebula. Auto-clearing after 6 minutes lets them
// recover without a restart, while still preventing concurrent launches
// in the normal case.
let launchInProgress = false;
let launchLockAcquiredAt = 0;
const LAUNCH_LOCK_MAX_AGE_MS = 6 * 60 * 1000;
function acquireLaunchLock() { launchInProgress = true; launchLockAcquiredAt = Date.now(); }
function releaseLaunchLock() { launchInProgress = false; launchLockAcquiredAt = 0; }
function isLaunchLockStale() {
    return launchInProgress && launchLockAcquiredAt > 0 && (Date.now() - launchLockAcquiredAt) > LAUNCH_LOCK_MAX_AGE_MS;
}

// Serializes all snapshot operations so they never run concurrently with a launch's restore.
// Without this, a launch's restoreAccountData can overwrite the disk while a watcher's snapshot
// is mid-read, corrupting the previous account's saved state.
let snapshotChain = Promise.resolve();
function queueSnapshot(accountId) {
    snapshotChain = snapshotChain.then(() => authLaunchService.snapshotAccountData(accountId).catch(() => {}));
    return snapshotChain;
}

// Shared launch entry point — invoked by both the `launch-valorant` IPC
// handler (from the main window) and the tray quick-launch menu. Returns the
// same shape so both callers can react consistently.
async function performLaunch(accountId) {
    if (launchInProgress) {
        if (!isLaunchLockStale()) {
            return { success: false, error: 'A launch is already in progress. Please wait.' };
        }
        // Lock has been held for 6+ minutes — almost certainly stuck.
        // Force-release so the user can recover without restarting Nebula.
        console.warn('[main] launch lock was stale, force-releasing');
        releaseLaunchLock();
    }
    acquireLaunchLock();
    // Stop the previous watcher and wait for any in-flight snapshot to complete BEFORE
    // we start overwriting the Riot Client directory with the new account's data.
    // Also reset the previously-watched account's UI state so it doesn't stay stuck on "Running".
    if (watchedAccountId && watchedAccountId !== accountId && mainWindow) {
        mainWindow.webContents.send('update-launch-status', watchedAccountId, 'idle');
    }
    stopValorantWatcher();
    await snapshotChain;
    if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'launching');
    try {
        const account = authService.getAccountById(accountId);
        if (!account) {
            releaseLaunchLock();
            if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'error', 'Account not found.');
            return { success: false, error: 'Account not found.' };
        }

        const autoLaunch = appStore.get('autoLaunchValorant', true);
        // When Appear Offline is on AND Deceive is installed, spawn Deceive
        // instead of Riot Client directly — it sets up its own proxy and
        // launches the Riot Client through it. Otherwise do a normal launch.
        const wantsAppearOffline = !!appStore.get('appearOffline', false);
        const deceiveReady = wantsAppearOffline ? await deceive.isInstalled() : false;
        // Kill any leftover Deceive from a previous account before launching.
        deceive.kill();
        const launchOpts = { useDeceive: deceiveReady };
        const result = await authLaunchService.launchValorant(account, autoLaunch, [], launchOpts);

        if (result.sessionExpired) {
            if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'error', 'Session expired');
            // Failsafe: handleReLogin has its own 5-minute internal timeout,
            // but if the Promise never resolves (process hang, user closes
            // Riot Client mid-flow, etc.) the launch lock would stay held
            // forever. Always release after 6 minutes, no exceptions.
            let lockReleased = false;
            const releaseOnce = () => { if (!lockReleased) { lockReleased = true; releaseLaunchLock(); } };
            const failsafeTimer = setTimeout(() => {
                if (!lockReleased) {
                    console.warn('[main] re-login failsafe timeout — releasing launch lock');
                    releaseOnce();
                    if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'idle');
                }
            }, 6 * 60 * 1000);
            authLaunchService.handleReLogin(accountId).then(() => {
                clearTimeout(failsafeTimer);
                authService.updateLastUsed(accountId);
                // Cookies/tokens were just refreshed via the Riot Client. The
                // pre-expiry access token we cached for this account is now
                // either stale or revoked, so wipe it — next live-API call
                // (rank, match info, store) re-issues a fresh one off the
                // new cookies instead of 401-ing on the cached one for up
                // to 50 minutes.
                invalidateLiveAuthCache(accountId);
                releaseOnce();
                if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'idle');
            }).catch((e) => {
                clearTimeout(failsafeTimer);
                releaseOnce();
                if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'idle');
                console.warn('Re-login flow failed:', e?.message || e);
            });
            return { success: false, error: 'Session expired. Please log in via the Riot Client — session will be saved automatically.', sessionExpired: true };
        }

        await authService.updateLastUsed(accountId);
        if (autoLaunch) {
            startValorantWatcher(accountId);
        } else {
            setTimeout(() => sendStatus(accountId, 'closed'), 3000);
            releaseLaunchLock();
        }
        return { success: true };
    } catch (error) {
        releaseLaunchLock();
        // If launchValorant threw after spawning Deceive, kill it so it
        // doesn't linger with no game to wrap.
        deceive.kill();
        if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'error', error.message);
        return { success: false, error: error.message };
    }
}

ipcMain.handle('launch-valorant', (event, accountId) => performLaunch(accountId));

ipcMain.handle('copy-cloud-settings', async (event, fromId, toId, categories) => {
    try {
        const fromAcc = authService.getAccountById(fromId);
        const toAcc = authService.getAccountById(toId);
        if (!fromAcc || !toAcc) throw new Error('Account not found.');

        // SAFETY: never write to RiotUserSettings.ini while Valorant is running.
        // Mid-session file writes are a Vanguard red flag and can trigger the
        // "VALORANT failed to launch" / temporary suspension screen.
        if (await authLaunchService.isValorantRunning()) {
            throw new Error('Close Valorant before copying settings.');
        }

        const getCookies = async (accountId) => {
            const stored = await authService.retrieveCookiesSecurely(accountId);
            if (stored?.ssid) return stored;
            const snap = await authLaunchService.extractCookiesFromSnapshot(accountId);
            if (snap?.ssid) return snap;
            return null;
        };

        const srcCookies = await getCookies(fromId);
        if (!srcCookies?.ssid) throw new Error('Source account session not found. Launch it first.');
        const dstCookies = await getCookies(toId);
        if (!dstCookies?.ssid) throw new Error('Target account session not found. Launch it first.');

        const srcAuth = await authService.getCloudAuthTokens(srcCookies.ssid, srcCookies.clid, srcCookies.csid, srcCookies.tdid);
        const dstAuth = await authService.getCloudAuthTokens(dstCookies.ssid, dstCookies.clid, dstCookies.csid, dstCookies.tdid);

        // Self-heal regions via PAS so the SGP shard routing below uses the
        // actual Valorant region for each side, not a stale userInfo-derived
        // guess from import time.
        const healRegion = async (accountId, current) => {
            if (regionVerifiedThisSession.has(accountId)) return current;
            const auth = accountId === fromId ? srcAuth : dstAuth;
            const probed = await authService._probeValorantRegion({
                accessToken: auth.accessToken,
                entitlementsToken: auth.entitlementsToken,
                puuid: accountId,
            });
            if (!probed) return current; // don't burn the retry budget on a failed probe
            regionVerifiedThisSession.add(accountId);
            if (probed !== current) {
                authService.updateAccountRegion(accountId, probed);
                return probed;
            }
            return current;
        };
        fromAcc.region = await healRegion(fromId, fromAcc.region);
        toAcc.region = await healRegion(toId, toAcc.region);

        // Build the flat list of pattern strings for every enabled category (used by
        // both the cloud backfill and the local .ini merge — keeps them in lockstep).
        // `additivePatterns` is a strict subset containing only the patterns whose
        // target values should never be wiped when source is empty (crosshair blob).
        const allCatKeys = Object.keys(KEY_PATTERNS);
        const cats = categories || Object.fromEntries(allCatKeys.map(k => [k, true]));
        const enabledPatterns = [];
        const additivePatterns = [];
        for (const cat of allCatKeys) {
            if (!cats[cat] || !KEY_PATTERNS[cat]?.length) continue;
            enabledPatterns.push(...KEY_PATTERNS[cat]);
            if (ADDITIVE_CATEGORIES.has(cat)) additivePatterns.push(...KEY_PATTERNS[cat]);
        }

        const [srcBlob, dstBlob] = await Promise.all([
            authService.getCloudSettings(srcAuth.accessToken, srcAuth.entitlementsToken, fromAcc.region),
            authService.getCloudSettings(dstAuth.accessToken, dstAuth.entitlementsToken, toAcc.region),
        ]);
        // Decode both blobs. Use the DESTINATION's compression method for the
        // encode round-trip so the uploaded blob matches what target's Valorant
        // client can read back — source and target can be in different legacy
        // formats, and mismatching them produces the in-game "Error retrieving
        // settings from server" error.
        const { settings: srcSettings } = authService._decodeSettingsBlob(srcBlob.data);
        const { settings: dstSettings, method: dstMethod } = authService._decodeSettingsBlob(dstBlob.data);

        // CRITICAL: Valorant only persists non-default values, and some keys
        // (MouseSensitivityADS/Zoomed, gamepad deadzones, etc.) never sync to cloud.
        // Backfill the source blob with local-file values so the mirror merge sees
        // the full picture — otherwise target's old cloud value survives and overrides
        // our local write on next launch.
        if (enabledPatterns.length) {
            const localShape = await authLaunchService.readLocalSettingsAsCloudShape(fromId, enabledPatterns);
            for (const arrName of ['floatSettings', 'boolSettings', 'stringSettings', 'intSettings']) {
                if (!srcSettings[arrName]) srcSettings[arrName] = [];
                for (const entry of localShape[arrName]) {
                    const idx = srcSettings[arrName].findIndex(s => s.settingEnum === entry.settingEnum);
                    if (idx >= 0) srcSettings[arrName][idx] = entry; // local file wins — it's the source of truth
                    else srcSettings[arrName].push(entry);
                }
            }
        }

        const merged = authService.mergeSelectiveSettings(srcSettings, dstSettings, cats, KEY_PATTERNS, EXCLUDE_KEY_PATTERNS, ADDITIVE_CATEGORIES);
        const newData = authService._encodeSettingsBlob(merged, dstMethod);
        await authService.putCloudSettings(dstAuth.accessToken, dstAuth.entitlementsToken, toAcc.region, { data: newData });

        // Local .ini merge runs the same pattern set against the per-account
        // RiotUserSettings.ini with mirror semantics (removing keys that source
        // doesn't have so Valorant re-defaults them).
        let localMergeWarning = null;
        if (enabledPatterns.length) {
            try {
                const localResult = await authLaunchService.mergeIniKeys(fromId, toId, 'RiotUserSettings.ini', enabledPatterns, additivePatterns);
                if (localResult.merged === 0 && localResult.removed === 0) {
                    localMergeWarning = 'Local file merge touched 0 keys — target account may have never launched Valorant on this PC.';
                }
            } catch (e) {
                localMergeWarning = `Local file merge failed: ${e.message}`;
            }
        }

        return { success: true, localMergeWarning };
    } catch (error) {
        console.error('[copy] failed:', error.message);
        return { success: false, error: error.message };
    }
});

// --- Appear Offline IPC ---
// Backed by bundled Deceive.exe (see deceive-manager.js). Global boolean:
// when ON, the next Valorant launch via Nebula spawns Deceive instead of
// the Riot Client directly. Doesn't affect already-running sessions.

// One-time migration: wipe the stale per-puuid set from the previous
// in-house MITM attempt.
if (appStore.has('appearOfflinePuuids')) {
    appStore.delete('appearOfflinePuuids');
}

ipcMain.handle('get-presence-state', async () => {
    return { success: true, isOffline: !!appStore.get('appearOffline', false) };
});

ipcMain.handle('set-appear-offline', async (event, offline) => {
    const next = !!offline;
    appStore.set('appearOffline', next);
    return { success: true, isOffline: next, requiresRelaunch: true };
});

// Deceive bundle management — fetches the latest Deceive.exe release from
// GitHub and saves it to the user's data folder. Used when Appear Offline
// is enabled but Deceive isn't yet installed.
ipcMain.handle('get-deceive-status', async () => {
    try {
        const installed = await deceive.isInstalled();
        return { success: true, installed, path: deceive.exePath() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('install-deceive', async () => {
    try {
        const result = await deceive.install();
        return { success: true, ...result };
    } catch (e) {
        console.log(`[deceive] install failed: ${e.message}`);
        return { success: false, error: e.message };
    }
});

// --- Settings IPC ---

ipcMain.handle('get-settings', async () => {
    // Auto-detect Riot Client path (this is the source of truth, not user-selected)
    let riotClientPath = '';
    try { riotClientPath = await authLaunchService.getRiotClientPath(); } catch {}
    return {
        riotClientPath,
        theme: appStore.get('theme', 'system'),
        autoLaunchValorant: appStore.get('autoLaunchValorant', true),
        // Opt-in live API features — both default OFF. When off, the tabs are
        // hidden AND the IPC handlers refuse the request (no endpoint calls).
        enableStoreFeature: appStore.get('enableStoreFeature', false),
        enableMatchInfoFeature: appStore.get('enableMatchInfoFeature', false),
        // Optional Henrikdev API key for the community-cache name fallback.
        // Empty string = not configured = skip that fallback entirely.
        henrikdevApiKey: appStore.get('henrikdevApiKey', ''),
        matchInfoAutoRefresh: appStore.get('matchInfoAutoRefresh', false),
    };
});

ipcMain.handle('save-settings', async (event, settings) => {
    if (settings.theme) {
        appStore.set('theme', settings.theme);
        if (mainWindow) mainWindow.webContents.send('apply-theme', settings.theme);
    }
    if (typeof settings.autoLaunchValorant === 'boolean') {
        appStore.set('autoLaunchValorant', settings.autoLaunchValorant);
    }
    if (typeof settings.enableStoreFeature === 'boolean') {
        appStore.set('enableStoreFeature', settings.enableStoreFeature);
    }
    if (typeof settings.enableMatchInfoFeature === 'boolean') {
        appStore.set('enableMatchInfoFeature', settings.enableMatchInfoFeature);
    }
    if (typeof settings.henrikdevApiKey === 'string') {
        appStore.set('henrikdevApiKey', settings.henrikdevApiKey.trim());
    }
    if (typeof settings.matchInfoAutoRefresh === 'boolean') {
        appStore.set('matchInfoAutoRefresh', settings.matchInfoAutoRefresh);
    }
    return { success: true };
});

// --- Live Valorant API IPC (gated by opt-in settings) ---

// Shared helper: fetch access + entitlements tokens for the given account.
// Prefers stored cookies, falls back to snapshot cookies, mirrors the
// copy-cloud-settings flow so the same auth path is reused.
// Self-heals the stored region via PAS once per session — fixes legacy
// accounts that were saved with the LoL affinity before PAS detection
// existed, without forcing the user to re-import.
//
// Tokens are cached per-account for ~50 minutes. Riot's RSO access tokens
// last roughly 1 hour, so caching cuts auth-endpoint hits from once-per-
// IPC to once-per-hour. Without this, the auto-refresh loop (every 15s)
// would re-issue 240 access tokens per 15 minutes — that's enough to
// trigger Riot's auth-endpoint rate limiter, which then fails subsequent
// `getCloudAuthTokens` calls and silently breaks all live API features.
const regionVerifiedThisSession = new Set();
const liveAuthCache = new Map(); // accountId → { value, expiresAt }
const LIVE_AUTH_TTL_MS = 50 * 60 * 1000;

function invalidateLiveAuthCache(accountId) {
    if (accountId) liveAuthCache.delete(accountId);
    else liveAuthCache.clear();
}

async function resolveLiveAuthTokens(accountId) {
    const cached = liveAuthCache.get(accountId);
    if (cached && Date.now() < cached.expiresAt) return cached.value;

    const account = authService.getAccountById(accountId);
    if (!account) throw new Error('Account not found.');
    const stored = await authService.retrieveCookiesSecurely(accountId);
    let cookies = stored?.ssid ? stored : null;
    if (!cookies) {
        const snap = await authLaunchService.extractCookiesFromSnapshot(accountId);
        if (snap?.ssid) cookies = snap;
    }
    if (!cookies?.ssid) throw new Error('Session expired. Launch this account first.');
    const { accessToken, entitlementsToken } = await authService.getCloudAuthTokens(
        cookies.ssid, cookies.clid, cookies.csid, cookies.tdid
    );

    let region = account.region;
    if (!regionVerifiedThisSession.has(accountId)) {
        // Probe every pd shard in parallel and pick whichever returns
        // 200/404 for this puuid's MMR. This is the authoritative source —
        // PAS chat affinity can return chat-POP codes (e.g. `us-br1`) that
        // don't match the game region, so we don't trust it anymore.
        const probedRegion = await authService._probeValorantRegion({
            accessToken, entitlementsToken, puuid: account.id,
        });
        if (probedRegion) {
            regionVerifiedThisSession.add(accountId);
            if (probedRegion !== region) {
                console.log(`[main] region self-heal: ${account.displayName || accountId.slice(0, 8)} ${region} → ${probedRegion}`);
                authService.updateAccountRegion(accountId, probedRegion);
                region = probedRegion;
            }
        } else {
            console.warn(`[main] region probe failed for ${account.displayName || accountId.slice(0, 8)} — will retry on next call`);
        }
    }

    const value = { accessToken, entitlementsToken, puuid: account.id, region };
    liveAuthCache.set(accountId, { value, expiresAt: Date.now() + LIVE_AUTH_TTL_MS });
    return value;
}

// Walk every stored account and ask PAS for the real Valorant region.
// Runs once shortly after startup so broken/stale region labels get fixed
// without waiting for the user to trigger a live-API call on each account.
// Silent per-account failures — any account we can't get tokens for is
// skipped and retried next launch.
async function scanAllAccountRegions() {
    const accounts = authService.getAccountsList?.() || authService.accounts || [];
    if (!accounts.length) return;
    console.log(`[main] region scan: probing ${accounts.length} account(s)`);
    let healed = 0, failed = 0;
    for (const acc of accounts) {
        if (regionVerifiedThisSession.has(acc.id)) continue;
        try {
            const stored = await authService.retrieveCookiesSecurely(acc.id);
            let cookies = stored?.ssid ? stored : null;
            if (!cookies) {
                const snap = await authLaunchService.extractCookiesFromSnapshot(acc.id);
                if (snap?.ssid) cookies = snap;
            }
            if (!cookies?.ssid) { failed++; continue; }
            const { accessToken, entitlementsToken } = await authService.getCloudAuthTokens(
                cookies.ssid, cookies.clid, cookies.csid, cookies.tdid
            );
            const probedRegion = await authService._probeValorantRegion({
                accessToken, entitlementsToken, puuid: acc.id,
            });
            if (!probedRegion) { failed++; continue; }
            regionVerifiedThisSession.add(acc.id);
            if (probedRegion !== acc.region) {
                console.log(`[main] region scan heal: ${acc.displayName || acc.id.slice(0, 8)} ${acc.region} → ${probedRegion}`);
                authService.updateAccountRegion(acc.id, probedRegion);
                healed++;
            }
        } catch (e) {
            failed++;
        }
    }
    console.log(`[main] region scan done: ${healed} healed, ${failed} skipped`);
    // Stored regions are fixed immediately; the renderer's account-list badge
    // catches up on the next fetch (launch, refresh, tab switch). Every live
    // API call reads region straight from `resolveLiveAuthTokens`, which
    // already uses the healed value — no stale data leaks into the backend.
}

// On startup, walk every account's daily store, cross-reference against the
// wishlist, and surface a Windows notification per account that has at least
// one wishlisted skin (not already owned). Silent on every failure path —
// expired sessions, no key, store feature disabled, no wishlist, etc. Doesn't
// require the Store tab to be opened.
async function checkWishlistOnStartup() {
    console.log('[wishlist] startup check: starting');
    if (!appStore.get('enableStoreFeature', false)) {
        console.log('[wishlist] startup check: store feature disabled in settings, skipping');
        return;
    }
    if (!Notification.isSupported()) {
        console.log('[wishlist] startup check: Electron Notification API not supported on this system, skipping');
        return;
    }
    const wishlist = appStore.get('storeWishlist', {});
    const wishlistSize = Object.keys(wishlist).length;
    if (!wishlistSize) {
        console.log('[wishlist] startup check: wishlist empty, skipping');
        return;
    }
    const accounts = authService.getAccounts() || [];
    if (!accounts.length) {
        console.log('[wishlist] startup check: no accounts, skipping');
        return;
    }
    console.log(`[wishlist] startup check: ${accounts.length} account(s), ${wishlistSize} wishlisted skin(s)`);

    let totalHits = 0;
    for (const account of accounts) {
        const accountName = account.nickname || account.displayName || account.username || 'Account';
        try {
            const ctx = await resolveLiveAuthTokens(account.id);
            const store = await gameService.getStore(ctx);
            const dailyCount = store.daily?.items?.length || 0;
            const hits = (store.daily?.items || []).filter(i => wishlist[i.uuid] && !i.owned);
            console.log(`[wishlist] ${accountName}: scanned ${dailyCount} daily item(s), ${hits.length} match(es)`);
            if (!hits.length) continue;
            totalHits++;
            const names = hits.map(h => h.name).join(' • ');
            fireNotification(`Wishlist hit — ${accountName}`, names);
            console.log(`[wishlist] notification dispatched for ${accountName}: ${names}`);
        } catch (e) {
            console.log(`[wishlist] ${accountName} skipped: ${e.message}`);
        }
        // Small gap between accounts to avoid hammering Riot's auth/store
        // endpoints when the user has many accounts.
        await new Promise(r => setTimeout(r, 600));
    }
    console.log(`[wishlist] startup check: done (${totalHits} account(s) with hits)`);
}

ipcMain.handle('get-store', async (event, accountId) => {
    if (!appStore.get('enableStoreFeature', false)) {
        return { success: false, error: 'Store feature is disabled in settings.' };
    }
    try {
        const ctx = await resolveLiveAuthTokens(accountId);
        const store = await gameService.getStore(ctx);
        return { success: true, store };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Match-IDs we've already alerted on for blacklist hits, so the same match
// doesn't re-fire a Windows notification on every 15s auto-refresh tick.
// Bounded — keep the most recent 50 to avoid unbounded growth across a
// long-running session.
const notifiedBlacklistMatches = new Set();

ipcMain.handle('get-match-info', async (event, accountId) => {
    if (!appStore.get('enableMatchInfoFeature', false)) {
        return { success: false, error: 'Match Info feature is disabled in settings.' };
    }
    try {
        const ctx = await resolveLiveAuthTokens(accountId);
        const henrikdevApiKey = appStore.get('henrikdevApiKey', '');
        // Best-effort: pull a puuid→partyId map from the local Riot Client
        // chat roster. Covers self + party members + online friends; enemies
        // who aren't in the roster just get null partyId (no color).
        const partyMap = await authLaunchService.fetchPartyMap();
        const info = await gameService.getMatchInfo(ctx, { henrikdevApiKey, partyMap });

        // Surface a Windows notification if any blacklisted player is in
        // this match. Fires once per (matchId, hit-set) so re-refreshes
        // don't spam — same dedupe shape the renderer toast uses. Runs
        // backend-side so the alert reaches the user even if they're in
        // the tray or on a different tab when the match starts.
        if (info?.inMatch && info.matchId) {
            const blacklist = appStore.get('playerBlacklist', {});
            const all = [info.self, ...(info.ally || []), ...(info.enemy || [])].filter(Boolean);
            const hits = all.filter(p => p?.puuid && blacklist[p.puuid]);
            if (hits.length) {
                const key = `${info.matchId}:${hits.map(p => p.puuid).sort().join(',')}`;
                if (!notifiedBlacklistMatches.has(key)) {
                    notifiedBlacklistMatches.add(key);
                    if (notifiedBlacklistMatches.size > 50) {
                        const oldest = notifiedBlacklistMatches.values().next().value;
                        notifiedBlacklistMatches.delete(oldest);
                    }
                    const names = hits.map(p => blacklist[p.puuid].name || p.name || 'Unknown').join(', ');
                    fireNotification('⚠ Blacklisted player in match', names);
                }
            }
        }

        return { success: true, match: info };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Rank badge lookup for a single account (used by Account Manager display).
// NOT gated by the Match Info feature toggle — a single rank fetch per account
// is lightweight, stays account-scoped, and is part of the core account
// management experience. The heavier Match Info surface is still gated.
ipcMain.handle('get-account-rank', async (event, accountId) => {
    try {
        const ctx = await resolveLiveAuthTokens(accountId);
        const rank = await gameService.getAccountRank(ctx);
        return { success: true, rank };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Returns the puuid of whichever account the local Riot Client is currently
// authenticated as, or null if Riot Client isn't running. Used by the
// renderer's auto-refresh to find an account to poll even when Valorant
// was launched outside of Nebula (so `statuses[id].status === 'running'`
// is never set by our launch tracker).
ipcMain.handle('get-live-account', async () => {
    try {
        const info = await authLaunchService.getAuthenticatedAccount();
        return { success: true, puuid: info?.puuid || null };
    } catch {
        return { success: true, puuid: null };
    }
});

// Today's session stats: W/L, K/D, RR delta. Like rank badges, this is a
// core account-management feature and is NOT gated behind the Match Info flag.
ipcMain.handle('get-session-stats', async (event, accountId) => {
    try {
        const ctx = await resolveLiveAuthTokens(accountId);
        const session = await gameService.getSessionStats(ctx);
        return { success: true, session };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Full player stats for the click-to-inspect modal in Match Info.
// Auth comes from the VIEWING account — we use its tokens to query any
// target puuid's MMR / match history.
ipcMain.handle('get-player-stats', async (event, viewerAccountId, targetPuuid) => {
    if (!appStore.get('enableMatchInfoFeature', false)) {
        return { success: false, error: 'Match Info feature is disabled.' };
    }
    try {
        const ctx = await resolveLiveAuthTokens(viewerAccountId);
        const stats = await gameService.getPlayerStats(ctx, targetPuuid);
        return { success: true, stats };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Full skin catalog for the "browse skins" wishlist dialog. When called
// with an accountId, cross-references the static catalog against Riot's
// live /store/v1/offers to filter out battlepass, VCT, and other non-buyable
// skins — only keeping items that are actually purchasable with VP.
// Both the static catalog and the offers list are cached session-lifetime.
ipcMain.handle('get-skin-catalog', async (event, accountId) => {
    try {
        const catalog = await gameService.ensureSkinCatalog();
        if (!accountId) return { success: true, catalog };
        try {
            const ctx = await resolveLiveAuthTokens(accountId);
            const buyable = await gameService.fetchBuyableSkinOfferIds(ctx);
            if (buyable.size === 0) {
                // Offers fetch failed or returned empty — fall back to unfiltered
                // so the user still sees something.
                return { success: true, catalog };
            }
            const filtered = catalog.filter(s => buyable.has(s.uuid));
            return { success: true, catalog: filtered };
        } catch {
            // Auth failure — still return the unfiltered catalog
            return { success: true, catalog };
        }
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// --- Store wishlist ---
// Stored via electron-store as { [skinLevelUuid]: { name, addedAt } }.
// The renderer checks daily store items against this on fetch and shows a
// badge when a wishlisted item appears in any account's store.
ipcMain.handle('get-wishlist', async () => {
    const stored = appStore.get('storeWishlist', {});
    // Auto-prune entries that aren't in the current browseable catalog —
    // these are orphans from older versions when the catalog had different
    // filtering (e.g. VCT skins were once buyable, now excluded). Without
    // this prune they show up in the wishlist count but are invisible in
    // the UI, so the user sees "1 item" but can't find/remove it.
    try {
        const catalog = await gameService.ensureSkinCatalog();
        const validUuids = new Set(catalog.map(s => s.uuid));
        const cleaned = {};
        let removed = 0;
        for (const [uuid, entry] of Object.entries(stored)) {
            if (validUuids.has(uuid)) cleaned[uuid] = entry;
            else removed++;
        }
        if (removed > 0) {
            appStore.set('storeWishlist', cleaned);
            console.log(`[main] wishlist auto-prune: removed ${removed} orphaned entries`);
        }
        return { success: true, wishlist: cleaned };
    } catch {
        // Catalog fetch failed — return the stored wishlist as-is rather
        // than risk showing nothing.
        return { success: true, wishlist: stored };
    }
});

ipcMain.handle('add-to-wishlist', (event, { uuid, name }) => {
    if (!uuid) return { success: false, error: 'uuid required' };
    const current = appStore.get('storeWishlist', {});
    current[uuid] = { name: name || 'Unknown Skin', addedAt: Date.now() };
    appStore.set('storeWishlist', current);
    return { success: true };
});

ipcMain.handle('remove-from-wishlist', (event, uuid) => {
    if (!uuid) return { success: false, error: 'uuid required' };
    const current = appStore.get('storeWishlist', {});
    delete current[uuid];
    appStore.set('storeWishlist', current);
    return { success: true };
});

// --- Player blacklist ---
// Stored via electron-store under the key 'playerBlacklist' as an object
// keyed by puuid: { [puuid]: { name, reason, addedAt } }. Used by Match Info
// to warn the user when a previously-flagged player shows up in their match.
ipcMain.handle('get-blacklist', () => {
    return { success: true, blacklist: appStore.get('playerBlacklist', {}) };
});

// Defensive helper — never let any blacklist path target one of the user's
// own accounts. Blacklisting yourself dumps your own Riot ID into the
// in-match warning toast every time you queue, which is nonsense.
function isOwnAccountPuuid(puuid) {
    if (!puuid) return false;
    const accounts = authService.getAccounts() || [];
    return accounts.some(a => a.id === puuid);
}

ipcMain.handle('add-to-blacklist', (event, { puuid, name, reason }) => {
    if (!puuid) return { success: false, error: 'puuid required' };
    if (isOwnAccountPuuid(puuid)) {
        return { success: false, error: 'Cannot blacklist one of your own accounts.' };
    }
    const current = appStore.get('playerBlacklist', {});
    current[puuid] = { name: name || 'Unknown', reason: reason || '', addedAt: Date.now() };
    appStore.set('playerBlacklist', current);
    return { success: true };
});

// Blacklist by Riot ID (e.g. "v1ni#cius"). Resolves the name to a puuid via
// Henrikdev's by-name endpoint, then writes the entry. The blacklist has
// always been puuid-keyed so flagging survives Riot ID changes — this just
// gives the user a way to add entries without needing to find the player
// in a live match first.
ipcMain.handle('add-to-blacklist-by-riot-id', async (event, { riotId, reason }) => {
    try {
        const apiKey = appStore.get('henrikdevApiKey', '');
        const resolved = await gameService.resolvePuuidByRiotId(riotId, apiKey);
        if (isOwnAccountPuuid(resolved.puuid)) {
            return {
                success: false,
                error: `${resolved.name}#${resolved.tag} is one of your own accounts — can't blacklist it.`,
            };
        }
        const current = appStore.get('playerBlacklist', {});
        if (current[resolved.puuid]) {
            return {
                success: false,
                error: `${resolved.name}#${resolved.tag} is already on your blacklist.`,
            };
        }
        const niceName = `${resolved.name}#${resolved.tag}`;
        current[resolved.puuid] = { name: niceName, reason: reason || '', addedAt: Date.now() };
        appStore.set('playerBlacklist', current);
        return { success: true, name: niceName, puuid: resolved.puuid };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Player Lookup — resolves a Riot ID, then walks Henrikdev's matchlist for
// that puuid to surface every name the player has been seen as. Same data
// source community trackers like vtl.lol use (Riot's match records preserve
// the player's name at match time). Single Henrikdev call per match-fetch
// step; no Riot live-API hits, so doesn't need the Match Info opt-in.
ipcMain.handle('lookup-player', async (event, { riotId }) => {
    try {
        const apiKey = appStore.get('henrikdevApiKey', '');
        if (!apiKey) {
            return { success: false, error: 'Set your Henrikdev API key in Settings first.' };
        }
        const resolved = await gameService.resolvePuuidByRiotId(riotId, apiKey);
        if (!resolved.region) {
            return {
                success: false,
                error: 'Henrikdev returned the player but no region — match history needs a region. Try again in a minute.',
            };
        }
        const history = await gameService.getNameHistory(resolved.puuid, resolved.region, apiKey);
        const blacklist = appStore.get('playerBlacklist', {});
        return {
            success: true,
            puuid: resolved.puuid,
            name: resolved.name,
            tag: resolved.tag,
            region: resolved.region,
            blacklisted: !!blacklist[resolved.puuid],
            history: history.names,
            unattributedCount: history.unattributedCount,
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('remove-from-blacklist', (event, puuid) => {
    if (!puuid) return { success: false, error: 'puuid required' };
    const current = appStore.get('playerBlacklist', {});
    delete current[puuid];
    appStore.set('playerBlacklist', current);
    return { success: true };
});

// select-valorant-path removed: Riot Client is auto-detected from ProgramData/RiotClientInstalls.json

ipcMain.handle('minimize-to-tray', () => {
    if (mainWindow) mainWindow.hide();
});

ipcMain.handle('quit-app', () => {
    app.isQuitting = true;
    app.quit();
});

ipcMain.handle('open-external-link', (event, url) => {
    if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url);
});

// --- Watcher ---

function sendStatus(accountId, status, message) {
    if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, status, message);
    // Auto-clear closed/error states after a few seconds
    if (status === 'closed' || status === 'error') {
        setTimeout(() => {
            if (mainWindow) mainWindow.webContents.send('update-launch-status', accountId, 'idle');
        }, status === 'error' ? 8000 : 5000);
    }
}

// Polling cadence. PRELAUNCH is fast so the UI flips to "running" quickly
// once Valorant is detected; INGAME is much slower because we only need
// to notice the eventual close, and `tasklist` spawns at 3s while playing
// add up (20+ subprocess spawns per minute → minor but unnecessary load).
const WATCHER_TICK_MS_PRELAUNCH = 3000;
const WATCHER_TICK_MS_INGAME = 10000;
const WATCHER_MAX_CHECKS = 60; // 3 minutes at 3s = covers cold boot + Vanguard init + AV scan
const WATCHER_API_LAUNCH_CHECK = 2; // ~6s before trying the local API fallback

function startValorantWatcher(accountId) {
    stopValorantWatcher();
    watchedAccountId = accountId;
    let valorantFound = false, checks = 0, apiTried = false, errorStreak = 0;

    const tick = async () => {
        checks++;
        try {
            const valRunning = await authLaunchService.isValorantRunning();
            errorStreak = 0;

            if (valRunning && !valorantFound) {
                // Verify the running Riot Client is authed as THIS account
                // (prevents false positives from leftover Valorant from the previous account)
                const auth = await authLaunchService.getAuthenticatedAccount();
                if (!auth || auth.puuid !== accountId) return; // wrong account / not yet authed
                valorantFound = true;
                releaseLaunchLock();
                queueSnapshot(accountId);
                sendStatus(accountId, 'running');
                // Slow down polling now that we're in-game — `tasklist` every
                // 3s isn't free during a Valorant match.
                if (valorantProcessWatcher) clearInterval(valorantProcessWatcher);
                valorantProcessWatcher = setInterval(tick, WATCHER_TICK_MS_INGAME);
            } else if (!valRunning && valorantFound) {
                queueSnapshot(accountId);
                sendStatus(accountId, 'closed');
                stopValorantWatcher();
                deceive.kill();
            } else if (!valorantFound && !apiTried && checks >= WATCHER_API_LAUNCH_CHECK) {
                apiTried = true;
                authLaunchService.tryApiLaunch().catch(() => {});
            } else if (!valorantFound && checks > WATCHER_MAX_CHECKS) {
                releaseLaunchLock();
                sendStatus(accountId, 'closed');
                stopValorantWatcher();
                deceive.kill();
            }
        } catch (e) {
            errorStreak++;
            console.warn(`[watcher] tick error (#${errorStreak}): ${e?.message || e}`);
            // Bail after 5 consecutive errors so a persistent failure doesn't
            // leave the launch lock held while the watcher silently spins.
            if (errorStreak >= 5 || checks > 10) {
                releaseLaunchLock();
                sendStatus(accountId, 'closed');
                stopValorantWatcher();
                deceive.kill();
            }
        }
    };

    valorantProcessWatcher = setInterval(tick, WATCHER_TICK_MS_PRELAUNCH);
}

function stopValorantWatcher() {
    if (valorantProcessWatcher) { clearInterval(valorantProcessWatcher); valorantProcessWatcher = null; }
    watchedAccountId = null;
}
