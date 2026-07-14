#include <errno.h>
#include <pwd.h>
#include <stddef.h>
#include <sys/types.h>

struct passwd *getpwuid(uid_t uid) {
  (void)uid;
  errno = EACCES;
  return NULL;
}

int getpwuid_r(
  uid_t uid,
  struct passwd *pwd,
  char *buffer,
  size_t buffer_length,
  struct passwd **result
) {
  (void)uid;
  (void)pwd;
  (void)buffer;
  (void)buffer_length;
  *result = NULL;
  return EACCES;
}
