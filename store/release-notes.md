## Install

| | |
|---|---|
| **Windows** | Download **`YDM-Setup-{version}.exe`**, run it, tick Firefox and/or Chrome. No administrator rights; uninstall from *Settings → Apps*. |
| **Firefox** (140+) | Open **`ydm-{version}-firefox.xpi`** in Firefox and click *Add*. Signed by Mozilla; **updates itself**. |
| **Chrome, Edge, Brave** | Unzip **`ydm-{version}-chrome.zip`**, open `chrome://extensions`, turn on *Developer mode*, click *Load unpacked*, choose the folder. Chrome cannot update it by itself: YDM's popup tells you when a new version is out. |

## What YDM does

**Faster**
- Takes over large downloads (5 MB and up) and fetches them in **parallel pieces**: several times faster on sites that limit each connection (24 MB: 3.4 s instead of 12.2 s in our tests).
- **Adaptive connections**: starts with four, adds more only while the speed keeps rising.
- Shares the browser's **six connections per site** among its downloads instead of queueing behind itself; remembers sites that refuse more.
- No slow piece at the end: idle connections help the piece that will finish last.

**Reliable**
- **Never loses a download**: if a site refuses YDM, the browser downloads the file as usual, and YDM says why.
- **Resumes after the browser is closed**, fetching only the missing pieces, and only if the file on the server is still the same.
- Pause, resume, retry; speed limit for all downloads together.

**Safe**
- Saved through the browser's own download manager: Mark-of-the-Web and the browser's checks apply.
- Programs (`.exe`, `.msi`…) are left to the browser by default, so Safe Browsing also checks where they come from.
- **SHA-256** of every finished file, with a box to compare it with the one the site publishes.
- Incognito downloads never go through YDM. No account, no analytics, no servers.

**Handy**
- **Downloads page**: history, search, filters, details of each download.
- **Paste links** to download them; **download all links of a page**, filtered by type.
- Right-click any link → *Download with YDM*; a notification when a download finishes.
- English and Italian built in; in Chrome any other language is translated on your device by the browser itself.

Good to know: the extra speed comes from servers that limit each connection. On HTTP/2 servers (many big CDNs) YDM is as fast as the browser, not faster.

---

## Installazione (italiano)

- **Windows**: scarica **`YDM-Setup-{version}.exe`**, avvialo e scegli Firefox e/o Chrome. Non servono permessi di amministratore.
- **Firefox**: apri **`ydm-{version}-firefox.xpi`** in Firefox e clicca *Aggiungi*. Si aggiorna da solo.
- **Chrome, Edge, Brave**: estrai **`ydm-{version}-chrome.zip`**, apri `chrome://extensions`, attiva *Modalità sviluppatore*, clicca *Carica estensione non pacchettizzata* e scegli la cartella.

**Cosa fa:** download a pezzi paralleli, molto più veloci sui siti che limitano ogni connessione · connessioni adattive · non perde mai un download (se un sito rifiuta YDM, scarica il browser) · riprende dopo la chiusura del browser · pausa, riprendi, limite di velocità · SHA-256 di ogni file · pagina Download con ricerca e filtri · incolla link o scarica tutti i link di una pagina · notifica a fine download · nessun account, nessuna statistica.
