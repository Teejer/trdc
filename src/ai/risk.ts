/**
 * Risk model for AI tool calls, ported from the krdc-ai work (MR !259).
 *
 * Every tool call is classified:
 *   safe      - reads state only (screenshot, session info); never asks
 *   action    - changes the remote machine; auto-runs only with auto-execute
 *   dangerous - destructive / hard to undo; ALWAYS asks, even with
 *               auto-execute on
 *
 * The classifier inspects arguments, not just the tool name: typing
 * "git status" is an action, typing a destructive command is dangerous.
 */

export type Risk = 'safe' | 'action' | 'dangerous';

/** Tools that only read state and can never change the remote machine. */
const SAFE_TOOLS = new Set(['screenshot', 'session_info', 'wait']);

/**
 * Text that means "this is going to destroy something". Typing any of these
 * is worth interrupting the user for, even with auto-execute enabled.
 * Matched case-insensitively against type_text / clipboard content.
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /(^|\s)sudo(\s+\S+)*\s+rm(\s|$)/i,
  /(^|\s)rm\s+-[a-zA-Z]*(rf|fr|r|f)/i,
  /(^|\s)(del|erase|rd)\s+\//i,
  /(^|\s)format\s+[a-z]:/i,
  /(^|\s)(mkfs|fdisk|parted|diskpart|gdisk|cgdisk|wipefs|shred|cryptsetup)(\s|$)/i,
  /(^|\s)dd\s+if=/i,
  />\s*\/dev\/(sd|nvme|hd|disk|mmcblk)/i,
  /(^|\s)(shutdown|reboot|poweroff|halt|init)\s/i,
  /(^|\s)(net\s+(user|localgroup|share)|netsh|dsregcmd)(\s|$)/i,
  /(^|\s)reg(\s+(add|delete|import|load))?(\s|$)/i,
  /(^|\s)(regsvr32|rundll32|mshta|certutil|bitsadmin|installutil)(\s|$)/i,
  /(^|\s)(schtasks|sc|service)\s+(delete|create|config|stop|query)?/i,
  /(^|\s)(taskkill|pkill|killall|kill)(\s|$)/i,
  /(^|\s)(userdel|usermod|useradd|groupdel|lpasswd|passwd)(\s|$)/i,
  /(^|\s)(iptables|firewall-cmd|ufw)(\s|$)/i,
  /(^|\s)(dnf|yum|apt|apt-get|pacman|zypper|emerge)\s+(-\S+\s+)*(remove|purge|erase|unmerge|autoremove)/i,
  /(^|\s)(Remove-Item|Del-Item|Clear-RecycleBin|Rm)(\s|$)/i,
  /Remove-Item[^;\n]*-(Recurse|Force)/i,
  /(^|\s)(Stop-Computer|Restart-Computer|Set-MpPreference)(\s|$)/i,
  /Invoke-(Command|Expression|WebRequest)[^;\n]*(-OutFile|-UseBasicParsing)?\s*-?/i,
  /(curl|wget)[^;\n]*\|\s*(sudo\s+)?((ba|z|da)?sh|python)/i,
  /powershell[^;\n]*(-(e|enc|encodedcommand)\s)/i,
  /(^|\s)chmod\s+(-[a-zA-Z]+\s+)*777\s+\//i,
  /:\(\)\s*\{.*\};\s*:/i, // fork bomb
  /(^|\s)(history\s+-c|unset\s+HISTFILE|set\s+\+o\s+history)/i,
  /(^|\s)(lvm|vgremove|lvremove|pvremove|mdadm\s+--zero)(\s|$)/i,
  /(^|\s)(systemctl|service)\s+(stop|disable|mask|kill)(\s|$)/i,
  /(^|\s)(write|set-content|add-content|out-file)\s+-?(force|path)?/i,
  /(^|\s)(git\s+push\s+--force|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f)/i,
  /(^|\s)(docker\s+(system\s+prune|rmi|volume\s+rm)|kubectl\s+delete)(\s|$)/i,
  /(^|\s)(crontab|at)\s+(-r|rm)(\s|$)/i,
  /reg\s+add[^;\n]*(HKLM|HKEY_LOCAL_MACHINE)/i,
];

/** Key combinations that log the user out, lock the screen or kill programs. */
const DANGEROUS_CHORDS: { keys: string[]; reason: string }[] = [
  { keys: ['control', 'alt', 'delete'], reason: 'opens the Windows security screen, which can log the user off' },
  { keys: ['alt', 'f4'], reason: 'closes the focused window on the remote machine' },
  { keys: ['meta', 'l'], reason: 'locks the remote machine' },
  { keys: ['meta', 'd'], reason: 'minimises every window on the remote machine' },
  { keys: ['control', 'alt', 'f2'], reason: 'switches the remote virtual terminal' },
];

/** Canonical names so ctrl/control/cmd/super all compare equal. */
const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'control',
  control: 'control',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  win: 'meta',
  windows: 'meta',
  super: 'meta',
  lwin: 'meta',
  rwin: 'meta',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
};

/**
 * Split a chord string like "ctrl+shift+esc" (or an array of names) into a
 * sorted, canonicalised key list for comparison.
 */
export function normalizedChord(input: unknown): string[] {
  const parts: string[] = [];
  const push = (s: string) => {
    for (const piece of s.split('+')) {
      const name = piece.trim().toLowerCase();
      if (!name) continue;
      parts.push(MODIFIER_ALIASES[name] ?? name);
    }
  };
  if (Array.isArray(input)) {
    for (const entry of input) push(String(entry));
  } else if (typeof input === 'string') {
    push(input);
  }
  return [...parts].sort();
}

export function isDangerousChord(sortedChord: string[]): string | null {
  for (const dangerous of DANGEROUS_CHORDS) {
    const expected = [...dangerous.keys].sort();
    if (expected.length === sortedChord.length && expected.every((k, i) => k === sortedChord[i])) {
      return dangerous.reason;
    }
  }
  return null;
}

function truncated(s: string, max = 60): string {
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

/** How much damage this tool call can do, which decides whether we ask. */
export function riskOf(name: string, args: Record<string, unknown>): Risk {
  if (SAFE_TOOLS.has(name)) return 'safe';

  if (name === 'type_text' || name === 'clipboard_paste') {
    const text = String(args.text ?? '');
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(text)) return 'dangerous';
    }
    return 'action';
  }

  if (name === 'key_press') {
    const chord = normalizedChord(args.keys ?? args.key);
    return isDangerousChord(chord) ? 'dangerous' : 'action';
  }

  if (name === 'hotkey') {
    return isDangerousChord(normalizedChord(args.keys)) ? 'dangerous' : 'action';
  }

  // mouse_move, mouse_click, mouse_drag, scroll, and anything unknown.
  return 'action';
}

/** One-line description of what the call would do, for the approval prompt. */
export function describeCall(name: string, args: Record<string, unknown>): string {
  const n = (key: string) => String(Math.round(Number(args[key]) || 0));
  const target = () => {
    const t = String(args.target ?? '').trim();
    return t ? ` \u201c${truncated(t)}\u201d` : '';
  };

  switch (name) {
    case 'screenshot':
      return 'Take a screenshot of the remote screen';
    case 'session_info':
      return 'Read the remote session info';
    case 'wait':
      return `Wait ${args.seconds ?? '?'} s`;
    case 'mouse_move':
      return `Move the remote pointer to (${n('x')}, ${n('y')})`;
    case 'mouse_click': {
      const button = String(args.button || 'left');
      const dbl = args.double ? ' (double)' : '';
      if (args.x === undefined || args.y === undefined) return `Click ${button} button at the current pointer position${target()}`;
      return `Click ${button} button at (${n('x')}, ${n('y')})${dbl}${target()}`;
    }
    case 'mouse_drag':
      return `Drag (${n('fromX')}, ${n('fromY')}) \u2192 (${n('toX')}, ${n('toY')})${target()}`;
    case 'scroll':
      return `Scroll ${Number(args.amount) > 0 ? 'up' : 'down'} at (${n('x')}, ${n('y')})`;
    case 'type_text':
      return `Type \u201c${truncated(String(args.text ?? ''))}\u201d`;
    case 'key_press': {
      const keys = Array.isArray(args.keys) ? args.keys.map(String).join('+') : String(args.key ?? '');
      return `Press ${keys}`;
    }
    case 'hotkey':
      return `Press ${String(args.keys ?? '')}`;
    case 'clipboard_paste':
      return `Send \u201c${truncated(String(args.text ?? ''))}\u201d to the clipboard${args.autoPaste === false ? '' : ' and paste it'}`;
    default:
      return `Run ${name}`;
  }
}

/** Why this call needs approval even with auto-execute on. */
export function dangerReason(name: string, args: Record<string, unknown>): string {
  if (name === 'type_text' || name === 'clipboard_paste') {
    const text = String(args.text ?? '');
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      const m = text.match(pattern);
      if (m) return `It contains \u201c${truncated(m[0].trim(), 40)}\u201d, which can destroy data or change the system.`;
    }
  }
  if (name === 'key_press') {
    const reason = isDangerousChord(normalizedChord(args.keys ?? args.key));
    if (reason) return reason + '.';
  }
  if (name === 'hotkey') {
    const reason = isDangerousChord(normalizedChord(args.keys));
    if (reason) return reason + '.';
  }
  return 'This changes the remote machine.';
}
