// The launch agent's program: exec the bundled Node on the bundled host script.
//
// WHY THIS EXISTS. An SMAppService agent plist lives INSIDE the app bundle and
// names its program with `BundleProgram`, a path relative to the bundle - but
// its arguments are plain strings, and the one argument Node needs (the path to
// index.mjs) is only knowable at run time, because the app can be anywhere. So
// launchd runs this, and this finds both files relative to ITSELF and execs.
//
// EXEC, NOT SPAWN: the PID launchd supervises becomes Node itself, so KeepAlive,
// `launchctl kill` and the host's own exit all mean what they meant when launchd
// ran Node directly (host/deckhand-service.sh). The image after exec is the Node
// beside this file, inside the same helper bundle, which is what gives the host
// that bundle's Info.plist and its Bluetooth usage strings - the reason the host
// has always had to run from inside an app bundle (host/build-app.sh, top).
//
// Layout (release/build-release.sh assembles it):
//   Deckhand.app/Contents/Helpers/Deckhand Host.app/Contents/MacOS/
//       Deckhand Host              <- Node
//       deckhand-host-launch       <- this
//   Deckhand.app/Contents/Resources/host/index.mjs
//
// An optional first argument names a different script in Resources/host - used
// only to test the bundle without starting a second full host.
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void die(const char *what) {
    // stderr goes nowhere under launchd, so this also lands in the system log
    // through the exit status; the message is for a person running it by hand.
    fprintf(stderr, "deckhand-host-launch: %s\n", what);
    exit(78); // EX_CONFIG: a broken bundle, which no restart will fix
}

int main(int argc, char **argv) {
    char raw[PATH_MAX];
    uint32_t size = sizeof raw;
    if (_NSGetExecutablePath(raw, &size) != 0) die("executable path too long");
    char self[PATH_MAX];
    if (!realpath(raw, self)) die("cannot resolve own path");

    char *slash = strrchr(self, '/');
    if (!slash) die("own path has no directory");
    *slash = '\0'; // self is now .../Deckhand Host.app/Contents/MacOS

    const char *script = argc > 1 ? argv[1] : "index.mjs";
    // A bare name only: this is a launcher, not a way to run arbitrary files.
    if (strchr(script, '/') || strcmp(script, "..") == 0) die("script must be a bare file name");

    char node[PATH_MAX], rel[PATH_MAX], target[PATH_MAX];
    if (snprintf(node, sizeof node, "%s/Deckhand Host", self) >= (int)sizeof node) die("path too long");
    // MacOS -> Contents -> Deckhand Host.app -> Helpers -> Contents (of Deckhand.app)
    if (snprintf(rel, sizeof rel, "%s/../../../../Resources/host/%s", self, script) >= (int)sizeof rel)
        die("path too long");
    if (!realpath(rel, target)) die("host script not found in the bundle");
    if (access(node, X_OK) != 0) die("bundled node missing or not executable");

    char *args[] = { node, target, NULL };
    execv(node, args);
    die("exec failed");
    return 1;
}
