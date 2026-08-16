#!/usr/bin/env bash
# Big Shot - Build extensions.gnome.org bundle
#
# Creates a clean upload zip without changing source files.
#
# SPDX-License-Identifier: MIT

set -euo pipefail

UUID="big-shot@communitybig.org"
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

command -v unzip >/dev/null || {
    echo "unzip not found" >&2
    exit 1
}

mkdir -p "${STAGE_EXT}" "${DIST_DIR}"
cp -a "${EXT_DIR}/." "${STAGE_EXT}/"
cp "${ROOT_DIR}/LICENSE" "${STAGE_EXT}/LICENSE"

# Keep generated translations and metadata version out of source changes.
rm -rf "${STAGE_EXT}/locale"
rm -f "${STAGE_EXT}/po/"*~
sed -i '/^[[:space:]]*"version"[[:space:]]*:/d' "${STAGE_EXT}/metadata.json"

gnome-extensions pack -f -o "${DIST_DIR}" \
    --extra-source=parts \
    --extra-source=drawing \
    --extra-source=data \
    --extra-source=lib \
    --extra-source=LICENSE \
    --podir=po \
    "${STAGE_EXT}"

"${ROOT_DIR}/scripts/check-gnome-extension-bundle.sh" \
    "${DIST_DIR}/${UUID}.shell-extension.zip"

echo "Built: ${DIST_DIR}/${UUID}.shell-extension.zip"
