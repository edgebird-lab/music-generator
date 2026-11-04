# Was ist der EdgeBird-Lab Music Generator?

Ein Musikstudio, das komplett auf dem eigenen Rechner läuft. Du beschreibst einen Song in ein paar Worten, und ein paar Minuten später liegt er als WAV in deiner Bibliothek: mit Gesang, Text, Tempo und Tonart. Kein Konto, keine Cloud, keine Warteschlange bei einem Anbieter, keine monatlichen Credits. Die Modelle liegen auf deiner Platte, die Rechenarbeit macht deine Grafikkarte.

Entstanden ist das Projekt aus der Web-Oberfläche „music-generator“ von ALPHATESTER für das offene Musikmodell ACE-Step 1.5. EdgeBird-Lab hat daraus eine komplette Werkbank gemacht: einen Songtexter, ein Mehrspur-Studio, Stimmen, die man übernehmen, einsingen lassen und sogar durch die eigene ersetzen kann, und einen Installer, der sich den Rechner ansieht und selbst entscheidet, welche Modelle sinnvoll sind.

## Drei Räume, ein Workflow

**1. Generator.** Prompt, Stil, Länge, fertig. Wer nicht weiß, wie man anfängt, würfelt: Prompt-Würfel, Stil-Würfel, Titel-Würfel. Wer eine Melodie im Kopf hat, hält den Mikrofon-Knopf gedrückt und summt sie; die App beschreibt die Idee und setzt Tempo und Tonart. Wer einen fertigen Song mag, zieht ihn auf das Logo, und Stil und Tempo werden übernommen. Jeder Song wird in mehreren Versionen erzeugt (A, B, C …), damit man die beste auswählt. Gefällt eine Stimme, übernimmt „Stimme verwenden“ ihre Klangfarbe für alle weiteren Songs.

**2. Songtexter.** Ein lokales Sprachmodell (über Ollama) schreibt den Text, mit über hundert Genre-Profilen, die wirklich etwas über Form und Sprache wissen: Rap-Verse als 16 Bars mit Doppelreimen, Blues im AAB-Schema, Shanty mit Vorsänger und Chor, Hyperpop mit Internet-Slang. Dazu Stimmung, Perspektive, Reimschema und ein Aufbau, den man per Drag-and-drop umbaut. Jeder Abschnitt lässt sich einzeln neu schreiben, der ganze Text mit einem Wunsch überarbeiten („Klischees raus“, „stärkere Hook“). Zwei Betriebsarten: **Normal** schreibt jugendfrei und radiotauglich mit jedem installierten Modell. **Ohne Filter** nutzt unzensierte Modelle und vier Härtegrade, für Battle-Rap, Punk oder Ballermann, wo der Text eben nicht brav sein soll.

**3. Studio.** Ein Mehrspur-Editor im Browser, in dem die fertigen Songs erst richtig zu eigenen werden. Gesang und Beat trennen (Demucs), Clips schneiden und am Takt einrasten, Hall und Echo im Tempo des Songs, Bereiche loopen oder herausschneiden. Das Besondere sind die Stimmen: **Neue Stimme** lässt einen anderen Text über den vorhandenen Beat singen und legt ihn taktgenau an. **Meine Stimme** trainiert aus zehn bis zwanzig Minuten eigener Aufnahme ein Stimm-Modell (Applio, RVC) und wandelt jeden Gesang in diese Stimme um: Text, Melodie und Timing bleiben, nur die Stimmfarbe wechselt. Am Ende wandert die Abmischung als neuer Song in die Bibliothek.

## Warum lokal?

Weil die Songs einem gehören sollen, samt Text und Stimme. Weil man ohne Limits experimentieren kann: zehn Versionen, zehn Minuten Länge, jede Nacht. Und weil die Aufnahme der eigenen Stimme den Rechner nie verlässt. Das ist der Preis: Man braucht eine Grafikkarte und etwas Platz. Dafür nimmt der Installer die Arbeit ab. Er erkennt Grafikkarte, Grafikspeicher und Arbeitsspeicher, wählt das Backend (Vulkan, CUDA, ROCm oder Prozessor), lädt die passende Größe des ACE-Step-Sprachmodells, das Standard- und bei genug Speicher das XL-Klangmodell, holt die beiden Textmodelle für den Songtexter in der Größe, die noch neben den Musikmodellen Platz hat, richtet die Spurtrennung ein und legt einen Startbefehl an. Ein Befehl, danach `musik start`.

## Was es braucht

Linux (getestet auf Ubuntu 26.04 mit einer Radeon RX 7900 XTX), ab etwa 6 GB Grafikspeicher für Musik, ab 12 GB für die großen Klang- und Textmodelle, 24 GB für die volle Ausstattung mit Meine Stimme. Mac (Apple Silicon) und Windows (NVIDIA) laufen über die Installer des Ursprungsprojekts; Meine Stimme gibt es dort bisher nicht.

## Wo es herkommt

Code: MIT-Lizenz, Weiterentwicklung von „music-generator“ (ALPHATESTER). Modellserver: acestep.cpp (ServeurpersoCom). Modelle: ACE-Step 1.5 (GGUF von Serveurperso), Ollama-Modelle nach Wahl, Demucs, Applio. Alle Teile sind offen, und genau deshalb kann das Ganze offline laufen.

Quellcode, Installer und Veröffentlichungen: https://github.com/edgebird-lab/music-generator
