const { contextBridge, ipcRenderer } = require('electron');

const listeners = { 'update-launch-status': null, 'apply-theme': null, 'confirm-close': null, 'update-status': null };

contextBridge.exposeInMainWorld('electronAPI', {
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    getAccounts: () => ipcRenderer.invoke('get-accounts'),
    loginWithRiot: () => ipcRenderer.invoke('login-with-riot'),
    importCurrentAccount: () => ipcRenderer.invoke('import-current-account'),
    removeAccount: (id) => ipcRenderer.invoke('remove-account', id),
    launchValorant: (id) => ipcRenderer.invoke('launch-valorant', id),
    copyCloudSettings: (fromId, toId, categories) => ipcRenderer.invoke('copy-cloud-settings', fromId, toId, categories),
    setNickname: (id, name) => ipcRenderer.invoke('set-nickname', id, name),
    reorderAccounts: (ids) => ipcRenderer.invoke('reorder-accounts', ids),
    checkSession: (id) => ipcRenderer.invoke('check-session', id),

    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
    getPresenceState: () => ipcRenderer.invoke('get-presence-state'),
    setAppearOffline: (offline) => ipcRenderer.invoke('set-appear-offline', offline),
    getDeceiveStatus: () => ipcRenderer.invoke('get-deceive-status'),
    installDeceive: () => ipcRenderer.invoke('install-deceive'),
    getStore: (id) => ipcRenderer.invoke('get-store', id),
    getMatchInfo: (id) => ipcRenderer.invoke('get-match-info', id),
    getAccountRank: (id) => ipcRenderer.invoke('get-account-rank', id),
    getLiveAccount: () => ipcRenderer.invoke('get-live-account'),
    getSessionStats: (id) => ipcRenderer.invoke('get-session-stats', id),
    getPlayerStats: (viewerId, targetPuuid) => ipcRenderer.invoke('get-player-stats', viewerId, targetPuuid),
    getBlacklist: () => ipcRenderer.invoke('get-blacklist'),
    addToBlacklist: (entry) => ipcRenderer.invoke('add-to-blacklist', entry),
    addToBlacklistByRiotId: (entry) => ipcRenderer.invoke('add-to-blacklist-by-riot-id', entry),
    removeFromBlacklist: (puuid) => ipcRenderer.invoke('remove-from-blacklist', puuid),
    lookupPlayer: (entry) => ipcRenderer.invoke('lookup-player', entry),
    getWishlist: () => ipcRenderer.invoke('get-wishlist'),
    addToWishlist: (entry) => ipcRenderer.invoke('add-to-wishlist', entry),
    removeFromWishlist: (uuid) => ipcRenderer.invoke('remove-from-wishlist', uuid),
    getSkinCatalog: (accountId) => ipcRenderer.invoke('get-skin-catalog', accountId),
    minimizeToTray: () => ipcRenderer.invoke('minimize-to-tray'),
    quitApp: () => ipcRenderer.invoke('quit-app'),
    onConfirmClose: (cb) => {
        if (listeners['confirm-close']) ipcRenderer.removeListener('confirm-close', listeners['confirm-close']);
        const wrapped = () => cb();
        listeners['confirm-close'] = wrapped;
        ipcRenderer.on('confirm-close', wrapped);
    },
    openExternalLink: (url) => ipcRenderer.invoke('open-external-link', url),

    installUpdateNow: () => ipcRenderer.invoke('install-update-now'),
    onUpdateStatus: (cb) => {
        if (listeners['update-status']) ipcRenderer.removeListener('update-status', listeners['update-status']);
        const wrapped = (_e, info) => cb(info);
        listeners['update-status'] = wrapped;
        ipcRenderer.on('update-status', wrapped);
    },

    onUpdateLaunchStatus: (cb) => {
        if (listeners['update-launch-status']) ipcRenderer.removeListener('update-launch-status', listeners['update-launch-status']);
        const wrapped = (_e, ...args) => cb(...args);
        listeners['update-launch-status'] = wrapped;
        ipcRenderer.on('update-launch-status', wrapped);
    },
    onApplyTheme: (cb) => {
        if (listeners['apply-theme']) ipcRenderer.removeListener('apply-theme', listeners['apply-theme']);
        const wrapped = (_e, theme) => cb(theme);
        listeners['apply-theme'] = wrapped;
        ipcRenderer.on('apply-theme', wrapped);
    },
    removeUpdateLaunchStatusListener: () => {
        if (listeners['update-launch-status']) { ipcRenderer.removeListener('update-launch-status', listeners['update-launch-status']); listeners['update-launch-status'] = null; }
    },
    removeApplyThemeListener: () => {
        if (listeners['apply-theme']) { ipcRenderer.removeListener('apply-theme', listeners['apply-theme']); listeners['apply-theme'] = null; }
    },
});
