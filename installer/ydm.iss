; YDM installer for Windows (Inno Setup 6).
;
; Lets the user pick Firefox and/or Chrome:
;   Firefox  the Mozilla-signed .xpi is opened in Firefox, which asks to add
;            it ("Add"); it then updates itself from GitHub.
;   Chrome   Chrome on Windows refuses extensions installed by a program, so
;            the unpacked folder is copied to %LOCALAPPDATA%\YDM\chrome and
;            Chrome's extensions page is opened with the three steps shown
;            (Developer mode, Load unpacked, pick the folder).
;
; No administrator rights: everything goes into the user's own folders.
;
; Built by .github/workflows/release.yml, or locally:
;   ISCC.exe /DVersion=1.0.0 /DPayload=..\installer\payload installer\ydm.iss
; with payload\ydm-firefox.xpi and payload\chrome\ (the unpacked build).

#ifndef Version
  #define Version "0.0.0"
#endif
#ifndef Payload
  #define Payload "payload"
#endif
#ifndef Repo
  #define Repo "mrdragon1-code/ydm"
#endif

[Setup]
AppId={{6F1D2A4E-6C0B-4B8E-9A43-5D0B1E7C9A21}
AppName=YDM
AppVersion={#Version}
AppVerName=YDM {#Version}
AppPublisher=Nicov99
AppPublisherURL=https://github.com/{#Repo}
AppSupportURL=https://github.com/{#Repo}/issues
AppUpdatesURL=https://github.com/{#Repo}/releases
DefaultDirName={localappdata}\YDM
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputBaseFilename=YDM-Setup-{#Version}
OutputDir=..\extension\.output
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupIconFile=ydm.ico
UninstallDisplayIcon={app}\ydm.ico
UninstallDisplayName=YDM {#Version}
LicenseFile=..\LICENSE
ShowLanguageDialog=auto
CloseApplications=no

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "it"; MessagesFile: "compiler:Languages\Italian.isl"

[CustomMessages]
en.BrowsersTitle=Browsers
en.BrowsersSubtitle=Install YDM in which browsers?
en.Firefox=Firefox (installs and updates itself)
en.Chrome=Chrome, Edge, Brave (three clicks in the browser, explained next)
en.NoFirefox=Firefox does not seem to be installed. You can still install YDM for it later from the Start menu.
en.NeedOne=Choose at least one browser.
en.FirefoxNext=Firefox will open and ask to add YDM: click "Add".
en.ChromeSteps=Chrome only accepts extensions from its store or loaded by hand. The extensions page will open: 1. turn on "Developer mode" (top right), 2. click "Load unpacked", 3. choose this folder (already copied to the clipboard):
en.OpenFirefox=Add YDM to Firefox
en.OpenChrome=Open Chrome's extensions page
en.ChromeUpdates=Chrome cannot update this copy by itself: YDM shows in its popup when a new version is out.
it.BrowsersTitle=Browser
it.BrowsersSubtitle=In quali browser installare YDM?
it.Firefox=Firefox (si installa e si aggiorna da solo)
it.Chrome=Chrome, Edge, Brave (tre clic nel browser, spiegati dopo)
it.NoFirefox=Firefox non sembra installato. Potrai installare YDM per Firefox anche dopo, dal menu Start.
it.NeedOne=Scegli almeno un browser.
it.FirefoxNext=Si aprirà Firefox e chiederà di aggiungere YDM: clicca "Aggiungi".
it.ChromeSteps=Chrome accetta solo estensioni dal suo negozio o caricate a mano. Si aprirà la pagina delle estensioni: 1. attiva "Modalità sviluppatore" (in alto a destra), 2. clicca "Carica estensione non pacchettizzata", 3. scegli questa cartella (già copiata negli appunti):
it.OpenFirefox=Aggiungi YDM a Firefox
it.OpenChrome=Apri la pagina delle estensioni di Chrome
it.ChromeUpdates=Chrome non può aggiornare da solo questa copia: YDM avvisa nel popup quando esce una nuova versione.

[Files]
Source: "ydm.ico"; DestDir: "{app}"
#ifndef NoFirefox
Source: "{#Payload}\ydm-firefox.xpi"; DestDir: "{app}"; Check: WantFirefox
#endif
Source: "{#Payload}\chrome\*"; DestDir: "{app}\chrome"; Flags: recursesubdirs createallsubdirs ignoreversion; Check: WantChrome

[Icons]
Name: "{userprograms}\YDM\{cm:OpenFirefox}"; Filename: "{code:FirefoxExe}"; Parameters: """{app}\ydm-firefox.xpi"""; IconFilename: "{app}\ydm.ico"; Check: WantFirefox
Name: "{userprograms}\YDM\{cm:OpenChrome}"; Filename: "{app}\open-chrome.cmd"; IconFilename: "{app}\ydm.ico"; Check: WantChrome
Name: "{userprograms}\YDM\YDM on GitHub"; Filename: "https://github.com/{#Repo}"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\chrome"
Type: files; Name: "{app}\open-chrome.cmd"

[Code]
var
  BrowsersPage: TInputOptionWizardPage;

function FindFirefox(): String;
var
  Path: String;
begin
  Result := '';
  if RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe', '', Path) and FileExists(Path) then
    Result := Path
  else if RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe', '', Path) and FileExists(Path) then
    Result := Path
  else if FileExists(ExpandConstant('{commonpf64}\Mozilla Firefox\firefox.exe')) then
    Result := ExpandConstant('{commonpf64}\Mozilla Firefox\firefox.exe')
  else if FileExists(ExpandConstant('{commonpf32}\Mozilla Firefox\firefox.exe')) then
    Result := ExpandConstant('{commonpf32}\Mozilla Firefox\firefox.exe');
end;

function FindChromium(): String;
var
  Path: String;
begin
  Result := '';
  if RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe', '', Path) and FileExists(Path) then
    Result := Path
  else if RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe', '', Path) and FileExists(Path) then
    Result := Path
  else if RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe', '', Path) and FileExists(Path) then
    Result := Path;
end;

function FirefoxExe(Param: String): String;
begin
  Result := FindFirefox();
  if Result = '' then Result := 'firefox.exe';
end;

procedure InitializeWizard();
begin
  BrowsersPage := CreateInputOptionPage(wpLicense,
    CustomMessage('BrowsersTitle'), CustomMessage('BrowsersSubtitle'), '', False, False);
  BrowsersPage.Add(CustomMessage('Firefox'));
  BrowsersPage.Add(CustomMessage('Chrome'));
#ifdef NoFirefox
  { This build has no signed Firefox add-on: Chrome only. }
  BrowsersPage.CheckListBox.ItemEnabled[0] := False;
#endif
  BrowsersPage.Values[0] := FindFirefox() <> '';
  BrowsersPage.Values[1] := FindChromium() <> '';
  if not BrowsersPage.Values[0] and not BrowsersPage.Values[1] then BrowsersPage.Values[0] := True;
  { /BROWSERS=firefox,chrome picks them on the command line (silent installs). }
  if ExpandConstant('{param:BROWSERS|}') <> '' then
  begin
    BrowsersPage.Values[0] := Pos('firefox', Lowercase(ExpandConstant('{param:BROWSERS|}'))) > 0;
    BrowsersPage.Values[1] := Pos('chrome', Lowercase(ExpandConstant('{param:BROWSERS|}'))) > 0;
  end;
end;

function WantFirefox(): Boolean;
begin
#ifdef NoFirefox
  Result := False;
#else
  Result := BrowsersPage.Values[0];
#endif
end;

function WantChrome(): Boolean;
begin
  Result := BrowsersPage.Values[1];
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = BrowsersPage.ID then
  begin
    if not WantFirefox() and not WantChrome() then
    begin
      MsgBox(CustomMessage('NeedOne'), mbError, MB_OK);
      Result := False;
    end
    else if WantFirefox() and (FindFirefox() = '') and not WizardSilent() then
      MsgBox(CustomMessage('NoFirefox'), mbInformation, MB_OK);
  end;
end;

{ A small script for the Start menu entry: opens the extensions page and
  copies the folder to the clipboard, the same as at the end of setup. }
procedure WriteChromeHelper();
var
  Folder, Browser, Page: String;
begin
  Folder := ExpandConstant('{app}\chrome');
  Browser := FindChromium();
  Page := 'chrome://extensions';
  if Pos('msedge', Lowercase(Browser)) > 0 then Page := 'edge://extensions';
  if Browser = '' then Browser := 'chrome.exe';
  SaveStringToFile(ExpandConstant('{app}\open-chrome.cmd'),
    '@echo off' + #13#10 +
    'echo ' + Folder + '| clip' + #13#10 +
    'start "" "' + Browser + '" ' + Page + #13#10, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  Folder: String;
begin
  if CurStep <> ssPostInstall then Exit;
  if WantChrome() then WriteChromeHelper();
  { Silent installs (scripts, tests) only copy the files: no dialogs, no
    browser opening. The Start menu entries do the rest later. }
  if WizardSilent() then Exit;
  if WantFirefox() and (FindFirefox() <> '') then
  begin
    MsgBox(CustomMessage('FirefoxNext'), mbInformation, MB_OK);
    Exec(FindFirefox(), '"' + ExpandConstant('{app}\ydm-firefox.xpi') + '"', '', SW_SHOWNORMAL, ewNoWait, Code);
  end;
  if WantChrome() then
  begin
    Folder := ExpandConstant('{app}\chrome');
    MsgBox(CustomMessage('ChromeSteps') + #13#10#13#10 + Folder + #13#10#13#10 + CustomMessage('ChromeUpdates'), mbInformation, MB_OK);
    Exec(ExpandConstant('{cmd}'), '/c "' + ExpandConstant('{app}\open-chrome.cmd') + '"', '', SW_HIDE, ewNoWait, Code);
  end;
end;
