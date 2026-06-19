#!/usr/bin/env bash
# Big Shot - Build extensions.gnome.org bundle
#
# Creates a clean upload zip without changing source files.
#
# SPDX-License-Identifier: MIT

set -euo pipefail

UUID="big-shot@bigcommunity.org"
EXT_REL="usr/share/gnome-shell/extensions/${UUID}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${ROOT_DIR}/${EXT_REL}"
DIST_DIR="${ROOT_DIR}/dist"
STAGE_ROOT="$(mktemp -d)"
STAGE_EXT="${STAGE_ROOT}/${UUID}"

cleanup() {
    rm -rf "${STAGE_ROOT}"
}
trap cleanup EXIT

command -v gnome-extensions >/dev/null || {
    echo "gnome-extensions not found" >&2
    exit 1
}

command -v msgfmt >/dev/null || {
    echo "msgfmt not found" >&2
    exit 1
}

mkdir -p "${STAGE_EXT}" "${DIST_DIR}"
cp -a "${EXT_DIR}/." "${STAGE_EXT}/"

# Keep generated translations and metadata version out of source changes.
rm -rf "${STAGE_EXT}/locale"
rm -f "${STAGE_EXT}/po/"*~
sed -i '/^[[:space:]]*"version"[[:space:]]*:/d' "${STAGE_EXT}/metadata.json"

gnome-extensions pack -f -o "${DIST_DIR}" \
    --extra-source=parts \
    --extra-source=drawing \
    --extra-source=data \
    --podir=po \
    "${STAGE_EXT}"

echo "Built: ${DIST_DIR}/${UUID}.shell-extension.zip"
