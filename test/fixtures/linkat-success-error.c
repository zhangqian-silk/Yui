#define _GNU_SOURCE

#include <dlfcn.h>
#include <errno.h>
#include <stdlib.h>
#include <unistd.h>

typedef int (*linkat_function)(int, const char *, int, const char *, int);

int linkat(
  int old_directory,
  const char *old_path,
  int new_directory,
  const char *new_path,
  int flags
) {
  linkat_function real_linkat = (linkat_function)dlsym(RTLD_NEXT, "linkat");
  if (real_linkat == NULL) {
    errno = EIO;
    return -1;
  }
  int result = real_linkat(
    old_directory,
    old_path,
    new_directory,
    new_path,
    flags
  );
  if (result == 0 && getenv("TASKMUX_TEST_LINKAT_SUCCESS_ERROR") != NULL) {
    errno = EIO;
    return -1;
  }
  return result;
}
