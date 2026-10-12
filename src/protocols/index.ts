/**
 * Protocol registry - the single extension point for adding remote
 * protocols (RDP today; VNC/SSH will return as native engines).
 *
 * A protocol is just data: an id that the Rust session bridge dispatches
 * on, a default port, and a list of form fields whose `name`s are the exact
 * keys of the bridge "open" message for that protocol. To add a protocol:
 *
 *   1. Drop a new ProtocolDef in this file (or a module) and push it into
 *      the registry below.
 *   2. Implement the engine on the Rust side (src-tauri/src/bridge.rs open
 *      dispatch + an engine module like src-tauri/src/rdp/).
 *
 * No other code changes - the sidebar, connection editor, and session
 * connect path are all driven off this registry.
 */
import type { ProtocolDef } from '../types';

const BOOLEAN_YESNO = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

/**
 * Keyboard layouts available in the keymap engine (names as generated from
 * guacamole's tables; the Rust side matches hyphens/underscores loosely).
 */
const LAYOUT_CHOICES = [
  { value: 'en-us-qwerty', label: 'English (US)' },
  { value: 'en-gb-qwerty', label: 'English (UK)' },
  { value: 'de-de-qwertz', label: 'German' },
  { value: 'de-ch-qwertz', label: 'German (Switzerland)' },
  { value: 'fr-fr-azerty', label: 'French' },
  { value: 'fr-be-azerty', label: 'French (Belgium)' },
  { value: 'fr-ca-qwerty', label: 'French (Canada)' },
  { value: 'es-es-qwerty', label: 'Spanish' },
  { value: 'es-latam-qwerty', label: 'Spanish (Latin America)' },
  { value: 'it-it-qwerty', label: 'Italian' },
  { value: 'pt-br-qwerty', label: 'Portuguese (Brazil)' },
  { value: 'pt-pt-qwerty', label: 'Portuguese' },
  { value: 'sv-se-qwerty', label: 'Swedish' },
  { value: 'da-dk-qwerty', label: 'Danish' },
  { value: 'cs-cz-qwertz', label: 'Czech' },
  { value: 'pl-pl-qwerty', label: 'Polish' },
];

const rdp: ProtocolDef = {
  id: 'rdp',
  label: 'RDP',
  accent: '#2f6feb',
  defaultPort: 3389,
  // The password is prompted when you connect and lives only in memory for
  // the app's lifetime; it is never written to connections.json.
  passwordAtConnect: true,
  fields: [
    { name: 'port', label: 'Port', type: 'number', default: '3389' },
    { name: 'username', label: 'Username', type: 'text' },
    { name: 'domain', label: 'Domain', type: 'text' },
    { name: 'width', label: 'Desktop width', type: 'number', advanced: true, default: '1280',
      help: 'Requested remote screen size. Applied on reconnect.' },
    { name: 'height', label: 'Desktop height', type: 'number', advanced: true, default: '800' },
    { name: 'dpi', label: 'DPI scaling', type: 'number', advanced: true, default: '96',
      help: '100-500; 96 = 100%. Some servers ignore it.' },
    { name: 'layout', label: 'Keyboard layout', type: 'select', advanced: true,
      default: 'en-us-qwerty', choices: LAYOUT_CHOICES },
  ],
};

const registry: ProtocolDef[] = [rdp];

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
