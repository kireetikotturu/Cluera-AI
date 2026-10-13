; Account TEST only. Fixed per-user path; no arbitrary /D or machine install.
; Legacy registry/uninstaller/product paths are never used.
!macro accountValidateInstall
  SetShellVarContext current
  StrCpy $R2 "$LOCALAPPDATA\Programs\Cluera AI"
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/allusers" $R1
  ${IfNot} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "Cluera AI TEST supports a separate per-user installation only."
    Quit
  ${EndIf}
  ${If} ${UAC_IsInnerInstance}
    Quit
  ${EndIf}
  ReadRegStr $R1 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R1 != ""
    MessageBox MB_OK|MB_ICONSTOP "A machine-wide Account installation needs a separately reviewed migration."
    Quit
  ${EndIf}
  ReadRegStr $R1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R1 != ""
  ${AndIf} $R1 != $R2
    MessageBox MB_OK|MB_ICONSTOP "The registered Account location is not the isolated TEST location."
    Quit
  ${EndIf}
  !insertmacro GetDParameter $R0
  ${If} $R0 != ""
  ${AndIf} $R0 != $R2
    MessageBox MB_OK|MB_ICONSTOP "The Account installer cannot target another application folder."
    Quit
  ${EndIf}
  ${If} ${isUpdated}
    ${If} $R1 != $R2
    ${OrIf} $R0 != $R2
      MessageBox MB_OK|MB_ICONSTOP "An Account upgrade requires its existing isolated installation."
      Quit
    ${EndIf}
  ${EndIf}
  ; Refuse an existing non-account directory, including a copied legacy app.
  IfFileExists "$R2\SigmaRound AI.exe" 0 +3
    MessageBox MB_OK|MB_ICONSTOP "A legacy application was found in the Account directory. Nothing was installed."
    Quit
  IfFileExists "$R2\SigmaRound Account.exe" 0 +3
    MessageBox MB_OK|MB_ICONSTOP "An existing Account application was found. Its files were preserved."
    Quit
  ${If} $R1 == ""
    IfFileExists "$R2\*.*" 0 +3
      MessageBox MB_OK|MB_ICONSTOP "The new Account directory must be empty. Existing files were preserved."
      Quit
  ${EndIf}
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
