#!/usr/bin/env sh
# Start the Agent Chat desktop app.
# Some editors set ELECTRON_RUN_AS_NODE=1, which makes Electron run as plain Node with no window,
# so it is removed here.
cd "$(dirname "$0")" || exit 1
exec env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . "$@"
