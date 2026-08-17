# Pulse Directory Watcher

Pulse è un’app desktop Electron per monitorare progetti Git, selezionare file da committare e gestire il flusso Git con l’aiuto di Ollama.

## Funzionalità principali

- Monitoraggio in tempo reale delle directory tramite `fs.watch`.
- Elenco delle modifiche Git organizzato in una struttura ad albero.
- Checkbox sui file e checkbox a tre stati sulle directory.
- Selezione globale dei file visibili nell’intestazione della tabella.
- Selezione persistente durante gli aggiornamenti del watcher.
- Gestione di più progetti recenti, con rimozione tramite conferma.
- Pulsanti `Pull` e `Push` per il repository attivo.
- Indicazione dei commit locali non ancora pubblicati e CTA `Push` nello stato pulito.
- Impostazioni Ollama con endpoint, modello e lingua del messaggio persistenti.
- Caricamento dei modelli disponibili tramite `/api/tags`.
- Generazione di messaggi Conventional Commit usando la diff dei soli file selezionati.
- Modifica del messaggio generato prima del commit.
- Commit dei soli file selezionati con `git add` e `git commit`.
- Aggiornamento automatico della lista dopo commit, pull e push.
- Modali per errori completi e retry della generazione AI.
- Persistenza di posizione, dimensione e stato massimizzato della finestra.
- Tema desktop scuro antracite.

## Avvio in sviluppo

```bash
npm install
npm run dev
```

## Build web

```bash
npm run build
```

## Build desktop Windows

```bash
npm run dist:desktop
```

L’installer viene generato nella directory `release`.

## Ollama

L’endpoint predefinito è `http://localhost:11434`. Aprire `File → Settings…`, configurare l’endpoint, caricare i modelli e selezionare quello da usare per la generazione dei messaggi.

## Note tecniche

Il processo principale Electron gestisce filesystem, Git, Ollama e IPC. Il renderer React non accede direttamente al filesystem o ai processi di sistema; comunica tramite API esposte dal preload con `contextBridge`.
