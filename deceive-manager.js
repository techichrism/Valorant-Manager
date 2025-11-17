// Deceive integration.
//
// Deceive (https://github.com/molenzwiebel/Deceive) is a battle-tested
// appear-offline tool for Riot Games products. Rather than reimplementing
// its config + XMPP MITM proxies inside Nebula (which kept hitting
// BoringSSL edge cases), we spawn Deceive.exe as a subprocess when the
// user launches Valorant with Appear Offline on. Deceive handles the
// proxy + Riot Client launch; Nebula just kicks it off and monitors.
//
// Deceive.exe is downloaded on demand to the user's data folder on first
// use — keeps Nebula's installer small and lets us stay decoupled from
// any specific Deceive version.

const { app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');

const DECEIVE_REPO = 'molenzwiebel/Deceive';
const USER_AGENT = 'Nebula-AppearOffline';

class DeceiveManager {
    constructor() {
        this.process = null;
    }

    // We install Deceive.exe as "DeceiveVAL.exe" so that Deceive's own
    // game-detection logic sees "VAL" in the executable name and auto-
    // launches Valorant without prompting. This is Deceive's documented
    // way to force-select the game from the outside — saves us passing
    // any specific CLI args.
    exePath() {
        return path.join(app.getPath('userData'), 'deceive', 'DeceiveVAL.exe');
    }

    _versionFile() {
        return path.join(path.dirname(this.exePath()), '.version');
    }

    async getInstalledVersion() {
        try {
            return (await fs.readFile(this._versionFile(), 'utf-8')).trim() || null;
        } catch { return null; }
    }

    async _writeInstalledVersion(tag) {
        try { await fs.writeFile(this._versionFile(), String(tag || ''), 'utf-8'); } catch { /* non-fatal */ }
    }

    async isInstalled() {
        // Migrate from the old location (Deceive.exe) to the new one
        // (DeceiveVAL.exe) if a previous install left it around.
        try {
            const newPath = this.exePath();
            const oldPath = path.join(path.dirname(newPath), 'Deceive.exe');
            const [newStat, oldStat] = await Promise.all([
                fs.stat(newPath).catch(() => null),
                fs.stat(oldPath).catch(() => null),
            ]);
            if (!newStat && oldStat && oldStat.size > 0) {
                await fs.rename(oldPath, newPath);
                console.log(`[deceive] migrated Deceive.exe → DeceiveVAL.exe`);
                return true;
            }
            return !!(newStat && newStat.isFile() && newStat.size > 0);
        } catch {
            return false;
        }
    }

    async _httpsJson(url) {
        return new Promise((resolve, reject) => {
            https.get(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/vnd.github+json' } }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    if (res.statusCode >= 300) return reject(new Error(`GitHub API returned ${res.statusCode}: ${data.slice(0, 200)}`));
                    try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
                });
            }).on('error', reject);
        });
    }

    // GitHub release assets download via a redirect chain. We have to
    // follow redirects manually since Node's https module doesn't by default.
    async _downloadFollowingRedirects(url, dest) {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        return new Promise((resolve, reject) => {
            const fetch = (currentUrl, hops = 0) => {
                if (hops > 5) return reject(new Error('too many redirects'));
                const opts = { headers: { 'User-Agent': USER_AGENT } };
                https.get(currentUrl, opts, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        res.resume();
                        return fetch(res.headers.location, hops + 1);
                    }
                    if (res.statusCode !== 200) {
                        return reject(new Error(`download HTTP ${res.statusCode}`));
                    }
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', async () => {
                        try {
                            await fs.writeFile(dest, Buffer.concat(chunks));
                            resolve();
                        } catch (e) { reject(e); }
                    });
                }).on('error', reject);
            };
            fetch(url);
        });
    }

    async install() {
        console.log('[deceive] fetching latest release info...');
        const release = await this._httpsJson(`https://api.github.com/repos/${DECEIVE_REPO}/releases/latest`);
        const asset = (release?.assets || []).find(a => a.name === 'Deceive.exe');
        if (!asset) throw new Error('no Deceive.exe found in latest release');
        console.log(`[deceive] downloading ${release.tag_name} → ${this.exePath()}`);
        await this._downloadFollowingRedirects(asset.browser_download_url, this.exePath());
        await this._writeInstalledVersion(release.tag_name);
        console.log('[deceive] install complete');
        return { version: release.tag_name };
    }

    // Silent background update check. Called on app startup (only if the
    // user has Appear Offline enabled). Skips if Deceive isn't installed,
    // isn't running is required for the file replace, or the GitHub API
    // is unreachable / rate-limited. Returns the new version if updated,
    // null if already up-to-date, or throws on unexpected failure.
    async checkForUpdate() {
        if (this.isRunning()) return null; // can't replace a running exe
        if (!(await this.isInstalled())) return null;
        let release;
        try {
            release = await this._httpsJson(`https://api.github.com/repos/${DECEIVE_REPO}/releases/latest`);
        } catch (e) {
            console.log(`[deceive] update check skipped: ${e.message}`);
            return null;
        }
        const latest = release?.tag_name;
        if (!latest) return null;
        const current = await this.getInstalledVersion();
        if (current === latest) {
            console.log(`[deceive] already on latest (${latest})`);
            return null;
        }
        const asset = (release?.assets || []).find(a => a.name === 'Deceive.exe');
        if (!asset) return null;
        console.log(`[deceive] updating ${current || 'unknown'} → ${latest}`);
        await this._downloadFollowingRedirects(asset.browser_download_url, this.exePath());
        await this._writeInstalledVersion(latest);
        return { from: current, to: latest };
    }

    // Launch Deceive (installed as DeceiveVAL.exe). Deceive reads its own
    // executable name, sees "VAL", and goes straight to Valorant launch —
    // no CLI args required.
    launch() {
        if (this.isRunning()) return;
        const exe = this.exePath();
        console.log(`[deceive] spawn ${exe}`);
        this.process = spawn(exe, [], {
            detached: true,
            stdio: 'ignore',
            cwd: path.dirname(exe),
        });
        this.process.unref();
        this.process.on('exit', (code) => {
            console.log(`[deceive] exited (code=${code})`);
            this.process = null;
        });
    }

    kill() {
        if (!this.isRunning()) return;
        const pid = this.process.pid;
        console.log(`[deceive] killing pid ${pid}`);
        try {
            if (process.platform === 'win32') {
                spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
            } else {
                this.process.kill('SIGTERM');
            }
        } catch (e) {
            console.log(`[deceive] kill failed: ${e.message}`);
        }
        this.process = null;
    }

    isRunning() {
        return !!(this.process && this.process.exitCode === null && !this.process.killed);
    }
}

module.exports = new DeceiveManager();
