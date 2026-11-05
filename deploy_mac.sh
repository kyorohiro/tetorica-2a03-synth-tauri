#!/bin/sh
set -eu

# Supply signing and notarization credentials through the calling environment.
: "${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY before running this script}"
: "${APPLE_ID:?Set APPLE_ID before running this script}"
: "${APPLE_PASSWORD:?Set APPLE_PASSWORD before running this script}"
: "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID before running this script}"
export CI=true
export APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID

npx tauri build --target x86_64-apple-darwin --bundles app,dmg
npx tauri build --target aarch64-apple-darwin --bundles app,dmg
