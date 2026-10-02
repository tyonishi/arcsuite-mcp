#!/bin/sh
# Run inside the actual configured service container. Never reads secret bytes.
set -eu

role=${1-}
if [ "$#" -ne 1 ]; then
    printf '%s\n' 'usage: check-secret-readability.sh gateway|adapter' >&2
    exit 2
fi
case "$role" in gateway|adapter) ;; *)
    printf '%s\n' 'usage: check-secret-readability.sh gateway|adapter' >&2
    exit 2
;; esac
uid=$(id -u)
failed=0

check_file() {
    variable=$1
    file=$2
    if [ -z "$file" ] || [ ! -f "$file" ] || [ ! -r "$file" ] || ! ( : < "$file" ) 2>/dev/null; then
        printf 'secret_preflight_failed service=%s uid=%s variable=%s\n' "$role" "$uid" "$variable" >&2
        failed=1
    fi
}

check_file ARCSUITE_ADAPTER_INTERNAL_TOKEN_FILE "${ARCSUITE_ADAPTER_INTERNAL_TOKEN_FILE-}"
case "$role" in
    gateway)
        check_file MCP_CURSOR_HMAC_SECRET_FILE "${MCP_CURSOR_HMAC_SECRET_FILE-}"
        check_file ARCSUITE_MCP_CLIENT_TOKENS_JSON_FILE "${ARCSUITE_MCP_CLIENT_TOKENS_JSON_FILE-}"
        case "${MCP_OPAQUE_REFS_ENABLED-false}" in
            true) check_file MCP_OPAQUE_REF_KEYS_JSON_FILE "${MCP_OPAQUE_REF_KEYS_JSON_FILE-}" ;;
            false) ;;
            *) printf 'secret_preflight_failed service=%s uid=%s variable=MCP_OPAQUE_REFS_ENABLED\n' "$role" "$uid" >&2; failed=1 ;;
        esac
        ;;
    adapter)
        check_file ARCSUITE_PASSWORD_FILE "${ARCSUITE_PASSWORD_FILE-}"
        ;;
esac
if [ "$failed" -ne 0 ]; then exit 1; fi
printf 'secret_preflight_passed service=%s uid=%s\n' "$role" "$uid"
