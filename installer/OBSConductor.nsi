; OBS Conductor - Windows installer (NSIS 3), built on a Mac by
; build_windows.command (makensis -DVERSION=... -DSRCDIR=... -DOUTFILE=...).
; Replaces the Inno Setup installer of 1.x (Inno Setup only builds on Windows).
;
; What the installer does, in order:
;  1. stops a running OBS Conductor, copies the app into Program Files
;     (an install made by the 1.x installer is taken over: same folder,
;     its uninstall entry is replaced by this one);
;  2. options: start with Windows, firewall rules for master / slave;
;  3. starts the app in the background, as the user (not as administrator).
;     The app adds its dock to OBS by itself the first time OBS is closed
;     (app/src/main.js, obs-setup.js): no need to close OBS here;
;  4. keeps a copy of itself in <app>\update: a master hands it to its
;     slaves (their "Update" button, app/src/update.js).
; Started by a slave's "Update" (/S /UPDATE=1, or the 1.x flags /VERYSILENT
; /UPDATE=1): no question, the app starts again by itself.
; Uninstalling removes the dock from OBS (OBS closed), the startup entry and
; the firewall rules. Playlists and settings (%LOCALAPPDATA%\OBSConductor)
; are kept.
; Unsigned: Windows SmartScreen shows "Windows protected your PC" on first
; run. Click "More info" -> "Run anyway".

Unicode true
ManifestDPIAware true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "Sections.nsh"
!include "x64.nsh"

!ifndef VERSION
  !error "VERSION missing: build with build_windows.command"
!endif
!ifndef SRCDIR
  !error "SRCDIR missing: build with build_windows.command"
!endif
!ifndef OUTFILE
  !define OUTFILE "OBSConductor-Setup-${VERSION}.exe"
!endif

!define APPNAME "OBS Conductor"
!define EXE "OBSConductor.exe"
!define VBS "OBSConductor.vbs"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\OBSConductor"
!define INNO_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\{6C4B7C0E-6E8A-4C1E-9C1B-7E8B7E7A9F10}_is1"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\${APPNAME}"
InstallDirRegKey HKLM "${UNINST_KEY}" "InstallLocation"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
BrandingText "${APPNAME} ${VERSION}"
ShowInstDetails nevershow
ShowUninstDetails nevershow

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "${APPNAME}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileDescription" "${APPNAME} installer"
VIAddVersionKey /LANG=1033 "CompanyName" "just edit lab"
VIAddVersionKey /LANG=1033 "LegalCopyright" "GPL-3.0-or-later"

!define MUI_ICON "${SRCDIR}\app\src\icons\app.ico"
!define MUI_UNICON "${SRCDIR}\app\src\icons\app.ico"
!define MUI_ABORTWARNING
!define MUI_COMPONENTSPAGE_NODESC
!define MUI_FINISHPAGE_TEXT "$(DoneText)"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "$(LaunchNow)"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp

!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "French"

LangString SecApp ${LANG_ENGLISH} "OBS Conductor"
LangString SecApp ${LANG_FRENCH} "OBS Conductor"
LangString SecStartup ${LANG_ENGLISH} "Start OBS Conductor with Windows"
LangString SecStartup ${LANG_FRENCH} "Lancer OBS Conductor au démarrage de Windows"
LangString SecFirewall ${LANG_ENGLISH} "Allow the other PCs of the network (master / slave)"
LangString SecFirewall ${LANG_FRENCH} "Autoriser les autres PC du réseau (maître / esclave)"
LangString LaunchNow ${LANG_ENGLISH} "Start OBS Conductor now"
LangString LaunchNow ${LANG_FRENCH} "Lancer OBS Conductor maintenant"
LangString DoneText ${LANG_ENGLISH} "OBS Conductor is installed.$\r$\n$\r$\nThe dock is added to OBS the first time OBS is closed while the app runs. Then, in OBS: Docks > OBS Conductor."
LangString DoneText ${LANG_FRENCH} "OBS Conductor est installé.$\r$\n$\r$\nLe dock est ajouté à OBS la première fois qu'OBS est fermé pendant que l'appli tourne. Ensuite, dans OBS : Docks > OBS Conductor."
LangString UninstCloseObs ${LANG_ENGLISH} "Close OBS to remove the dock, then click Retry."
LangString UninstCloseObs ${LANG_FRENCH} "Fermez OBS pour retirer le dock, puis cliquez sur Réessayer."
LangString NeedX64 ${LANG_ENGLISH} "OBS Conductor needs 64-bit Windows."
LangString NeedX64 ${LANG_FRENCH} "OBS Conductor demande Windows 64 bits."

Var IsUpdate

; ---------------------------------------------------------------------------


Function StopApp
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM ${EXE}'
  Pop $0
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM OBSPlaylist.exe'
  Pop $0
  Sleep 500
FunctionEnd

; Starts the app as the user who is logged in, not as administrator: the
; Windows shell (explorer, not elevated) opens the launcher.
Function LaunchApp
  Exec '"$WINDIR\explorer.exe" "$INSTDIR\${VBS}"'
FunctionEnd

Section "$(SecApp)" SecApp
  SectionIn RO
  SetRegView 64
  SetShellVarContext all
  Call StopApp

  ; the 1.x installer's leftovers: its uninstaller and its entry
  ${If} ${FileExists} "$INSTDIR\unins000.exe"
    Delete "$INSTDIR\unins000.exe"
    Delete "$INSTDIR\unins000.dat"
    Delete "$INSTDIR\unins000.msg"
  ${EndIf}
  DeleteRegKey HKLM "${INNO_KEY}"
  ; previous copy of the app's sources (removed files must not linger)
  RMDir /r "$INSTDIR\app"
  ; the app under its former names
  Delete "$INSTDIR\OBSPlaylist.exe"
  Delete "$INSTDIR\OBSPlaylist.vbs"
  Delete "$INSTDIR\OBSPlaylist.cmd"
  RMDir /r "$SMPROGRAMS\OBS Playlist"

  SetOutPath "$INSTDIR"
  File /r "${SRCDIR}\*.*"

  ; a copy of this installer, for the slaves of this PC (master)
  CreateDirectory "$INSTDIR\update"
  CopyFiles /SILENT "$EXEPATH" "$INSTDIR\update\OBSConductor-Setup.exe"

  ; Start menu
  RMDir /r "$SMPROGRAMS\${APPNAME}"
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortCut "$SMPROGRAMS\${APPNAME}\OBS Conductor.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\${VBS}"' "$INSTDIR\app\src\icons\app.ico"
  CreateShortCut "$SMPROGRAMS\${APPNAME}\Stop OBS Conductor.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\${VBS}" /stop' "$INSTDIR\app\src\icons\app.ico"
  CreateShortCut "$SMPROGRAMS\${APPNAME}\Add the dock to OBS.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\${VBS}" /adddock' "$INSTDIR\app\src\icons\app.ico"
  CreateShortCut "$SMPROGRAMS\${APPNAME}\OBS Conductor log.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\${VBS}" /log' "$INSTDIR\app\src\icons\app.ico"
  CreateShortCut "$SMPROGRAMS\${APPNAME}\OBS Conductor (simulation, no OBS).lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\${VBS}" --simulate' "$INSTDIR\app\src\icons\app.ico"
  CreateShortCut "$SMPROGRAMS\${APPNAME}\Uninstall OBS Conductor.lnk" "$INSTDIR\uninstall.exe"

  ; startup entries and firewall rules left under the former names
  nsExec::Exec '"$SYSDIR\schtasks.exe" /Delete /TN "OBS Scheduler" /F'
  Pop $0
  nsExec::Exec '"$SYSDIR\schtasks.exe" /Delete /TN "OBS Playlist" /F'
  Pop $0
  DeleteRegValue HKCU "${RUN_KEY}" "OBS Playlist"
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="OBS Playlist"'
  Pop $0
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="OBS Playlist - OBS WebSocket"'
  Pop $0
  ; options: set again below when chosen
  DeleteRegValue HKCU "${RUN_KEY}" "OBS Conductor"
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="OBS Conductor"'
  Pop $0
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="OBS Conductor - OBS WebSocket"'
  Pop $0

  ; uninstall entry
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "just edit lab"
  WriteRegStr HKLM "${UNINST_KEY}" "URLInfoAbout" "https://github.com/noar-justedit/obs-conductor"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\app\src\icons\app.ico"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${UNINST_KEY}" "EstimatedSize" "$0"
  WriteRegStr HKLM "${UNINST_KEY}" "OptStartup" "0"
  WriteRegStr HKLM "${UNINST_KEY}" "OptFirewall" "0"
SectionEnd

; start with Windows: Run key of the user who installs (no admin rights at logon)
Section "$(SecStartup)" SecStartup
  WriteRegStr HKCU "${RUN_KEY}" "OBS Conductor" '"$SYSDIR\wscript.exe" "$INSTDIR\${VBS}"'
  WriteRegStr HKLM "${UNINST_KEY}" "OptStartup" "1"
SectionEnd

; firewall: the app (dock + API for the slaves) and OBS's WebSocket (4455),
; only from the PCs of the same local network (remoteip=localsubnet): a
; master's slaves are always there; nothing from further away (review 1.6.0)
Section "$(SecFirewall)" SecFirewall
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="OBS Conductor" dir=in action=allow program="$INSTDIR\${EXE}" protocol=TCP remoteip=localsubnet enable=yes profile=private,domain'
  Pop $0
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="OBS Conductor - OBS WebSocket" dir=in action=allow protocol=TCP localport=4455 remoteip=localsubnet enable=yes profile=private,domain'
  Pop $0
  WriteRegStr HKLM "${UNINST_KEY}" "OptFirewall" "1"
SectionEnd

; update from the master: start the app again, no question
Section "-restart after an update"
  ${If} $IsUpdate == "1"
    Call LaunchApp
  ${EndIf}
SectionEnd

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "$(NeedX64)"
    Abort
  ${EndIf}
  SetRegView 64
  SetShellVarContext all
  ; started by a slave's Update: /UPDATE=1 (the 1.x apps also pass /VERYSILENT)
  StrCpy $IsUpdate "0"
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/UPDATE=" $1
  ${IfNot} ${Errors}
    StrCpy $IsUpdate $1
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "/VERYSILENT" $1
  ${IfNot} ${Errors}
    SetSilent silent
  ${EndIf}
  ; an install of the 1.x installer (Inno Setup): same folder
  ReadRegStr $1 HKLM "${INNO_KEY}" "InstallLocation"
  ${If} $1 != ""
    StrCpy $INSTDIR $1
  ${EndIf}
  ; options chosen at the previous install (kept by an update)
  ReadRegStr $1 HKLM "${UNINST_KEY}" "OptStartup"
  ${If} $1 == "0"
    !insertmacro UnselectSection ${SecStartup}
  ${EndIf}
  ReadRegStr $1 HKLM "${UNINST_KEY}" "OptFirewall"
  ${If} $1 == "0"
    !insertmacro UnselectSection ${SecFirewall}
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------

Function un.onInit
  SetRegView 64
  SetShellVarContext all
FunctionEnd

Section "Uninstall"
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM ${EXE}'
  Pop $0
  Sleep 500
  ; the dock out of OBS (OBS closed: it rewrites its settings when it quits)
  retry:
  ExecWait '"$INSTDIR\${EXE}" "$INSTDIR\app\src\obs-setup.js" uninstall' $0
  ${If} $0 == 3
  ${AndIfNot} ${Silent}
    MessageBox MB_RETRYCANCEL|MB_ICONINFORMATION "$(UninstCloseObs)" IDRETRY retry
  ${EndIf}
  DeleteRegValue HKCU "${RUN_KEY}" "OBS Conductor"
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="OBS Conductor"'
  Pop $0
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="OBS Conductor - OBS WebSocket"'
  Pop $0
  RMDir /r "$SMPROGRAMS\${APPNAME}"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\update"
  Delete "$INSTDIR\${EXE}"
  Delete "$INSTDIR\${VBS}"
  Delete "$INSTDIR\OBSConductor.cmd"
  Delete "$INSTDIR\NODE-LICENSE.txt"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "${UNINST_KEY}"
  ; Deliberately NOT deleting %LOCALAPPDATA%\OBSConductor - keeps playlists
  ; and settings across an uninstall / reinstall.
SectionEnd
