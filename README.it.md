# YDM — Yamantau Download Manager

Download più veloci e sicuri, dentro il browser. Si installa come una qualsiasi
estensione e funziona subito: niente programmi da installare, niente finestre.

**[Read in English](README.md)** · [Privacy](PRIVACY.md) · [Contribuire](CONTRIBUTING.md)

## Cosa fa

- **Prende i download grandi** (da 5 MB in su, http/https) e li scarica a pezzi paralleli.
  Il resto lo lascia al browser: file piccoli, dimensione sconosciuta, incognito, risultati
  di un modulo POST.
- **Connessioni adattive**: parte con quattro e ne aggiunge solo finché la velocità cresce;
  se un sito ne rifiuta altre, se lo ricorda per una settimana.
- **Rispetta il limite del browser**: i browser aprono al massimo sei connessioni per sito.
  YDM le divide tra i suoi download da quel sito invece di mettersi in coda da solo.
- **Niente pezzo lento alla fine**: una connessione libera aiuta il pezzo che finirà per
  ultimo, e una connessione molto più lenta delle altre riparte.
- **Non perde mai un download**: se un sito rifiuta YDM, il download torna al browser e il
  popup dice perché.
- **Riprende dopo la chiusura del browser**, riscaricando solo i pezzi mancanti, e solo se
  il server ha ancora lo stesso identico file.
- **Pagina Download**: cronologia, ricerca, filtri, dettagli e **SHA-256** di ogni file, con
  un campo per confrontarlo con quello pubblicato dal sito.
- **Aggiungi URL** (incollane uno o tanti) e **scarica tutti i link di una pagina**, per tipo.
- **Notifica** a fine download, con il pulsante per mostrare il file.
- **Impostazioni**: attivo/spento, dimensione minima, connessioni massime (1–6), download
  contemporanei, limite di velocità, siti esclusi e **«Lascia al browser i programmi»**.
- **La tua lingua**: inglese e italiano sono inclusi. In Chrome qualsiasi altra lingua la
  traduce **il traduttore integrato del browser, sul tuo dispositivo** (nessun server,
  nessun account): YDM lo propone una volta e conserva il risultato.

### Il limite da sapere

La velocità extra c'è quando il server limita la banda **per connessione**. Con i server
HTTP/2 (molte CDN) il browser fa passare tutte le richieste su una connessione sola e
un'estensione non può cambiarlo: lì YDM va come il browser, non più piano. Il file viene
scritto due volte (OPFS, poi Download): sui file molto grandi la copia finale richiede
qualche secondo in più.

### Misure (test end-to-end)

24 MB da un sito limitato a 2 MB/s per connessione, con login, file identico:

| | browser da solo | YDM |
|---|---|---|
| Chromium | 12,2 s | 3,4 s |
| Firefox | 12,7 s | 3,1 s |

Sviluppo, test e pubblicazione: vedi il [README in inglese](README.md#development-extension).
