#!/bin/sh
set -eu

if [ "$(stat -c '%u:%g' "$HF_HOME")" != "10001:10001" ]; then
    chown -R app:app "$HF_HOME"
fi

exec setpriv --reuid=app --regid=app --init-groups "$@"
