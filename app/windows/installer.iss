; Carino for Windows installer (Inno Setup). Built by .github/workflows/desktop.yml:
;   ISCC /DAppVersion=1.7.1 /DSourceDir=<flutter Release folder> installer.iss
; Installs for the current user only (no admin prompt). Carino's data stays in
; %LOCALAPPDATA%\app.carino.desktop, the same place as the earlier Windows app, so it carries over.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\build\windows\x64\runner\Release"
#endif

[Setup]
AppId={{8C2F4B61-7A4E-4C6B-9E2D-CA51F0A7B3D9}
AppName=Carino
AppVersion={#AppVersion}
AppPublisher=Carino
DefaultDirName={localappdata}\Programs\Carino
DefaultGroupName=Carino
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputBaseFilename=Carino-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\Carino.exe
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Carino"; Filename: "{app}\Carino.exe"
Name: "{userdesktop}\Carino"; Filename: "{app}\Carino.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Carino.exe"; Description: "Open Carino"; Flags: nowait postinstall skipifsilent
; After a quiet self-update, Carino opens again by itself.
Filename: "{app}\Carino.exe"; Flags: nowait; Check: WizardSilent
