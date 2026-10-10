# trdc — AUR packaging

`makepkg -sf` here builds:

1. **guacamole-server 1.6.0** (pinned release tarball) with
   `patches/plugin_dir.patch` from the trdc source tree — this makes guacd's
   FreeRDP channel plugins load from a private directory instead of the
   system `/usr/lib/freerdp3`, so nothing needs root.
   Installed into the package at `/usr/lib/trdc/` (private tree; *not* a
   system service, no init script).
2. **trdc** (Tauri 2 app, npm + cargo release build) → `/usr/bin/trdc`,
   plus icon and `.desktop` entry.

At runtime trdc finds `/usr/lib/trdc/guacd` relative to its own binary
(`/usr/bin/trdc` → `../lib/trdc/guacd`), spawns it on 127.0.0.1 with a free
port, sets `LD_LIBRARY_PATH=/usr/lib/trdc/lib` and
`GUAC_RDP_PLUGIN_DIR=/usr/lib/trdc/lib/freerdp3`, and reaps it on exit
(SIGTERM-safe).

## Release flow (maintainer)

```sh
# after pushing a new tag vX.Y.Z to github.com/Teejer/trdc:
cd pkg
# update pkgver/pkgrel + source URL in PKGBUILD, then:
makepkg -g >> PKGBUILD          # refresh sha256sums (replace the old array)
makepkg -sf                     # full local build test
makepkg --printsrcinfo > .SRCINFO
git add PKGBUILD .SRCINFO && git commit
git push origin master          # aur@aur.archlinux.org:trdc.git
```

To claim the AUR slot (name `trdc` is unclaimed as of 2026-10-10):

```sh
git clone ssh://aur@aur.archlinux.org/trdc.git   # errors until the package
                                                 # is registered on the AUR
                                                 # website (Submit Package)
```

## Users

```sh
yay -S trdc        # or: git clone the AUR repo && makepkg -si
```
