; Cluera AI: fixed per-user install path; no arbitrary /D or machine-wide install.
; Legacy registry/uninstaller/product paths are never used.
!macro accountValidateInstall
  SetShellVarContext current
  StrCpy $R2 "$LOCALAPPDATA\Programs\Cluera AI"
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/allusers" $R1
  ${IfNot} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "Cluera AI installs for the current user only."
    Quit
  ${EndIf}
  ${If} ${UAC_IsInnerInstance}
    Quit
  ${EndIf}
  ReadRegStr $R1 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R1 != ""
    MessageBox MB_OK|MB_ICONSTOP "A machine-wide Cluera installation was found. Please uninstall it first."
    Quit
  ${EndIf}
  ReadRegStr $R1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R1 != ""
  ${AndIf} $R1 != $R2
    MessageBox MB_OK|MB_ICONSTOP "Cluera AI is registered in a different folder. Please uninstall it first."
    Quit
  ${EndIf}
  !insertmacro GetDParameter $R0
  ; The command line can carry a trailing space, quote or backslash after the folder; ignore those.
  ${Do}
    StrCpy $R9 $R0 1 -1
    ${If} $R9 == " "
    ${OrIf} $R9 == "$\""
    ${OrIf} $R9 == "\"
      StrCpy $R0 $R0 -1
    ${Else}
      ${Break}
    ${EndIf}
  ${Loop}
  ${If} $R0 != ""
  ${AndIf} $R0 != $R2
    MessageBox MB_OK|MB_ICONSTOP "Cluera AI can only be installed in its default folder."
    Quit
  ${EndIf}
  ${If} ${isUpdated}
    ${If} $R1 != $R2
    ${OrIf} $R0 != $R2
      MessageBox MB_OK|MB_ICONSTOP "This update needs an existing Cluera AI installation."
      Quit
    ${EndIf}
  ${EndIf}
  ; Refuse an existing non-account directory, including a copied legacy app.
  IfFileExists "$R2\SigmaRound AI.exe" 0 +3
    MessageBox MB_OK|MB_ICONSTOP "An old application was found in the Cluera AI folder. Nothing was installed."
    Quit
  IfFileExists "$R2\SigmaRound Account.exe" 0 +3
    MessageBox MB_OK|MB_ICONSTOP "An older Cluera application was found in this folder. Nothing was installed."
    Quit
  ; A leftover Cluera AI folder (for example from an earlier or interrupted install) is fine:
  ; it is this app's own folder, so the installer simply installs over it.
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $isForceCurrentInstall "1"
  StrCpy $installMode "CurrentUser"
  StrCpy $INSTDIR $R2
!macroend

!macro customInit
  !insertmacro accountValidateInstall
!macroend

; Recheck after the assisted mode page has run its own path calculation.
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_PRE accountFinalInstallCheck
  Function accountFinalInstallCheck
    !insertmacro accountValidateInstall
  FunctionEnd
!macroend

!macro customInstallMode
!ifndef BUILD_UNINSTALLER
  !insertmacro accountValidateInstall
!endif
  StrCpy $isForceCurrentInstall "1"
!macroend
