#!/usr/bin/env bash
# Publish a build made by build-release.sh: a GitHub release with the DMG, then the
# update feed. Nothing here builds anything; it refuses unless the build is the one
# it says it is.
#
#   release/publish.sh <x.y.z> [--notes <file.md>]
#
# THE NOTES go to TWO places: the GitHub release page, and the update feed's own item,
# which is what Sparkle's update window shows (embed-notes.mjs). Through 0.1.3 they went
# only to the page, so every update window was empty. They default to
# release/notes/<x.y.z>.md, and a --notes file elsewhere is copied there, so every
# release's notes are kept in the repo beside its feed entry.
#
# A build made with `--channel alpha|beta` is published as a GitHub PRE-RELEASE, and
# its title says so; one made without is a normal release. The channel is read from
# the build (dist/<version>/channel), never passed here, so an alpha cannot be
# published as stable by a typo.
#
# ORDER MATTERS. The release (and its DMG) goes up FIRST, and the feed second: the
# feed is what makes installed copies fetch the DMG, so a feed pointing at a DMG that
# is not there yet would fail every update check in between. The feed is
# release/appcast.xml on main - the address built into every copy (see the FEED_URL
# note in build-release.sh) - so publishing it is a commit and a push of that one file.
set -euo pipefail

VERSION="${1:-}"
shift || true
NOTES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --notes) shift; NOTES="${1:-}" ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 <x.y.z> [--notes <file.md>]" >&2; exit 2; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
R="$REPO/release"
DIST="$R/dist/$VERSION"
DMG="$DIST/Deckhand-$VERSION.dmg"
TAG="v$VERSION"
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
cd "$REPO"

# ---- the build is the one it says it is ----
[ -f "$DMG" ] || die "no $DMG - run release/build-release.sh $VERSION first"
[ -f "$DIST/appcast.xml" ] || die "no appcast in $DIST - a --no-notarize build cannot be published"
xcrun stapler validate "$DMG" >/dev/null 2>&1 || die "$DMG is not stapled - only a notarized build can be published"
grep -q "sparkle:shortVersionString>$VERSION<" "$DIST/appcast.xml" || die "the appcast is not for $VERSION"
grep -q "releases/download/$TAG/Deckhand-$VERSION.dmg" "$DIST/appcast.xml" || die "the appcast does not point at the $TAG release's DMG"
grep -q 'sparkle:edSignature="' "$DIST/appcast.xml" || die "the appcast's update is not signed"
CHANNEL="$(cat "$DIST/channel" 2>/dev/null || true)"

# ---- the repo can take the feed commit ----
[ "$(git branch --show-current)" = "main" ] || die "publish from main (the feed is main's release/appcast.xml)"
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main is not level with origin/main - pull or push first"
git diff --quiet HEAD -- release/ || die "release/ has uncommitted changes"
gh release view "$TAG" >/dev/null 2>&1 && die "release $TAG already exists"

TITLE="Deckhand $VERSION${CHANNEL:+ ($CHANNEL)}"
PRE=()
[ -n "$CHANNEL" ] && PRE=(--prerelease)
KEPT_NOTES="$R/notes/$VERSION.md"
[ -z "$NOTES" ] && [ -f "$KEPT_NOTES" ] && NOTES="$KEPT_NOTES"
NOTE_ARGS=(--generate-notes)
if [ -n "$NOTES" ]; then
  [ -f "$NOTES" ] || die "no notes file $NOTES"
  NOTE_ARGS=(--notes-file "$NOTES")
else
  echo "warning: no notes ($KEPT_NOTES) - GitHub generates the page's, and Sparkle's update window will be EMPTY"
fi

echo "==> creating $TAG: \"$TITLE\"${CHANNEL:+ as a pre-release}"
gh release create "$TAG" "$DMG" --target "$(git rev-parse HEAD)" --title "$TITLE" "${PRE[@]}" "${NOTE_ARGS[@]}"

# The DMG must actually be downloadable before the feed points at it.
URL="https://github.com/blueandhack/deckhand/releases/download/$TAG/Deckhand-$VERSION.dmg"
for _ in $(seq 1 20); do
  [ "$(curl -sIL -o /dev/null -w '%{http_code}' "$URL")" = "200" ] && break
  sleep 3
done
[ "$(curl -sIL -o /dev/null -w '%{http_code}' "$URL")" = "200" ] || die "the DMG is not downloadable at $URL yet - the feed was NOT updated; rerun the feed step by hand"

echo "==> publishing the update feed (release/appcast.xml on main)"
cp "$DIST/appcast.xml" "$R/appcast.xml"
if [ -n "$NOTES" ]; then
  mkdir -p "$R/notes"
  [ "$(cd "$(dirname "$NOTES")" && pwd)/$(basename "$NOTES")" = "$KEPT_NOTES" ] || cp "$NOTES" "$KEPT_NOTES"
  node "$R/embed-notes.mjs" "$R/appcast.xml" "$VERSION" "$KEPT_NOTES" || die "could not embed the notes in the feed - it was NOT updated"
  git add "$KEPT_NOTES"
fi
git add "$R/appcast.xml"
git commit -q -m "Update feed: Deckhand $VERSION${CHANNEL:+ ($CHANNEL)}"
git push -q origin main
echo "==> done: $URL"
