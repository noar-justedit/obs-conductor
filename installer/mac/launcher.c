/*
 * OBS Conductor.app/Contents/MacOS/OBSConductor - the app's main program.
 *
 * macOS starts this (Finder, Login Items). It only starts Node.js, which
 * sits next to it (Contents/MacOS/node), with the app's code
 * (Contents/Resources/app/src/main.js), and gets out of the way: Node.js
 * takes its place (same process). A real program rather than a shell script:
 * Apple's signature and notarization expect one.
 *
 * Arguments are passed on (--simulate, --stop, --add-dock), except the
 * "-psn_..." one older macOS adds when it starts an app.
 * OBSCONDUCTOR_PACKAGED=1 tells the app it is installed (paths.js).
 *
 * Built by build_mac.command:  clang -arch arm64 -arch x86_64 launcher.c
 */
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <libgen.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

static int exe_path(char *out, size_t size) {
#ifdef __APPLE__
  char raw[PATH_MAX];
  uint32_t n = sizeof raw;
  if (_NSGetExecutablePath(raw, &n) != 0) return -1;
  return realpath(raw, out) ? 0 : -1;
#else
  ssize_t n = readlink("/proc/self/exe", out, size - 1);   /* only to test the code on Linux */
  if (n < 0) return -1;
  out[n] = 0;
  return 0;
#endif
}

int main(int argc, char **argv) {
  char exe[PATH_MAX], dir[PATH_MAX], node[PATH_MAX + 64], script[PATH_MAX + 64];
  if (exe_path(exe, sizeof exe) != 0) { perror("OBSConductor: own path"); return 1; }
  strncpy(dir, dirname(exe), sizeof dir - 1);
  dir[sizeof dir - 1] = 0;
  snprintf(node, sizeof node, "%s/node", dir);
  snprintf(script, sizeof script, "%s/../Resources/app/src/main.js", dir);

  char **args = calloc((size_t)argc + 2, sizeof *args);
  if (!args) return 1;
  int k = 0;
  args[k++] = node;
  args[k++] = script;
  for (int i = 1; i < argc; i++) if (strncmp(argv[i], "-psn_", 5) != 0) args[k++] = argv[i];
  args[k] = NULL;

  setenv("OBSCONDUCTOR_PACKAGED", "1", 1);
  execv(node, args);
  perror("OBSConductor: could not start Node.js");
  return 1;
}
