// Keysym -> scancode translation engine: a port of guacamole-server's
// src/protocols/rdp/keyboard.c (Apache License 2.0).
//
// Given a keyboard layout's flattened KeyDef table (see keymap.rs), tracks
// which keys the *server* believes are pressed, which lock states are in
// sync, and emits the minimal sequence of RDP keyboard/lock/Unicode events
// for each X11 keysym press/release the client reports.

use std::collections::HashMap;

use super::keymap::{KeyDef, KEYMAPS};

// Modifier bookkeeping bits (guacamole's GUAC_RDP_KEYMAP_MODIFIER_*).
pub const MOD_SHIFT: u32 = 1;
pub const MOD_ALTGR: u32 = 2;

// Lock synchronization bits (winpr's KBD_SYNC_*).
pub const KBD_SYNC_SCROLL_LOCK: u32 = 0x0000_0001;
pub const KBD_SYNC_NUM_LOCK: u32 = 0x0000_0002;
pub const KBD_SYNC_CAPS_LOCK: u32 = 0x0000_0004;
pub const KBD_SYNC_KANA_LOCK: u32 = 0x0000_0008;

// X11 keysyms for the locks and modifiers the engine manipulates itself.
pub const KEYSYM_SCROLL_LOCK: i32 = 0xFF14;
pub const KEYSYM_NUM_LOCK: i32 = 0xFF7F;
pub const KEYSYM_CAPS_LOCK: i32 = 0xFFE5;
pub const KEYSYM_KANA_LOCK: i32 = 0xFF2D;
pub const KEYSYM_LSHIFT: i32 = 0xFFE1;
pub const KEYSYM_RSHIFT: i32 = 0xFFE2;
pub const KEYSYM_LCTRL: i32 = 0xFFE3;
pub const KEYSYM_RCTRL: i32 = 0xFFE4;
pub const KEYSYM_LALT: i32 = 0xFFE9;
pub const KEYSYM_RALT: i32 = 0xFFEA;
pub const KEYSYM_ALTGR: i32 = 0xFE03;

/// A low-level input event the engine wants sent to the RDP server.
#[derive(Debug, Clone, Copy)]
pub enum Input {
    /// Raw scancode event; flags carry KBD_FLAGS_EXTENDED etc. The
    /// DOWN/RELEASE direction bit is added by the shim, so `down` is
    /// carried separately here.
    Key { scancode: u16, flags: u16, down: bool },
    /// Unicode keyboard event (one UTF-16 code unit).
    Unicode(u16),
    /// Keyboard lock state synchronization.
    Sync(u32),
}

/// Keysyms the xrdp-derived table omits, mapped to (scancode, KBD_FLAGS_*).
/// XK_KP_Enter is the notable one: guacamole drops it entirely (it has no
/// Unicode fallback either, being a named keysym). E0 1C is the correct
/// extended Enter make/break.
pub fn scancode_alias(keysym: i32) -> Option<(u16, u16)> {
    match keysym {
        0xFF8D => Some((28, 0x0100)), // KBD_FLAGS_EXTENDED
        _ => None,
    }
}

fn lock_flag(keysym: i32) -> u32 {
    match keysym {
        KEYSYM_SCROLL_LOCK => KBD_SYNC_SCROLL_LOCK,
        KEYSYM_NUM_LOCK => KBD_SYNC_NUM_LOCK,
        KEYSYM_CAPS_LOCK => KBD_SYNC_CAPS_LOCK,
        KEYSYM_KANA_LOCK => KBD_SYNC_KANA_LOCK,
        _ => 0,
    }
}

fn count_bits(mut v: u32) -> u32 {
    let mut bits = 0;
    while v != 0 {
        bits += v & 1;
        v >>= 1;
    }
    bits
}

/// Where a keysym event originates. Synthetic events (auto-pressed Shift
/// for 'A', etc.) do not count toward the "all client keys released" reset.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Client,
    Synthetic,
}

pub struct Keyboard {
    /// keysym -> possible definitions, in keymap load order (parent first).
    defs: HashMap<i32, Vec<&'static KeyDef>>,
    /// keysym -> the definition the server currently has pressed.
    pressed: HashMap<i32, &'static KeyDef>,
    /// keysyms the *client* reports as held (server-side auto presses are
    /// excluded), plus the running count guacamole uses for its reset.
    user_pressed: std::collections::HashSet<i32>,
    user_pressed_keys: i32,
    /// Lock state as last synchronized to the server.
    lock_flags: u32,
    synchronized: bool,
    /// Server-side pressed state for aliased keysyms (see scancode_alias).
    alias_pressed: std::collections::HashSet<i32>,
}

impl Keyboard {
    /// Build a keyboard for one of the generated layouts. Unknown layout
    /// names fall back to the first generated layout.
    pub fn new(layout: &str) -> Self {
        let normalized = layout.replace('-', "_");
        let table = KEYMAPS
            .iter()
            .find(|(name, _)| *name == layout || *name == normalized)
            .or_else(|| KEYMAPS.iter().find(|(name, _)| *name == "en-us-qwerty"))
            .map(|(_, defs)| *defs)
            .unwrap_or(&[]);

        let mut defs: HashMap<i32, Vec<&'static KeyDef>> = HashMap::new();
        for def in table {
            defs.entry(def.keysym).or_default().push(def);
        }
        Keyboard {
            defs,
            pressed: HashMap::new(),
            user_pressed: std::collections::HashSet::new(),
            user_pressed_keys: 0,
            lock_flags: KBD_SYNC_NUM_LOCK, // matches the client's default NumLock-on
            synchronized: false,
            alias_pressed: std::collections::HashSet::new(),
        }
    }

    /// Which modifier keys the client side currently holds down.
    fn modifier_flags(&self) -> u32 {
        let mut flags = 0;
        if self.pressed.contains_key(&KEYSYM_LSHIFT) || self.pressed.contains_key(&KEYSYM_RSHIFT) {
            flags |= MOD_SHIFT;
        }
        if self.pressed.contains_key(&KEYSYM_RALT) || self.pressed.contains_key(&KEYSYM_ALTGR) {
            flags |= MOD_ALTGR;
        }
        // AltGr emulated as Ctrl+Alt.
        if self.pressed.contains_key(&KEYSYM_LALT)
            && (self.pressed.contains_key(&KEYSYM_RCTRL) || self.pressed.contains_key(&KEYSYM_LCTRL))
        {
            flags |= MOD_ALTGR;
        }
        flags
    }

    /// Relative wire cost of typing `def` from the current state (each lock
    /// flip is ~2 events, each modifier change 1).
    fn cost(&self, def: &KeyDef) -> u32 {
        let modifiers = self.modifier_flags();
        let mut cost = 1;
        let update_locks = (def.set_locks & !self.lock_flags) | (def.clear_locks & self.lock_flags);
        cost += count_bits(update_locks) * 2;
        let update_modifiers =
            (def.clear_modifiers & modifiers) | (def.set_modifiers & !modifiers);
        cost += count_bits(update_modifiers);
        cost
    }

    /// The definition to use for `keysym` now: sticky to whatever was chosen
    /// at press time (so releases match presses), else the cheapest.
    fn definition(&self, keysym: i32) -> Option<&'static KeyDef> {
        if let Some(def) = self.pressed.get(&keysym) {
            return Some(def);
        }
        let candidates = self.defs.get(&keysym)?;
        let mut best = candidates[0];
        let mut best_cost = self.cost(best);
        for def in &candidates[1..] {
            let c = self.cost(def);
            if c < best_cost {
                best = def;
                best_cost = c;
            }
        }
        Some(best)
    }

    fn update_locks(&mut self, set: u32, clear: u32, sink: &mut dyn FnMut(Input)) {
        let flags = (self.lock_flags | set) & !clear;
        if flags != self.lock_flags {
            sink(Input::Sync(flags));
            self.lock_flags = flags;
        }
    }

    fn update_modifiers(&mut self, set: u32, clear: u32, sink: &mut dyn FnMut(Input)) {
        let current = self.modifier_flags();
        let clear = clear & current;
        let set = set & !current;

        if set & MOD_SHIFT != 0 {
            self.update_keysym(KEYSYM_LSHIFT, true, Source::Synthetic, sink);
        } else if clear & MOD_SHIFT != 0 {
            self.update_keysym(KEYSYM_LSHIFT, false, Source::Synthetic, sink);
            self.update_keysym(KEYSYM_RSHIFT, false, Source::Synthetic, sink);
        }

        if set & MOD_ALTGR != 0 {
            self.update_keysym(KEYSYM_ALTGR, true, Source::Synthetic, sink);
        } else if clear & MOD_ALTGR != 0 {
            self.update_keysym(KEYSYM_ALTGR, false, Source::Synthetic, sink);
            self.update_keysym(KEYSYM_LALT, false, Source::Synthetic, sink);
            self.update_keysym(KEYSYM_RALT, false, Source::Synthetic, sink);
            self.update_keysym(KEYSYM_LCTRL, false, Source::Synthetic, sink);
            self.update_keysym(KEYSYM_RCTRL, false, Source::Synthetic, sink);
        }
    }

    /// Press/release one keysym as reported by the client (the human UI or
    /// the AI tools). See update_keysym.
    pub fn client_keysym(&mut self, keysym: i32, pressed: bool, sink: &mut dyn FnMut(Input)) {
        self.update_keysym(keysym, pressed, Source::Client, sink);
    }

    /// Press/release one X11 keysym, emitting whatever low-level events are
    /// needed. This is the only entry point callers should need.
    pub fn update_keysym(
        &mut self,
        keysym: i32,
        pressed: bool,
        source: Source,
        sink: &mut dyn FnMut(Input),
    ) {
        // First event of the session: align the server's lock LEDs with ours.
        if !self.synchronized {
            sink(Input::Sync(self.lock_flags));
            self.synchronized = true;
        }

        let defined = self.defs.contains_key(&keysym);
        if !defined {
            // Keysyms the table omits but Windows understands (KP_Enter).
            if let Some((scancode, flags)) = scancode_alias(keysym) {
                let was = self.alias_pressed.contains(&keysym);
                if pressed {
                    self.alias_pressed.insert(keysym);
                } else {
                    self.alias_pressed.remove(&keysym);
                }
                if pressed != was {
                    sink(Input::Key {
                        scancode,
                        flags,
                        down: pressed,
                    });
                }
                return;
            }
        }
        let state_changes = if !defined {
            true
        } else if pressed {
            !self.pressed.contains_key(&keysym)
        } else {
            self.pressed.contains_key(&keysym)
        };

        // Track client-side held state only for keys the server also tracks
        // (guacamole's user_pressed_keys) so the reset below fires exactly
        // when the client holds nothing.
        if source == Source::Client && defined {
            if pressed && !self.user_pressed.contains(&keysym) {
                self.user_pressed.insert(keysym);
                self.user_pressed_keys += 1;
            } else if !pressed && self.user_pressed.contains(&keysym) {
                self.user_pressed.remove(&keysym);
                self.user_pressed_keys -= 1;
            }
        }

        if state_changes {
            if pressed {
                self.lock_flags ^= lock_flag(keysym);
            }

            let mut sent: Option<&'static KeyDef> = None;
            if defined {
                if let Some(def) = self.definition(keysym) {
                    if def.scancode != 0 {
                        if pressed {
                            self.update_locks(def.set_locks, def.clear_locks, sink);
                            self.update_modifiers(def.set_modifiers, def.clear_modifiers, sink);
                        }
                        sink(Input::Key {
                            scancode: def.scancode,
                            flags: def.flags,
                            down: pressed,
                        });
                        sent = Some(def);
                    }
                }
                if pressed {
                    if let Some(def) = sent {
                        self.pressed.insert(keysym, def);
                    }
                } else {
                    self.pressed.remove(&keysym);
                }
            }

            // Undefined keysyms (or definitions with no scancode) go out as
            // Unicode events. guacamole also tries dead-key decomposition
            // here; our Unicode events cover the same characters on any
            // Windows Vista-or-newer server, so we skip that.
            if sent.is_none() && pressed {
                if let Some(cp) = keysym_to_unicode(keysym) {
                    let units = match char::from_u32(cp) {
                        Some(c) => {
                            let mut b = [0u16; 2];
                            c.encode_utf16(&mut b).to_vec()
                        }
                        None => vec![cp as u16],
                    };
                    for unit in units {
                        sink(Input::Unicode(unit));
                    }
                }
            }
        }

        // Once the client holds no keys, reset the server-side keyboard
        // state: release anything we auto-pressed (the synthetic Shift that
        // 'A' dragged in, etc.). guacamole's tail loop, verbatim in spirit.
        if self.user_pressed_keys == 0 {
            let held: Vec<i32> = self.pressed.keys().copied().collect();
            for ks in held {
                self.update_keysym(ks, false, Source::Synthetic, sink);
            }
        }
    }

    /// Force the server's lock state to `flags` (used by the UI when it
    /// learns the local LED state).
    pub fn sync_locks(&mut self, flags: u32, sink: &mut dyn FnMut(Input)) {
        self.update_locks(flags, !flags & 0xF, sink);
    }

    /// Scancode+flags for a keysym if the layout maps it directly (used by
    /// the AI risk gate to reason about chords); None if the key would go out
    /// as a Unicode event.
    #[cfg(test)]
    pub fn scancode_for(&self, keysym: i32) -> Option<(u16, u16)> {
        if let Some(alias) = scancode_alias(keysym) {
            return Some(alias);
        }
        self.defs
            .get(&keysym)
            .and_then(|c| c.first())
            .filter(|d| d.scancode != 0)
            .map(|d| (d.scancode, d.flags))
    }
}

/// X11 keysym -> Unicode codepoint for the ranges that can be sent as RDP
/// Unicode events (Latin-1 block and the Unicode keysym block).
pub fn keysym_to_unicode(keysym: i32) -> Option<u32> {
    if (0x20..=0xFF).contains(&keysym) {
        Some(keysym as u32)
    } else if keysym >= 0x0100_0000 {
        Some((keysym & 0x00FF_FFFF) as u32)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(events: &mut Vec<Input>) -> impl FnMut(Input) + '_ {
        move |e| events.push(e)
    }

    #[test]
    fn letters_use_scancodes() {
        let mut kb = Keyboard::new("en-us-qwerty");
        let mut ev = Vec::new();
        kb.client_keysym(0x61, true, &mut collect(&mut ev)); // 'a' press
        // First event is the initial lock sync, then the 'a' press itself.
        assert!(matches!(ev[0], Input::Sync(_)));
        assert!(matches!(ev[1], Input::Key { scancode: 30, down: true, .. }));
        ev.clear();
        kb.client_keysym(0x61, false, &mut collect(&mut ev));
        assert!(matches!(ev[0], Input::Key { scancode: 30, down: false, .. }));
    }

    #[test]
    fn uppercase_presses_shift_and_releases_it() {
        let mut kb = Keyboard::new("en-us-qwerty");
        let mut ev = Vec::new();
        kb.client_keysym(0x41, true, &mut collect(&mut ev)); // 'A' press
        // sync, shift down, 'a' scancode down
        assert_eq!(ev.len(), 3);
        assert!(matches!(ev[1], Input::Key { scancode: 42, down: true, .. }));
        assert!(matches!(ev[2], Input::Key { scancode: 30, down: true, .. }));
        ev.clear();
        kb.client_keysym(0x41, false, &mut collect(&mut ev));
        // 'a' up, then the tail reset releases the synthetic shift
        assert!(matches!(ev[0], Input::Key { scancode: 30, down: false, .. }));
        assert!(matches!(ev[1], Input::Key { scancode: 42, down: false, .. }));
    }

    #[test]
    fn held_shift_is_not_auto_released() {
        // Physically holding Shift while typing 'A' must not have the
        // server-side Shift released when 'A' comes up.
        let mut kb = Keyboard::new("en-us-qwerty");
        let mut ev = Vec::new();
        kb.client_keysym(0xFFE1, true, &mut collect(&mut ev)); // hold LShift
        kb.client_keysym(0x41, true, &mut collect(&mut ev)); // 'A' down
        ev.clear();
        kb.client_keysym(0x41, false, &mut collect(&mut ev)); // 'A' up
        assert_eq!(ev.len(), 1, "only the 'A' release, shift stays held");
        assert!(matches!(ev[0], Input::Key { scancode: 30, down: false, .. }));
    }

    #[test]
    fn unmapped_unicode_falls_back_to_unicode_events() {
        let mut kb = Keyboard::new("en-us-qwerty");
        let mut ev = Vec::new();
        kb.client_keysym(0x01000301, true, &mut collect(&mut ev)); // U+0301 combining acute
        assert!(matches!(ev[1], Input::Unicode(0x0301)));
    }

    #[test]
    fn kp_enter_uses_extended_scancode_28() {
        // The xrdp table omits XK_KP_Enter entirely; the alias must send
        // the extended Enter make/break (E0 1C).
        let mut kb = Keyboard::new("en-us-qwerty");
        let mut ev = Vec::new();
        kb.client_keysym(0xFF8D, true, &mut collect(&mut ev));
        assert!(matches!(
            ev[1],
            Input::Key { scancode: 28, flags: 0x0100, down: true }
        ));
        ev.clear();
        kb.client_keysym(0xFF8D, false, &mut collect(&mut ev));
        assert!(matches!(
            ev[0],
            Input::Key { scancode: 28, flags: 0x0100, down: false }
        ));
    }

    #[test]
    fn win_keys_carry_extended_flag() {
        let kb = Keyboard::new("en-us-qwerty");
        let (code, flags) = kb.scancode_for(0xFFEB).unwrap(); // XK_Meta_L (left Win)
        assert_eq!(code, 91);
        assert_eq!(flags, 0x0100); // FreeRDP emits the E1 prefix internally
    }

    #[test]
    fn surrogate_pairs_split_into_two_unicode_events() {
        let mut kb = Keyboard::new("en-us-qwerty");
        let mut ev = Vec::new();
        // U+1F600 via the Unicode keysym block
        kb.client_keysym(0x0101F600, true, &mut collect(&mut ev));
        let units: Vec<u16> = ev
            .iter()
            .filter_map(|e| match e {
                Input::Unicode(u) => Some(*u),
                _ => None,
            })
            .collect();
        assert_eq!(units, vec![0xD83D, 0xDE00]);
    }
}
