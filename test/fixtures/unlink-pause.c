#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

typedef int (*unlink_function)(const char *path);
typedef int (*unlinkat_function)(int directory, const char *path, int flags);
typedef int (*rmdir_function)(const char *path);
typedef int (*fsync_function)(int descriptor);
typedef int (*mkdirat_function)(int directory, const char *path, mode_t mode);

static int doctor_probe_cleanup_complete = 0;
static int mkdir_collision_injected = 0;

static int probe_file_path(const char *path) {
  if (path == NULL) return 0;
  if (strcmp(path, "probe") == 0) return 1;
  const char *suffix = strrchr(path, '/');
  return suffix != NULL &&
    strcmp(suffix, "/probe") == 0 &&
    strstr(path, ".taskmux-doctor-native-storage-") != NULL;
}

static int should_pause_for_doctor_probe(const char *path, int flags) {
  if (getenv("TASKMUX_TEST_DOCTOR_PROBE_UNLINK") == NULL ||
      path == NULL) {
    return 0;
  }
  const char *phase = getenv("TASKMUX_TEST_DOCTOR_PROBE_CLEANUP_PHASE");
  if (phase == NULL) return 0;
  if (strcmp(phase, "file") == 0) {
    return (flags & AT_REMOVEDIR) == 0 && probe_file_path(path);
  }
  if (strcmp(phase, "directory") == 0) {
    return (flags & AT_REMOVEDIR) != 0 ||
      (strstr(path, ".taskmux-doctor-native-storage-") != NULL &&
        !probe_file_path(path));
  }
  return 0;
}

static void pause_for_doctor_probe(const char *path, int flags) {
  static int paused = 0;
  if (paused || !should_pause_for_doctor_probe(path, flags)) return;
  paused = 1;
  const char *marker = getenv("TASKMUX_TEST_DOCTOR_PROBE_MARKER");
  if (marker != NULL) {
    int descriptor = open(marker, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (descriptor >= 0) {
      (void)write(descriptor, "ready\n", 6);
      (void)close(descriptor);
    }
  }
  usleep(800000);
}

int unlink(const char *path) {
  static unlink_function real_unlink = NULL;
  if (real_unlink == NULL) real_unlink = (unlink_function)dlsym(RTLD_NEXT, "unlink");
  pause_for_doctor_probe(path, 0);
  return real_unlink(path);
}

int unlinkat(int directory, const char *path, int flags) {
  static unlinkat_function real_unlinkat = NULL;
  if (real_unlinkat == NULL) {
    real_unlinkat = (unlinkat_function)dlsym(RTLD_NEXT, "unlinkat");
  }
  pause_for_doctor_probe(path, flags);
  return real_unlinkat(directory, path, flags);
}

int rmdir(const char *path) {
  static rmdir_function real_rmdir = NULL;
  if (real_rmdir == NULL) real_rmdir = (rmdir_function)dlsym(RTLD_NEXT, "rmdir");
  if (getenv("TASKMUX_TEST_DOCTOR_FAIL_PROBE_RMDIR") != NULL &&
      path != NULL &&
      strstr(path, ".taskmux-doctor-native-storage-") != NULL) {
    errno = EACCES;
    return -1;
  }
  pause_for_doctor_probe(path, AT_REMOVEDIR);
  int result = real_rmdir(path);
  if (result == 0 &&
      path != NULL &&
      strstr(path, ".taskmux-doctor-native-storage-") != NULL) {
    doctor_probe_cleanup_complete = 1;
  }
  return result;
}

int fsync(int descriptor) {
  static fsync_function real_fsync = NULL;
  static int failed = 0;
  if (getenv("TASKMUX_TEST_DOCTOR_FAIL_FIRST_FSYNC") != NULL && !failed) {
    failed = 1;
    errno = EIO;
    return -1;
  }
  if (getenv("TASKMUX_TEST_DOCTOR_FAIL_ROOT_FSYNC_AFTER_CLEANUP") != NULL &&
      doctor_probe_cleanup_complete) {
    errno = EIO;
    return -1;
  }
  if (real_fsync == NULL) real_fsync = (fsync_function)dlsym(RTLD_NEXT, "fsync");
  return real_fsync(descriptor);
}

int mkdirat(int directory, const char *path, mode_t mode) {
  static mkdirat_function real_mkdirat = NULL;
  if (real_mkdirat == NULL) real_mkdirat = (mkdirat_function)dlsym(RTLD_NEXT, "mkdirat");
  if (getenv("TASKMUX_TEST_DOCTOR_COLLIDE_MKDIR") == NULL ||
      mkdir_collision_injected ||
      path == NULL ||
      strstr(path, ".taskmux-doctor-native-storage-") == NULL) {
    return real_mkdirat(directory, path, mode);
  }
  int result = real_mkdirat(directory, path, mode);
  if (result == 0) {
    mkdir_collision_injected = 1;
    errno = EEXIST;
    return -1;
  }
  return result;
}
