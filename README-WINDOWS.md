# Music Generator für Windows

Gleiche App wie unter Linux und auf dem Mac, Modellserver läuft über CUDA auf der NVIDIA-Grafikkarte (AMD und Intel über Vulkan).
Der Installer lädt die fertigen Windows-Programmdateien von acestep.cpp in einer festen, geprüften Version (kein Compiler nötig).
Der Windows-Installer stammt aus dem Ursprungsprojekt und ist hier unverändert übernommen; Songtexter und Studio laufen damit, **Meine Stimme** (Applio) gibt es bisher nur unter Linux.
Für den Songtexter zusätzlich [Ollama](https://ollama.com) installieren und ein Modell laden, zum Beispiel `ollama pull gemma4:12b`.

## Installation

Voraussetzungen: Windows 10/11 (64 Bit), NVIDIA-Grafikkarte mit aktuellem Treiber,
mindestens 8 GB Arbeitsspeicher, 7–11 GB frei.

Die fertigen Binaries sind mit CUDA 13 gebaut. Laut Dateianalyse enthalten sie Code für RTX 20xx/GTX 16xx und neuer; ein Praxistest mit CUDA auf NVIDIA-Karten steht noch aus.
Karten ohne passenden Code (GTX 10xx, Pascal) laufen automatisch über Vulkan, das ist langsamer, aber es geht:
auf einer GTX 1060 (6 GB) dauert ein 30-Sekunden-Song etwa 1 Minute, ein 90-Sekunden-Song etwa 2,5 Minuten.
**AMD:** Laut einem Nutzerbericht läuft auch AMD-Grafik über Vulkan, zum Beispiel eine Radeon 780M (Mini-PC mit Ryzen 7 8745HS, 64 GB RAM, im BIOS 8 GB für die Grafik zugeteilt): Installation ohne Fehler, Standard-Klangmodell etwa 3 bis 5 Minuten pro Song, XL etwa 5 bis 8 Minuten. Ein zweiter Bericht nennt für eine Radeon 890M (Geekom A9 Max) ebenfalls 3 bis 5 Minuten mit dem Standard-Klangmodell. Einzelberichte, die Zeiten hängen stark vom Rechner ab.

1. Falls `git` fehlt: PowerShell öffnen und `winget install Git.Git` ausführen (oder der Installer macht es).
2. In der PowerShell:

```powershell
git clone https://github.com/edgebird-lab/music-generator.git $HOME\MusicGenerator
```

3. Im Ordner `MusicGenerator` die Datei **Windows-Install.bat** doppelklicken.

Der Installer

1. prüft Grafikkarte, Arbeitsspeicher und freien Platz,
2. schlägt das passende Sprachmodell vor (nach Arbeitsspeicher: 0.6B unter 12 GB, 1.7B bis 24 GB, 4B darüber;
   der Grafikspeicher begrenzt zusätzlich: unter 6 GB 0.6B, 6–7 GB 1.7B, ab 8 GB 4B),
3. installiert was fehlt: `git`, `uv` (ohne Admin-Rechte),
4. lädt die fertigen acestep.cpp-Programmdateien (ZIP, ca. 130 MB) aus der Veröffentlichung dieses Projekts und prüft die Prüfsumme,
5. lädt bei einer NVIDIA-Karte ab RTX 20xx/GTX 16xx (Compute Capability 7.5) nach Rückfrage die CUDA-Bibliothek cuBLAS direkt von NVIDIA (rund 400 MB, danach etwa 550 MB im Programmordner; fehlt sie, rechnet der Modellserver nur über Vulkan oder CPU). Die Prüfsumme wird kontrolliert. Neu und noch nicht auf einer RTX-Karte getestet,
6. lädt nur die benötigten Modelle (fortsetzbar),
7. testet, ob das Sprachmodell auf der Grafikkarte richtig rechnet (sonst CPU),
8. legt die Verknüpfungen **Music Generator ON / OFF** im Programmordner und auf dem Desktop an und startet die App.

Er kann jederzeit erneut laufen; Erledigtes wird übersprungen.
Optionen (in der PowerShell): `.\Windows-Install.ps1 -Yes`, `-LM 0.6B|1.7B|4B`, `-Cpu` (Sprachmodell immer auf der CPU rechnen, auch in der App unter Zahnrad wählbar; `-Auto` stellt zurück), `-XL` (zusätzlich das größere XL-Klangmodell, 5,3 GB, ab 12 GB Grafikspeicher; danach unter Zahnrad › Klangmodell wählbar), `-NoStart`,
`-Build` (selbst kompilieren, braucht Visual Studio Build Tools und CUDA Toolkit).

## Benutzen

- **Music Generator ON** startet Modellserver und App und öffnet http://localhost:8765
- **Music Generator OFF** beendet alles (Browser-Tabs bleiben offen)
- Zum Starten reicht die Verknüpfung **Music Generator ON** auf dem Desktop oder im Programmordner. Im Ordner liegen daneben die Dateien `Music Generator ON.bat` und `.ps1`; Windows blendet die Endungen oft aus, deshalb sieht man dort zwei bis drei Einträge mit demselben Namen. Die Verknüpfung (mit dem grünen Symbol) oder die `.bat` doppelklicken, nicht die `.ps1` (die öffnet sich sonst im Editor). Nach einem Neustart von Windows einfach wieder **ON** doppelklicken, die Server starten nicht von selbst.
- **IT und VAR** (unter jedem Song und unter „Erweitert“): **IT** sind die Iterationen der Klangerzeugung, mehr Schritte klingen sauberer und dauern länger (Standard 80; 30 reicht zum Ausprobieren). **VAR** ist die Varianz des Sprachmodells, höher heißt freier und abwechslungsreicher, niedriger hält sich enger an Stil und Prompt (Standard 0,85).

## Virenscanner schlägt Alarm

Manche Virenscanner, zum Beispiel Norton mit der Meldung **„IDP.Generic"**, blocken `ace-server.exe` im Ordner `engine\acestep.cpp\build\Release`. Das ist eine Reputationserkennung und keine bekannte Schadsoftware: Die Datei ist neu, selten und nicht digital signiert. Es ist der Modellserver von acestep.cpp. Die Programmdateien stammen unverändert vom Autor von acestep.cpp. Ein auf Windows getesteter Satz liegt als eigene Veröffentlichung in diesem Projekt ([Releases](https://github.com/edgebird-lab/music-generator/releases), Version und Prüfsumme in `scripts\common.sh`). Der Installer lädt genau diesen Satz und bricht ab, wenn die Prüfsumme nicht stimmt.

Wenn du dem Projekt vertraust:
1. Die Datei aus der Quarantäne wiederherstellen und den Programmordner von der Prüfung ausnehmen. Bei Norton: Einstellungen › Antivirus › Scans und Risiken › Von Scans ausschließen, außerdem bei Auto-Protect und SONAR.
2. Optional bei Norton als Fehlalarm melden (submit.norton.com). Das hilft allen.
3. Wer sichergehen will, schlägt die Prüfsumme auf [virustotal.com](https://www.virustotal.com) nach, ohne die Datei hochzuladen. Der Installer gibt sie nach dem Download aus und schreibt alle Prüfsummen samt Version in `engine\acestep.cpp\build\Release\VERSION.txt`. Selbst berechnen geht so:
   ```powershell
   Get-FileHash engine\acestep.cpp\build\Release\ace-server.exe -Algorithm SHA256
   ```
4. Alternativ selbst bauen: `.\Windows-Install.ps1 -Build` (braucht Visual Studio Build Tools und das CUDA-Toolkit). Auch eine selbst gebaute Datei ist unsigniert, kann aber gleich gemeldet werden.

Der Quellcode von acestep.cpp liegt offen auf [GitHub](https://github.com/ServeurpersoCom/acestep.cpp). Herkunft, Lizenzen (MIT) und die Prüfsummen der Einzeldateien liegen nach der Installation neben den Programmdateien (`README.txt`, `LICENSE-*.txt`, `SHA256SUMS.txt`).

## Deinstallieren

`Windows-Uninstall.bat` doppelklicken. Es zeigt, was entfernt wird, und fragt, ob Songs und Bibliothek bleiben sollen (Vorgabe: behalten). Danach den Programmordner löschen. Git und `uv` bleiben installiert.

## Unterschiede zum Mac

| | Mac | Windows |
|---|---|---|
| Start/Stopp | `.command`-Dateien | `.bat` / `.ps1` plus Verknüpfungen mit Symbol |
| Modellserver | wird kompiliert (Metal) | fertige Programmdateien in fester Version mit Prüfsumme (CUDA, Vulkan, CPU; Backend wird zur Laufzeit gewählt) |
| Gemeinsame Werte | `scripts/common.sh` | `scripts/common.ps1` liest Ports und Adressen aus `common.sh` |
| Logs | `data/*.log` | `data/*.log` und `data/*.err.log` |

## Wenn etwas nicht geht

- **Modellserver startet nicht, Meldung wegen fehlender DLL:** NVIDIA-Treiber aktualisieren.
  Das Archiv enthält `ggml-cuda.dll`, aber nicht die CUDA-Bibliothek `cublas64_13.dll` (bei einem früheren Test fehlte genau sie). Fehlt sie auf dem Rechner, lädt `ggml-cuda.dll` nicht und der Modellserver nimmt Vulkan oder CPU; das ist langsamer, aber es geht. Der Installer lädt sie bei passender NVIDIA-Karte nach Rückfrage selbst von NVIDIA; wer ihn schon vorher benutzt hat, startet `Windows-Install.bat` noch einmal. Ob CUDA 13 (Toolkit oder Laufzeit) auf einer RTX-Karte nötig ist, ist bei uns noch nicht praktisch geprüft.
- **Alles sehr langsam:** In `data/ace-server.err.log` nachsehen, welches Backend gewählt wurde
  (`[Load] ... backend: CUDA0` oder `Vulkan0` ist richtig, `CPU` falsch).
- **`ErrorOutOfDeviceMemory` im Log, Song endet mit Fehler:** Der Grafikspeicher reicht nicht.
  Der Installer setzt dafür in `data/engine.conf` die Kachelgröße des VAE-Decoders (`VAE_CHUNK`, z. B. 128 bei 6 GB);
  bei Bedarf kleiner setzen (64) oder mit `.\Windows-Install.ps1 -LM 0.6B` ein kleineres Sprachmodell wählen, danach OFF und ON.
- **Installer bricht bei „Python-Pakete der App“ ab:** Der Installer legt Python 3.12 fest, weil für das neueste
  Python (3.15) noch keine fertigen Pakete existieren. Falls uv trotzdem meckert: `uv python install 3.12` und erneut starten.
- **Update in der App** holt die neueste Veröffentlichung von GitHub und startet neu.
