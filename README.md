# YDM — Yamantau Download Manager

Download più veloci e sicuri, dentro il browser. Si installa come una qualsiasi
estensione e funziona subito: niente programmi da installare, niente finestre.

```
Browser
 ├─ background        intercetta i download, coda, badge, menu, popup
 ├─ motore            offscreen document (Chrome/Edge/Brave) · background page (Firefox)
 │    └─ un Web Worker per download
 │         ├─ N richieste parallele con Range, work-stealing tra connessioni
 │         └─ scritture sincrone e posizionali su OPFS (su disco, non in RAM)
 └─ alla fine il browser salva il file in Download, come un suo download
```

## Cosa fa

- **Prende i download grandi** (≥ 5 MB, http/https) e li scarica a segmenti paralleli.
  Il resto lo lascia al browser: file piccoli, dimensione sconosciuta, incognito,
  risultati di un modulo POST (YDM li rifarebbe come GET).
- **Non perde mai un download**: se YDM viene rifiutato o fallisce, il download torna
  al downloader del browser, e il popup dice perché (es. «il sito non accetta download
  esterni (403)», «spazio su disco insufficiente»).
- **Siti con protezione anti-hotlink**: YDM manda il Referer della pagina, come il
  browser (solo l'origine verso altri siti), tramite una regola di rete limitata alle
  sue richieste e ai domini del download.
- **Riprende dopo la chiusura del browser**: ogni 3 secondi YDM salva a che punto è;
  alla riapertura riscarica solo i pezzi mancanti, e solo se il server ha ancora lo
  stesso identico file (stesso ETag o data di modifica e stessa dimensione), altrimenti
  ricomincia da zero.
- **Confronto immediato**: a download finito il popup mostra tempo e velocità media.
- **Impostazioni** (icona nel popup): attivo/spento, dimensione minima, connessioni per
  download (1–8), download contemporanei (1–6), siti esclusi, e **«Lascia al browser i
  programmi»** (attiva di serie): `.exe`, `.msi`, `.bat` e simili li scarica il browser,
  così Safe Browsing controlla anche il sito di provenienza. Spenta, anche i programmi
  vanno veloci.
- **Barra a segmenti**: nel popup si vede ogni connessione riempire il suo pezzo di file.
- **Pausa, Riprendi, Riprova** nel popup: la pausa tiene su disco quello già scaricato.
- **Limite di velocità** (impostazioni), diviso tra i download in corso e applicato subito.
- **Avvio senza richiesta di prova**: la prima connessione chiede il file da 0 in poi e fa
  da sonda (dimensione, range, ETag); il suo flusso diventa il primo segmento. Una richiesta
  e un viaggio di rete in meno per download; sotto i 16 MB basta una richiesta sola.
- **Menu contestuale** «Scarica con YDM» su qualsiasi link.
- **Popup** con avanzamento, velocità, tempo rimanente, annulla, mostra nella cartella;
  un interruttore per spegnerlo. Badge con i download attivi.

## Come scarica

1. **Probe** — `GET` con `Range: bytes=0-0`: dimensione, supporto ai range, ETag, nome.
2. **Segmenti** — 4 connessioni (oltre, i mirror pubblici rispondono 429 o bloccano l'IP).
   Una connessione che finisce prende metà del segmento più grande rimasto.
3. **Connessioni rifiutate** — dopo due errori di fila una connessione si ritira e lascia
   il lavoro alle altre; il download fallisce solo se falliscono tutte.
4. **Scrittura** — ogni pezzo va subito al suo posto nel file OPFS: la RAM non dipende
   dalla dimensione del file.
5. **Salvataggio** — il browser copia il file in Download: sceglie il nome finale,
   applica Mark-of-the-Web e Safe Browsing come per ogni suo download.

Sicurezza: i cookie li mette il browser, per sito, come nei suoi download (nessun
cookie può finire a un altro sito); `If-Range` impedisce di unire versioni diverse del
file; i nomi dal server vengono ripuliti (cartelle, nomi riservati Windows, caratteri
bidi che nascondono l'estensione) e mostrati solo come testo; i download in incognito
non passano mai da YDM.

### Il limite da sapere

La velocità extra c'è quando il server limita la banda **per connessione**. Con i
server HTTP/2 (molte CDN) il browser fa passare tutte le richieste parallele su una sola
connessione e un'estensione non può cambiarlo: lì YDM va come il browser, non più piano.
Inoltre il file viene scritto due volte (OPFS, poi Download): su file molto grandi la
copia finale richiede qualche secondo in più.

Mark-of-the-Web: verificato in Chromium e Firefox (`ZoneId=3`, il file risulta da
Internet), ma in Chrome l'origine registrata è l'estensione (`HostUrl=chrome-extension://…`)
e non il sito: il browser salva un blob dell'estensione e l'API non permette di indicare
la sorgente. Per lo stesso motivo il controllo Safe Browsing sull'indirizzo del sito
potrebbe non scattare (resta quello sul contenuto degli eseguibili): da verificare a mano
in Chrome con testsafebrowsing.appspot.com.

### Misure (test end-to-end)

24 MB con limite di 2 MB/s per connessione, da un sito che richiede il login,
file identico byte per byte:

| | browser da solo | YDM |
|---|---|---|
| Chromium | 12,2 s | 3,2 s |
| Firefox | 12,7 s | 3,1 s |

## Sviluppo (`extension/`)

```sh
npm install
npm run dev            # sviluppo: carica una volta .output/chrome-mv3-dev nel tuo Chrome,
                       # poi si ricarica da sola a ogni modifica (finché il comando è attivo)
npm run dev:firefox    # uguale per Firefox: .output/firefox-mv2-dev da about:debugging
npm test               # unit test (vitest)
npm run e2e            # build + test in Chromium reale (Playwright)
npm run e2e:firefox    # build + test in Firefox reale (web-ext): download e ripresa dopo la chiusura
npm run check          # type check
npm run build          # .output/chrome-mv3   ·   npm run build:firefox
```

I test end-to-end usano il server di test in Rust (`engine/crates/ydm-testserver`):
range, limite per connessione, cookie obbligatorio, server che rifiutano i range.
Compilarlo una volta con `cargo build --release -p ydm-testserver` dentro `engine/`.

## Installazione permanente

- **Chrome / Edge / Brave**: `npm run release`, poi «Carica estensione non pacchettizzata»
  sulla cartella `release/chrome` (modalità sviluppatore). Resta installata.
- **Firefox**: le versioni normali tengono solo estensioni firmate da Mozilla. Con un account
  gratuito su addons.mozilla.org e le sue chiavi API, `scripts/installa-firefox.ps1` firma
  (canale «unlisted», non pubblica) e apre l'installazione. Ogni firma vuole una versione nuova
  in `package.json`.

## Stato

| | |
|---|---|
| Motore nell'estensione, coda, popup, menu, fallback al browser | ✅ testato in Chromium |
| Firefox | ✅ testato in Firefox (download, cookie, velocità, cartella Download) |
| Ripresa dopo chiusura del browser | ✅ testato in Chromium e Firefox (riscaricata solo la parte mancante) |
| Impostazioni, programmi al browser, siti esclusi | ✅ testato in Chromium |
| Connessioni adattive per server | da fare |
| Pubblicazione su Chrome Web Store, Edge Add-ons, AMO | da fare |
