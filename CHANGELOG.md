# Änderungen

Die App holt Updates über die Veröffentlichungen auf GitHub (Zahnrad › Nach Updates suchen). Jede Veröffentlichung hat hier einen Abschnitt; die Aufzählungspunkte erscheinen in der App.

## v1.0.0 · 4. November 2026

Erste Veröffentlichung des EdgeBird-Lab Music Generators: aus der Web-Oberfläche „music-generator“ (ALPHATESTER, MIT) wurde ein komplettes lokales Musikstudio.

- **Songtexter:** schreibt Songtexte mit einem lokalen Ollama-Modell. Über 100 Genres mit eigenen Schreibregeln, Stimmung, Aufbau per Drag-and-drop, Perspektive, Reimschema, Überarbeiten und Abschnitte neu schreiben. Zwei Reiter: **Normal** (jugendfrei, jedes installierte Modell) und **Ohne Filter** (unzensierte Modelle, vier Härtegrade). Das Modell ist oben frei wählbar und wird je Betriebsart gemerkt.
- **Studio:** Mehrspur-Editor im Browser mit Schneiden, Raster am gemessenen Tempo, Schleife, Effekten je Spur (EQ, Kompressor, Hall, Echo im Takt), Mikrofonaufnahme mit Latenzausgleich und Export in die Bibliothek. **Gesang und Beat trennen** (Demucs), **Neue Stimme** (Text über einen vorhandenen Beat singen lassen, taktgenau angelegt), **Meine Stimme** (eigenes Stimm-Modell mit Applio trainieren und Gesang darin umwandeln).
- **Übersichts- und Suchleiste im Studio:** der ganze Song in einer Zeile unter den Spuren. Klicken oder Ziehen springt an die Stelle, auch während der Wiedergabe. Pfeiltasten 1 s, mit Umschalt 10 s, Ende springt ans Ende.
- **Stimme verwenden:** die Klangfarbe eines fertigen Songs für neue Songs übernehmen (Knopf an jedem Song mit Gesang).
- **Automatische Lyrics** über ein Ollama-Modell (Zahnrad › Texter), wenn das Lyrics-Feld leer bleibt; sonst erfindet das ACE-Step-Sprachmodell den Text.
- **Klangmodell XL BF16** (volle Genauigkeit, 10 GB) zusätzlich zu Standard und XL.
- **Linux-Installer `install.sh`** für Ubuntu, Debian, Linux Mint, Arch-Derivate, Fedora und openSUSE: erkennt Grafikkarte, Grafikspeicher und Arbeitsspeicher, wählt Backend (Vulkan, CUDA, ROCm, CPU), ACE-Step-Sprachmodell, Klangmodelle und die Ollama-Textmodelle passend dazu, baut den Modellserver, lädt die Modelle mit Prüfsummen, richtet Ollama und die Spurtrennung ein, auf Wunsch Meine Stimme (`--full`). Ein-Zeilen-Einstieg mit `bootstrap.sh`, Startbefehl `musik`, Menüeintrag.
- **Update in der App** holt die neueste Veröffentlichung dieses Repositorys (GitHub-Release) und zeigt die installierte Version in den Einstellungen.
- **Neues Design:** moderne, ruhige Konsolen-Optik in Dunkel mit einem kühlen Akzent, Monospace-Anzeigen für Zeiten und Werte, dichtere Bibliothek, zweispaltige Einstellungen, ruhigere Leisten im Studio.
- **Vulkan auf AMD (RADV):** Cooperative Matrix für den Modellserver abgeschaltet (sonst liefert das Sprachmodell Unsinn, gemessen auf einer RX 7900 XTX mit Mesa 26).
- Herkunft und Links auf EdgeBird-Lab umgestellt; Engine-Programmdateien für Mac und Windows liegen als Vorabreleases in diesem Repository.
