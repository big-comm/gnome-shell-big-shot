#!/usr/bin/env bash
# Regenerate and merge gettext catalogs.

set -euo pipefail
export LC_ALL=C.UTF-8

UUID="big-shot@communitybig.org"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="usr/share/gnome-shell/extensions/${UUID}"
PO_DIR="${EXT_DIR}/po"
POT_FILE="${PO_DIR}/big-shot.pot"
TMP_POT="$(mktemp)"
MODE="${1:---update}"

if [[ "${MODE}" != "--update" && "${MODE}" != "--check" ]]; then
    echo "Usage: $0 [--update|--check]" >&2
    exit 2
fi

cleanup() {
    rm -f "${TMP_POT}"
}
trap cleanup EXIT

for command_name in xgettext msgmerge msgattrib msgfilter msgfmt msgen; do
    command -v "${command_name}" >/dev/null || {
        echo "${command_name} not found" >&2
        exit 1
    }
done

cd "${ROOT_DIR}"
mapfile -d '' -t source_files < <(
    find "${EXT_DIR}" -name '*.js' -print0 | sort -z
)

xgettext \
    --language=JavaScript \
    --from-code=UTF-8 \
    --keyword=_ \
    --add-comments=TRANSLATORS \
    --sort-by-file \
    --package-name=big-shot \
    --package-version=1.0 \
    --copyright-holder=BigCommunity \
    --msgid-bugs-address=https://github.com/BigCommunity/gnome-shell-big-shot/issues \
    --output="${TMP_POT}" \
    "${source_files[@]}"

catalog_entries() {
    msgfilter --keep-header --input="$1" sed -n '' | msgen - | \
        msgattrib --no-location --no-obsolete --sort-output - | \
        sed -e '/^msgid ""$/,/^$/d' -e '/^#/d'
}

if [[ "${MODE}" == "--check" ]]; then
    status=0
    if ! diff -u <(catalog_entries "${POT_FILE}") \
        <(catalog_entries "${TMP_POT}"); then
        echo "Gettext template is stale" >&2
        status=1
    fi

    for po_file in "${PO_DIR}"/*.po; do
        if ! diff -u <(catalog_entries "${TMP_POT}") \
            <(catalog_entries "${po_file}"); then
            echo "Catalog is stale: ${po_file}" >&2
            status=1
        fi
        msgfmt --check "${po_file}" -o /dev/null
    done
    if [[ "${status}" == 0 ]]; then
        echo "Translation checks passed"
    fi
    exit "${status}"
fi

mv "${TMP_POT}" "${POT_FILE}"

for po_file in "${PO_DIR}"/*.po; do
    msgmerge --update --backup=none --quiet --no-fuzzy-matching \
        "${po_file}" "${POT_FILE}"
    msgattrib --no-obsolete --output-file="${po_file}" "${po_file}"
    if [[ "$(basename "${po_file}")" == "en.po" ]]; then
        msgen "${po_file}" -o "${po_file}"
    fi
    msgfmt --check "${po_file}" -o /dev/null
done

echo "Updated: ${POT_FILE}"
