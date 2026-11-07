#!/bin/sh
# Basic Cable runs as the unprivileged "node" user. Started as root (the default), this script first hands it
# the data and segment folders, which older images created as root, then drops privileges. Started with
# --user, it runs the command as that user and leaves ownership alone.
set -e

if [ "$(id -u)" = 0 ]; then
  for dir in "${DATA_DIR:-/data}" "${HLS_DIR:-/tmp/basiccable-hls}"; do
    mkdir -p "$dir"
    if ! find "$dir" ! -user node -exec chown -h node:node {} + 2>/dev/null; then
      echo "basiccable: could not give the node user ownership of $dir; Basic Cable may not be able to write there" >&2
    fi
  done
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
