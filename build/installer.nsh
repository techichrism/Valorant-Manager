; ========================================================================
; Nebula custom NSIS installer script
; Cleans up orphaned files from LEGACY (v2 era) installs. Must never touch
; $APPDATA\nebula — that's where current user accounts and auth snapshots live.
; ========================================================================

!macro customInit
  ; Kill any running Nebula / Riot processes so we can replace the binary cleanly.
  ; DO NOT delete $APPDATA\nebula here — updates must preserve user accounts
  ; (config.json) and auth snapshots (snapshots/).
  nsExec::Exec 'taskkill /F /IM "Nebula.exe" /T'
  nsExec::Exec 'taskkill /F /IM "Riot Client.exe" /T'
  nsExec::Exec 'taskkill /F /IM RiotClientServices.exe /T'
  Sleep 500

  ; --- Remove orphaned program files from legacy install locations ---
  ; These are separate from the current per-user install path, safe to wipe.
  RMDir /r "$LOCALAPPDATA\Programs\nebula"
  RMDir /r "$LOCALAPPDATA\Programs\Nebula"
  RMDir /r "$PROGRAMFILES\Nebula"
  RMDir /r "$PROGRAMFILES64\Nebula"

  ; --- Remove stale Windows Credential Manager entries from keytar (v2 era) ---
  ; v3+ uses Electron safeStorage (DPAPI) inlined in config.json instead.
  nsExec::Exec 'cmdkey /delete:NebulaAccountManager'
  nsExec::Exec 'cmdkey /delete:NebulaStoreKey'

  ; --- Remove stale shortcuts from older versions ---
  Delete "$DESKTOP\Nebula.lnk"
  Delete "$SMPROGRAMS\Nebula.lnk"
  Delete "$SMPROGRAMS\Nebula\Nebula.lnk"
  RMDir "$SMPROGRAMS\Nebula"
!macroend

!macro customUnInit
  ; Kill any running instances before uninstall
  nsExec::Exec 'taskkill /F /IM "Nebula.exe" /T'
  Sleep 500
!macroend

!macro customUnInstall
  ; Extra cleanup on uninstall in case electron-builder's deleteAppDataOnUninstall misses anything
  RMDir /r "$APPDATA\nebula"
  RMDir /r "$LOCALAPPDATA\nebula"

  ; Remove any leftover credential entries
  nsExec::Exec 'cmdkey /delete:NebulaAccountManager'
  nsExec::Exec 'cmdkey /delete:NebulaStoreKey'
!macroend
