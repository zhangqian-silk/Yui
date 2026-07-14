#define _GNU_SOURCE

#include <dlfcn.h>
#include <errno.h>
#include <stdlib.h>
#include <sys/file.h>

typedef int (*flock_function)(int, int);

int flock(int descriptor, int operation) {
  flock_function real_flock = (flock_function)dlsym(RTLD_NEXT, "flock");
  if (real_flock == NULL) {
    errno = EIO;
    return -1;
  }
  if ((operation & LOCK_UN) != 0 && getenv("TASKMUX_TEST_FLOCK_UNLOCK_ERROR") != NULL) {
    errno = EIO;
    return -1;
  }
  return real_flock(descriptor, operation);
}
