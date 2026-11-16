// What the chat needs from the desktop it runs on, for macOS, Linux and Windows:
// the clipboard, the file picker, opening a file, and an image's size.
// Each tries the macOS tool first, then the Linux ones (Wayland, then X11);
// Windows uses PowerShell, which every Windows has.
import { exec, onWindows, powershell, psQuote } from "./winexec.js";
import { Buffer } from "buffer";
import * as fs from "fs/promises";

const sh = (script, ...args) => exec("sh", ["-c", script, "sh", ...args]);

// Puts text on the clipboard; false when no clipboard tool is installed.
export async function copyText(text) {
  if (onWindows()) return (await powershell(`Set-Clipboard -Value ${psQuote(text)}`)).code === 0;
  const r = await sh(`
    if command -v pbcopy >/dev/null 2>&1; then printf "%s" "$1" | pbcopy
    elif [ -n "$WAYLAND_DISPLAY" ] && command -v wl-copy >/dev/null 2>&1; then printf "%s" "$1" | wl-copy
    elif command -v xclip >/dev/null 2>&1; then printf "%s" "$1" | xclip -selection clipboard
    elif command -v xsel >/dev/null 2>&1; then printf "%s" "$1" | xsel --clipboard --input
    elif command -v wl-copy >/dev/null 2>&1; then printf "%s" "$1" | wl-copy
    elif q=$(command -v qdbus6 || command -v qdbus) && "$q" org.kde.klipper /klipper >/dev/null 2>&1; then "$q" org.kde.klipper /klipper setClipboardContents "$1"
    else exit 3; fi`, text);
  return r.code === 0;
}

// Saves an image on the clipboard to `path` as PNG: true, false when there's
// none, or "missing" when this desktop has no tool to read it.
export async function pasteImage(path) {
  if (onWindows()) {
    const r = await powershell(`Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -eq $null) { exit 1 }
$img.Save(${psQuote(path)}, [System.Drawing.Imaging.ImageFormat]::Png)`);
    return r.code === 0;
  }
  const r = await sh(`
    if command -v osascript >/dev/null 2>&1; then
      osascript -e "set f to open for access (POSIX file \\"$1\\") with write permission" \\
        -e "write (the clipboard as «class PNGf») to f" -e "close access f" >/dev/null 2>&1
    elif command -v wl-paste >/dev/null 2>&1 && wl-paste --list-types 2>/dev/null | grep -q '^image/png'; then wl-paste --type image/png > "$1"
    elif command -v xclip >/dev/null 2>&1; then xclip -selection clipboard -t image/png -o > "$1" 2>/dev/null
    else exit 3; fi
    [ -s "$1" ]`, path);
  return r.code === 3 ? "missing" : r.code === 0;
}

// Opens a file in the desktop's default app (an image in Preview, say).
export function openFile(path) {
  if (onWindows()) return powershell(`Invoke-Item -LiteralPath ${psQuote(path)}`);
  return sh(`if command -v open >/dev/null 2>&1 && [ "$(uname)" = Darwin ]; then open "$1"; else xdg-open "$1" >/dev/null 2>&1 & fi`, path);
}

// The system's file picker, several files at once: their paths, [] when
// cancelled, or null when this desktop has no picker the chat can use.
export async function pickFiles(prompt = "Attach to your message") {
  if (onWindows()) {
    // Per-monitor DPI awareness, or Windows bitmap-stretches the dialog
    // (blurry on scaled displays); a hidden topmost owner keeps it in front of
    // Herdr; the long timeout leaves time to browse (exec's default is 30 s).
    const r = await powershell(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class HerdrDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value); }'
[HerdrDpi]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = ${psQuote(prompt)}
$d.Multiselect = $true
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileNames | ForEach-Object { $_ } }
$owner.Dispose()`, { timeout: 600000 });
    if (r.code !== 0) return null;
    return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  const r = await sh(`
    if command -v osascript >/dev/null 2>&1; then
      osascript -e "set fs to choose file with prompt \\"$1\\" with multiple selections allowed" \\
        -e 'set out to ""' -e 'repeat with f in fs' -e 'set out to out & POSIX path of f & linefeed' -e 'end repeat' -e 'return out'
    elif command -v kdialog >/dev/null 2>&1; then kdialog --title "$1" --getopenfilename "$HOME" --multiple --separate-output
    elif command -v zenity >/dev/null 2>&1; then zenity --file-selection --multiple --separator="
" --title="$1"
    elif command -v yad >/dev/null 2>&1; then yad --file --multiple --separator="
" --title="$1"
    else exit 3; fi; true`, prompt);
  if (r.code === 3) return null;
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

// An image's pixel size from its header (PNG, JPEG, GIF, WebP), with nothing
// to install: { w, h }, or null.
const SIZE = `
import struct, sys
try: b = open(sys.argv[1], "rb").read(262144)
except OSError: sys.exit(1)
def out(w, h): print(w, h); sys.exit(0)
if b[:8] == b"\\x89PNG\\r\\n\\x1a\\n": out(*struct.unpack(">II", b[16:24]))
if b[:6] in (b"GIF87a", b"GIF89a"): out(*struct.unpack("<HH", b[6:10]))
if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
    k = b[12:16]
    if k == b"VP8 ": w, h = struct.unpack("<HH", b[26:30]); out(w & 0x3fff, h & 0x3fff)
    if k == b"VP8L": v = int.from_bytes(b[21:25], "little"); out((v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1)
    if k == b"VP8X": out(int.from_bytes(b[24:27], "little") + 1, int.from_bytes(b[27:30], "little") + 1)
if b[:2] == b"\\xff\\xd8":
    i = 2
    while i + 9 < len(b):
        if b[i] != 0xFF: i += 1; continue
        m = b[i + 1]
        if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC): h, w = struct.unpack(">HH", b[i + 5:i + 9]); out(w, h)
        i += 2 + struct.unpack(">H", b[i + 2:i + 4])[0]
sys.exit(1)
`;

// Writes base64 data to `path` as bytes. On Windows, Herdr's fs.writeFile
// writes binary data as an empty file, so the text goes to a temp file that
// Python decodes.
const DECODE = `
import base64, os, sys
with open(sys.argv[1]) as f: data = base64.b64decode(f.read())
with open(sys.argv[2], "wb") as f: f.write(data)
os.remove(sys.argv[1])
`;

export async function writeBase64(path, b64) {
  if (!onWindows()) return fs.writeFile(path, Buffer.from(b64, "base64"));
  await fs.writeFile(`${path}.b64`, b64);
  const r = await exec("python3", ["-c", DECODE, `${path}.b64`, path]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "couldn't write the image");
}

export async function imageSize(path) {
  const r = await exec("python3", ["-c", SIZE, path]);
  const [w, h] = r.stdout.trim().split(" ").map(Number);
  return w > 0 && h > 0 ? { w, h } : null;
}
