#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef int (*renameat2_function)(
  int olddirfd,
  const char *oldpath,
  int newdirfd,
  const char *newpath,
  unsigned int flags
);

static void pause_before_rename(const char *newpath) {
  static int paused = 0;
  const char *marker = getenv("TASKMUX_TEST_RENAMEAT2_MARKER");
  const char *target = getenv("TASKMUX_TEST_RENAMEAT2_TARGET");
  if (paused || marker == NULL || target == NULL || newpath == NULL ||
      strcmp(target, newpath) != 0) {
    return;
  }
  paused = 1;
  int descriptor = open(marker, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (descriptor >= 0) {
    (void)write(descriptor, "ready\n", 6);
    (void)close(descriptor);
  }
  usleep(800000);
}

int renameat2(
  int olddirfd,
  const char *oldpath,
  int newdirfd,
  const char *newpath,
  unsigned int flags
) {
  static renameat2_function real_renameat2 = NULL;
  if (real_renameat2 == NULL) {
    real_renameat2 = (renameat2_function)dlsym(RTLD_NEXT, "renameat2");
  }
  pause_before_rename(newpath);
  return real_renameat2(olddirfd, oldpath, newdirfd, newpath, flags);
}
