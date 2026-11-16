// Windows support for the chat's helper programs.
//
// Herdr's exec() uses the plain Windows PATH, which has no `sh`, `tail`, `cp`...
// (Git for Windows keeps them in Git\usr\bin, outside PATH), and whose `python3`
// is often the Microsoft Store stub. On Windows, local calls are rerouted:
//   sh -c <script> ...   -> Git's sh, with its /usr/bin first in PATH
//   tail, cp, find, ...  -> run through Git's sh
//   python3              -> py -3 (the python.org launcher), else python
// Remote calls (`on`) and macOS/Linux go straight to Herdr's exec, unchanged.
// A mod can't import another mod's files, so each mod that needs it has a copy.
import { exec as herdrExec, window as appWindow } from "herdr";

const UNIX = new Set(["sh", "tail", "cp", "find", "mkdir", "wc", "sleep", "cat", "rm"]);
// MSYS2_ARG_CONV_EXCL: MSYS must not rewrite "/..."-looking arguments (JSON,
// slash commands) that scripts pass on to native programs such as herdr-app.
const PRELUDE = 'export PATH="/usr/bin:$PATH" MSYS2_ARG_CONV_EXCL="*"\n';

export const onWindows = () => appWindow()?.platform === "windows";

// Only settled answers are cached, never a pending promise: module state is
// shared by every copy of the mod, and Herdr cancels a copy's pending calls
// when it reloads or closes, so a shared promise could stay pending forever.

// Git's sh.exe, found from `git --exec-path` (<git>/mingw64/libexec/git-core).
let gitSh = null;
async function findGitSh() {
  if (gitSh) return gitSh;
  const r = await herdrExec("git", ["--exec-path"]);
  const core = r.stdout.trim().replace(/\\/g, "/");
  const root = core.replace(/\/(mingw64|mingw32|clangarm64)\/libexec\/git-core$/i, "");
  if (r.code !== 0 || root === core) throw new Error("Git for Windows not found: the chat needs its sh (git-scm.com)");
  return (gitSh = `${root}/usr/bin/sh.exe`);
}

// `py -3` when the launcher is there, else `python`; never the Store stub `python3`.
let python = null;
async function findPython() {
  if (python) return python;
  const r = await herdrExec("py", ["-3", "-c", "print(1)"]).catch(() => null);
  return (python = r?.code === 0 ? ["py", "-3"] : ["python"]);
}

// An argument as the script will restore it: base64, decoded by sh. MSYS
// rewrites backslashes and quotes while reading sh.exe's command line (a JSON
// `C:\\Users` arrives as `C:\Users`, a `\"` grows a backslash), and base64 has
// neither. Command substitution drops trailing newlines; no argument ends in one.
const quote = (s) => `"$(printf %s '${btoa(unescape(encodeURIComponent(String(s))))}' | base64 -d)"`;

export async function exec(cmd, args = [], opts = {}) {
  if (opts?.on || !onWindows()) return herdrExec(cmd, args, opts);
  if (cmd === "python3") { const [py, ...pre] = await findPython(); return herdrExec(py, [...pre, ...args], opts); }
  if (cmd === "sh" && args[0] === "-c") {
    // Positional args go into the script (`set -- …`), not on the command line:
    // MSYS mangles an argument that holds double quotes but no spaces (a JSON
    // object comes through as ""), while the script, which the parent wraps
    // in quotes because of its spaces, is parsed correctly.
    const positional = args.slice(3).map(quote).join(" ");
    const script = PRELUDE + (positional ? `set -- ${positional}\n` : "") + args[1];
    return herdrExec(await findGitSh(), ["-c", script, args[2] ?? "sh"], opts);
  }
  if (UNIX.has(cmd)) return herdrExec(await findGitSh(), ["-c", PRELUDE + 'exec "$0" "$@"', cmd, ...args], opts);
  return herdrExec(cmd, args, opts);
}

// Runs a PowerShell script (Windows only). -EncodedCommand sidesteps command-line
// quoting entirely; put values into the script with psQuote().
export function powershell(script, opts = {}) {
  // UTF-16LE + base64 by hand: Herdr's Buffer has no "utf16le" and gives an
  // empty string for base64, so build the byte string and use btoa.
  const text = "[Console]::OutputEncoding = [Text.Encoding]::UTF8\n" + script;
  let bytes = "";
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); bytes += String.fromCharCode(c & 0xff, c >> 8); }
  const encoded = btoa(bytes);
  return herdrExec("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded], opts);
}

export const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
