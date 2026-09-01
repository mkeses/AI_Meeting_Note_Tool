#!/bin/sh
set -eu

ensure_owned_directory() {
    directory="$1"
    mkdir -p "$directory"

    if [ "$(stat -c '%u:%g' "$directory")" != "10001:10001" ]; then
        chown -R app:app "$directory"
    fi
}

ensure_owned_directory "$HF_HOME"
ensure_owned_directory /data

exec setpriv --reuid=app --regid=app --init-groups "$@"
