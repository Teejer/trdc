/**
 * Protocol registry - the single extension point for adding remote
 * protocols (RDP, VNC, ...).
 *
 * A protocol is just data: an id that matches the guacd plugin name, a
 * default port, and a list of form fields whose `name`s are the exact
 * guacamole connection parameters guacd expects. To add a protocol:
 *
 *   1. Drop a new ProtocolDef in this file (or a module) and push it into
 *      the registry below.
 *   2. Make sure guacd was built with that protocol's plugin.
 *
 * No other code changes - the sidebar, connection editor, and session
 * connect path are all driven off this registry.
 */
import type { ProtocolDef } from '../types';

const BOOLEAN_YESNO = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

const rdp: ProtocolDef = {
  id: 'rdp',
  label: 'RDP',
  accent: '#2f6feb',
  defaultPort: 3389,
  fields: [
    { name: 'port', label: 'Port', type: 'number', default: '3389' },
    { name: 'username', label: 'Username', type: 'text' },
    { name: 'password', label: 'Password', type: 'password' },
    { name: 'domain', label: 'Domain', type: 'text' },
    { name: 'security', label: 'Security', type: 'select', advanced: true, default: 'any', choices: [
      { value: 'any', label: 'Negotiate (any)' },
      { value: 'nla', label: 'NLA' },
      { value: 'tls', label: 'TLS' },
      { value: 'rdp', label: 'RDP' },
      { value: 'dh', label: 'DH (RDP+DH)' },
    ] },
    { name: 'ignore-cert', label: 'Ignore server cert', type: 'boolean', advanced: true, default: 'true' },
    { name: 'server-layout', label: 'Keyboard layout', type: 'select', advanced: true, default: 'en-us-qwerty', choices: [
      { value: 'en-us-qwerty', label: 'English (US)' },
      { value: 'en-gb-qwerty', label: 'English (UK)' },
      { value: 'de-de-qwertz', label: 'German' },
      { value: 'fr-fr-azerty', label: 'French' },
    ] },
    { name: 'console', label: 'Connect to console', type: 'boolean', advanced: true, default: 'false' },
    { name: 'enable-wallpaper', label: 'Desktop wallpaper', type: 'boolean', advanced: true, default: 'false' },
    { name: 'enable-theming', label: 'Visual themes', type: 'boolean', advanced: true, default: 'false' },
    { name: 'enable-font-smoothing', label: 'Font smoothing', type: 'boolean', advanced: true, default: 'true' },
    { name: 'create-drive-path', label: 'Folder sharing', type: 'boolean', advanced: true, default: 'false' },
    { name: 'color-depth', label: 'Color depth', type: 'select', advanced: true, default: '16', choices: [
      { value: '16', label: 'High (16-bit)' },
      { value: '24', label: 'True (24-bit)' },
    ] },
  ],
};

const vnc: ProtocolDef = {
  id: 'vnc',
  label: 'VNC',
  accent: '#e0653a',
  defaultPort: 5900,
  fields: [
    { name: 'port', label: 'Port', type: 'number', default: '5900' },
    { name: 'password', label: 'Password', type: 'password' },
    { name: 'username', label: 'Username', type: 'text', advanced: true, help: 'Some VNC servers (real VNC) use a username.' },
    { name: 'cursor', label: 'Local cursor', type: 'boolean', advanced: true, default: 'true', help: 'Draw the client-side cursor locally.' },
    { name: 'encoding', label: 'Encoding', type: 'select', advanced: true, default: 'auto', choices: [
      { value: 'auto', label: 'Auto' },
      { value: 'tight', label: 'Tight' },
      { value: 'zlib', label: 'zlib' },
      { value: 'hextile', label: 'Hextile' },
      { value: 'raw', label: 'Raw' },
    ] },
    { name: 'color-depth', label: 'Color depth', type: 'select', advanced: true, default: '24', choices: [
      { value: '8', label: '8-bit' },
      { value: '16', label: '16-bit' },
      { value: '24', label: '24-bit' },
      { value: '32', label: '32-bit' },
    ] },
    { name: 'read-only', label: 'Read-only', type: 'boolean', advanced: true, default: 'false' },
    { name: 'clipboard-enabled', label: 'Clipboard sync', type: 'boolean', advanced: true, default: 'true' },
  ],
};

const ssh: ProtocolDef = {
  id: 'ssh',
  label: 'SSH',
  accent: '#3a8f5f',
  defaultPort: 22,
  fields: [
    { name: 'port', label: 'Port', type: 'number', default: '22' },
    { name: 'username', label: 'Username', type: 'text' },
    { name: 'password', label: 'Password', type: 'password' },
    { name: 'private-key', label: 'Private key', type: 'text', advanced: true, help: 'PEM private key contents (or passphrase below).' },
    { name: 'passphrase', label: 'Key passphrase', type: 'password', advanced: true },
    { name: 'server-alive-interval', label: 'Keepalive (s)', type: 'number', advanced: true, default: '30' },
    { name: 'font-size', label: 'Font size', type: 'number', advanced: true, default: '12' },
    { name: 'color-scheme', label: 'Color scheme', type: 'select', advanced: true, default: 'white-black', choices: [
      { value: 'white-black', label: 'White on black' },
      { value: 'black-white', label: 'Black on white' },
      { value: 'grayblack', label: 'Gray on black' },
    ] },
  ],
};

const telnet: ProtocolDef = {
  id: 'telnet',
  label: 'Telnet',
  accent: '#8a6fd0',
  defaultPort: 23,
  fields: [
    { name: 'port', label: 'Port', type: 'number', default: '23' },
    { name: 'login-definition', label: 'Login script', type: 'text', advanced: true },
    { name: 'font-size', label: 'Font size', type: 'number', advanced: true, default: '12' },
  ],
};

const registry: ProtocolDef[] = [rdp, vnc, ssh, telnet];

export function getProtocols(): ProtocolDef[] {
  return registry;
}

export function getProtocol(id: string): ProtocolDef | undefined {
  return registry.find((p) => p.id === id);
}

/** Register an additional protocol at runtime (used by tests / plugins). */
export function registerProtocol(def: ProtocolDef) {
  if (!registry.find((p) => p.id === def.id)) registry.push(def);
}

export { BOOLEAN_YESNO };
