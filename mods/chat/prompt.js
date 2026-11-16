// Reads a question an agent asks on its terminal screen (a trust or
// permission prompt): the question's text and its choices, if it has any.

const MARKER = /^(\s*)([❯›>])\s+/;
const NUMBER = /^\s*\d+[.)]\s+/;
const HINT = /(Enter to (confirm|select)|Esc to (cancel|exit)|↑\/↓|to navigate)/i;
const RULE = /^\s*[─━—\-▔▁═]{8,}\s*$/;

// The screen's lines, with what would hide a menu taken away: carriage returns
// (Windows terminals), and the borders of a panel Claude draws in a box. A box's
// top and bottom (╭──╮, ╰──╯) become plain rules, and its sides (│ … │) go, so
// options inside it start with their marker like any other menu's.
function screenLines(screen) {
  return (screen ?? "").replace(/\r/g, "").split("\n").map((l) =>
    /^\s*[╭╰][─━]*.*[╮╯]\s*$/.test(l) ? "─".repeat(20) : l.replace(/^(\s*)│ ?/, "$1").replace(/\s*│\s*$/, ""));
}

// A menu waiting at the bottom of the screen: its hint line ("Enter to confirm ·
// Esc to cancel") is among the last lines. "form" when ←/→ change its values,
// which a pick-one list can't show.
export function menuAtBottom(screen) {
  let lines = screenLines(screen).filter((l) => l.trim());
  // Claude keeps its input box (a rule, ❯, a rule, its footer) under the menu.
  const rules = lines.flatMap((l, i) => (RULE.test(l) ? [i] : []));
  const box = rules.at(-2);
  if (box !== undefined && lines.length - box <= 6 && /^\s*❯/.test(lines[box + 1] ?? "")) lines = lines.slice(0, box);
  const hint = lines.slice(-2).find((l) => HINT.test(l));
  return hint ? (/←|→|to change/.test(hint) ? "form" : "menu") : null;
}

// { question, options: [text], selected, tabs: [{ label, done }] } or null when the screen has no menu.
export function parsePrompt(screen) {
  // A ✔ marks the current choice; read it as an indent, so its line lines up.
  const current = new Set();
  const lines = screenLines(screen).map((l, i) => {
    const m = /^(\s*(?:[❯›>]\s+)?)[✔✓]\s/.exec(l);
    if (!m) return l;
    current.add(i);
    return m[1] + "  " + l.slice(m[0].length);
  });
  const at = lines.findLastIndex((l) => MARKER.test(l) && !HINT.test(l));
  if (at < 0) return null;
  // Unselected options sit where the marker's text starts; deeper lines continue one.
  const indent = MARKER.exec(lines[at])[0].length;
  const depth = (l) => l.length - l.trimStart().length;
  const isOption = (l) => MARKER.test(l) || (l.trim() && depth(l) === indent && !HINT.test(l) && !RULE.test(l));
  const continues = (l) => l.trim() && depth(l) > indent && !HINT.test(l) && !RULE.test(l);

  let first = at;
  while (first > 0 && (isOption(lines[first - 1]) || continues(lines[first - 1]))) first--;
  while (first < at && !isOption(lines[first])) first++;
  let last = at;
  while (last + 1 < lines.length && (isOption(lines[last + 1]) || continues(lines[last + 1]))) last++;
  const options = [];
  let selected = 0;
  for (let i = first; i <= last; i++) {
    const l = lines[i];
    const text = l.replace(MARKER, "").replace(NUMBER, "").trim();
    if (!isOption(l)) { options[options.length - 1] += " " + text; continue; }
    if (i === at) selected = options.length;
    options.push(current.has(i) ? `${text} ✓` : text);
  }
  if (options.length < 2) return null;

  // The question: what's above the options, back to the last rule line.
  let top = first;
  while (top > 0 && !RULE.test(lines[top - 1])) top--;
  // A titled divider ("Read outside … ╌╌╌╌") keeps its title, not its dashes.
  // AskUserQuestion's row of questions ("← ☐ Latency  ✔ Submit →"): read as
  // tabs, not text (☐ is missing from many UI fonts).
  const above = lines.slice(top, first);
  const row = above.findIndex((l) => l.trim());
  const tabs = row >= 0 && /^\s*(←\s*)?[☐☒✔✓]\s/.test(above[row])
    ? [...above[row].matchAll(/([☐☒✔✓])\s*([^☐☒✔✓←→]+)/g)].map(([, box, label]) => ({ label: label.trim(), done: box !== "☐" && label.trim() !== "Submit" }))
    : [];
  if (tabs.length) above.splice(row, 1);
  const question = reflow(above.map((l) => l.replace(/[─━—\-╌┄▔▁═]{8,}/g, " ")));
  return { question, options, selected, tabs };
}

// Terminal-wrapped text as paragraphs.
export function reflow(lines) {
  return lines.map((l) => l.trim()).join("\n").replace(/\n{2,}/g, "\u0000").replace(/\n/g, " ")
    .split("\u0000").map((p) => p.trim()).filter(Boolean).join("\n\n");
}

// The keys that move the selection from `from` to `to` and confirm it.
export function choose(from, to) {
  const keys = Array(Math.abs(to - from)).fill(to > from ? "down" : "up");
  return [...keys, "enter"];
}
