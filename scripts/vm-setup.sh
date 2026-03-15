#!/bin/bash
# vm-setup.sh — Post-install setup for BigCommunity GNOME development VM
#
# Run this script inside the VM after a fresh BigCommunity GNOME install.
# It configures keyboard shortcuts (to avoid host conflicts), clones the
# project, and installs the Big Shot extension for testing.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/xathay/gnome-shell-big-shot/main/scripts/vm-setup.sh | bash
#   # or clone the repo first and run: bash scripts/vm-setup.sh
#
# SPDX-License-Identifier: GPL-2.0-or-later

set -euo pipefail

echo "=== BigCommunity GNOME Dev VM Setup ==="

# --- 1. Keyboard shortcuts (avoid host conflicts) ---
echo "[1/4] Configuring keyboard shortcuts..."

# Disable Super key overlay (conflicts with host)
gsettings set org.gnome.mutter overlay-key ''

# Activities Overview → Ctrl+Super
gsettings set org.gnome.shell.keybindings toggle-overview "['<Ctrl>Super_L']"

# Screenshot UI → Ctrl+Print
gsettings set org.gnome.shell.keybindings show-screenshot-ui "['<Ctrl>Print']"

# Direct screenshot → Ctrl+Shift+Print
gsettings set org.gnome.shell.keybindings screenshot "['<Ctrl><Shift>Print']"

echo "  Super       → disabled (use Ctrl+Super for Activities)"
echo "  Ctrl+Print  → Screenshot UI"
echo "  Ctrl+Shift+Print → Direct screenshot"

# --- 2. Clone Big Shot project ---
echo "[2/4] Cloning Big Shot project..."

PROJ_DIR="$HOME/gnome-shell-big-shot"
if [[ -d "$PROJ_DIR" ]]; then
    echo "  Project already cloned at $PROJ_DIR, pulling..."
    git -C "$PROJ_DIR" pull --ff-only
else
    git clone https://github.com/xathay/gnome-shell-big-shot.git "$PROJ_DIR"
fi

# --- 3. Install extension ---
echo "[3/4] Installing Big Shot extension..."

EXT_SRC="$PROJ_DIR/usr/share/gnome-shell/extensions/big-shot@bigcommunity.org"
EXT_DST="/usr/share/gnome-shell/extensions/big-shot@bigcommunity.org"

if [[ -d "$EXT_SRC" ]]; then
    sudo cp -r "$EXT_SRC" "$(dirname "$EXT_DST")/"
    echo "  Extension installed to $EXT_DST"
else
    echo "  WARNING: Extension source not found at $EXT_SRC"
fi

# Enable the extension
gnome-extensions enable big-shot@bigcommunity.org 2>/dev/null || true

# --- 4. Summary ---
echo "[4/4] Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Log out and log back in to load the extension"
echo "  2. Press Ctrl+Print to open Screenshot UI"
echo "  3. Click the pencil icon to test the edit panel"
echo ""
echo "To update the extension after code changes:"
echo "  cd $PROJ_DIR && git pull"
echo "  sudo cp -r usr/share/gnome-shell/extensions/big-shot@bigcommunity.org/* $EXT_DST/"
echo "  # Then log out / log in"
