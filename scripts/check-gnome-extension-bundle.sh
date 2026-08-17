#!/usr/bin/env bash
# Validate the extensions.gnome.org bundle.

set -euo pipefail

UUID="big-shot@communitybig.org"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${ROOT_DIR}/usr/share/gnome-shell/extensions/${UUID}"
BUNDLE="${1:-${ROOT_DIR}/dist/${UUID}.shell-extension.zip}"
LIST_FILE="$(mktemp)"

cleanup() {
    rm -f "${LIST_FILE}"
}
trap cleanup EXIT

command -v unzip >/dev/null || {
    echo "unzip not found" >&2
    exit 1
}

[[ -f "${BUNDLE}" ]] || {
    echo "Bundle not found: ${BUNDLE}" >&2
    exit 1
}

unzip -tqq "${BUNDLE}"
unzip -Z1 "${BUNDLE}" > "${LIST_FILE}"

for required in extension.js metadata.json stylesheet.css LICENSE LICENSE.MIT NOTICE; do
    grep -Fxq "${required}" "${LIST_FILE}" || {
        echo "Missing bundle file: ${required}" >&2
        exit 1
    }
done

for required_dir in parts/ drawing/ data/icons/ lib/ locale/; do
    grep -q "^${required_dir}" "${LIST_FILE}" || {
        echo "Missing bundle directory: ${required_dir}" >&2
        exit 1
    }
done

if grep -Eq '(^|/)(po|tests|scripts|node_modules)/|\.(po|pot)$' "${LIST_FILE}"; then
    echo "Bundle contains development files" >&2
    exit 1
fi

for unused_icon in \
    data/icons/big-shot-cloud-upload-symbolic.svg \
    data/icons/big-shot-pixelate-symbolic.svg \
    data/icons/big-shot-share-link-symbolic.svg; do
    if grep -Fxq "${unused_icon}" "${LIST_FILE}"; then
        echo "Bundle contains unused icon: ${unused_icon}" >&2
        exit 1
    fi
done

if unzip -p "${BUNDLE}" metadata.json | grep -q '"version"'; then
    echo "Bundle metadata contains deprecated version field" >&2
    exit 1
fi

if ! unzip -p "${BUNDLE}" metadata.json | grep -Fq "\"uuid\": \"${UUID}\""; then
    echo "Bundle metadata UUID mismatch" >&2
    exit 1
fi

if ! unzip -p "${BUNDLE}" metadata.json | grep -Fq '"shell-version": ["50"]'; then
    echo "Bundle must target only the validated GNOME 50 release" >&2
    exit 1
fi

if ! unzip -p "${BUNDLE}" NOTICE | grep -Fq 'WSID/gnome-shell-screencast-extra-feature'; then
    echo "Bundle attribution is missing" >&2
    exit 1
fi

if ! cmp -s <(unzip -p "${BUNDLE}" extension.js) "${EXT_DIR}/extension.js"; then
    echo "Bundle extension.js differs from source" >&2
    exit 1
fi

if grep -Eq 'pkexec|pacman|--noconfirm' < <(unzip -p "${BUNDLE}" extension.js); then
    echo "Bundle contains privileged package installation" >&2
    exit 1
fi

echo "Bundle checks passed: ${BUNDLE}"
