; Broadcaster NSIS installer hooks.
;
; Called by Tauri's NSIS installer template. We refresh the Windows shell
; icon cache on install and uninstall so Explorer / taskbar / Start Menu
; pick up the new Broadcaster icon instead of a stale cached version.

!macro NSIS_HOOK_POSTINSTALL
  ExecShell "" "$SYSDIR\ie4uinit.exe" "-show" SW_HIDE
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ExecShell "" "$SYSDIR\ie4uinit.exe" "-show" SW_HIDE
!macroend
