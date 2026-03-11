#!/bin/bash
# Smart patcher for GNOME Shell Screencast service
# Fixes GNOME 49 bug: Gst.init(null) / Gst.init_check(null) throw
# "Expected type utf8 for Argument 'argv' but got type 'null'"
#
# This script:
#   - Checks if the fix is actually needed (future GNOME versions may fix it)
#   - Applies the monkey-patch only when the bug is confirmed
#   - Creates a backup before patching so it can be cleanly reversed

set -euo pipefail

TARGET="/usr/share/gnome-shell/org.gnome.Shell.Screencast"
BACKUP="${TARGET}.big-shot-backup"
MARKER="Workaround GNOME 49 bug"

msg() { echo "[Big Shot] $*"; }

# Check if the workaround is already in the file
is_patched() {
    [[ -f "$TARGET" ]] && grep -q "$MARKER" "$TARGET" 2>/dev/null
}

# Check if the Gst.init_check(null) bug exists in the current GJS/GStreamer
bug_exists() {
    [[ -f "$TARGET" ]] || return 1

    local test_file
    test_file=$(mktemp /tmp/gst-null-test-XXXXXX.mjs)
    cat > "$test_file" << 'TESTEOF'
import Gst from 'gi://Gst';
try {
    Gst.init_check(null);
} catch(e) {
    if (e.message && e.message.includes('utf8')) {
        throw e;
    }
}
TESTEOF

    local has_bug=1
    if ! timeout 5 /usr/bin/gjs -m "$test_file" &>/dev/null; then
        has_bug=0  # Bug confirmed
    fi
    rm -f "$test_file"
    return "$has_bug"
}

apply_patch() {
    if [[ ! -f "$TARGET" ]]; then
        msg "Screencast service file not found, skipping"
        return 0
    fi

    if is_patched; then
        msg "Screencast fix already applied"
        return 0
    fi

    if ! bug_exists; then
        msg "Gst.init_check(null) works correctly — no patch needed"
        return 0
    fi

    msg "Applying screencast Gst.init fix..."

    # Backup original (only if no previous backup exists)
    [[ -f "$BACKUP" ]] || cp -f "$TARGET" "$BACKUP"

    # Insert workaround after the imports.package.init({...}); block
    local tmpfile inserted=false
    tmpfile=$(mktemp)

    while IFS= read -r line || [[ -n "$line" ]]; do
        printf '%s\n' "$line" >> "$tmpfile"
        if [[ "$line" == "});" ]] && [[ "$inserted" == false ]]; then
            inserted=true
            cat >> "$tmpfile" << 'PATCH'

// Workaround GNOME 49 bug: Gst.init(null) and Gst.init_check(null) throw
// because GJS rejects null as utf8 argv. Monkey-patch to convert null to [].
try {
    const Gst = (await import('gi://Gst')).default;
    const _origInit = Gst.init;
    const _origInitCheck = Gst.init_check;
    Gst.init = function(argv) {
        return _origInit.call(this, argv ?? []);
    };
    Gst.init_check = function(argv) {
        return _origInitCheck.call(this, argv ?? []);
    };
} catch (_e) { /* Gst not available */ }
PATCH
        fi
    done < "$TARGET"

    if [[ "$inserted" == true ]]; then
        mv "$tmpfile" "$TARGET"
        chmod 644 "$TARGET"
        msg "Screencast fix applied successfully"
    else
        rm -f "$tmpfile"
        msg "Could not find insertion point — patch NOT applied"
        return 1
    fi
}

remove_patch() {
    if [[ -f "$BACKUP" ]]; then
        mv -f "$BACKUP" "$TARGET"
        chmod 644 "$TARGET"
        msg "Screencast fix removed, original restored"
    elif is_patched; then
        msg "Warning: backup not found, cannot restore original file"
    else
        msg "No patch to remove"
    fi
}

case "${1:-}" in
    --apply)  apply_patch  ;;
    --remove) remove_patch ;;
    *)
        echo "Usage: $0 {--apply|--remove}"
        exit 1
        ;;
esac
