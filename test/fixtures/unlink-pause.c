#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <sys/types.h>
#include <unistd.h>

typedef int (*unlink_function)(const char *path);
typedef int (*unlinkat_function)(int directory, const char *path, int flags);
typedef int (*rmdir_function)(const char *path);
typedef int (*fsync_function)(int descriptor);
typedef int (*mkdirat_function)(int directory, const char *path, mode_t mode);
typedef int (*lstat_function)(const char *path, struct stat *metadata);
typedef int (*lstat64_function)(const char *path, struct stat64 *metadata);
typedef long (*syscall_function)(long number, ...);
typedef int (*linkat_function)(
  int source_directory,
  const char *source_path,
  int target_directory,
  const char *target_path,
  int flags
);
typedef int (*statx_function)(
  int directory,
  const char *path,
  int flags,
  unsigned int mask,
  struct statx *metadata
);

static int doctor_probe_cleanup_complete = 0;
static int mkdir_collision_injected = 0;

static int procfd_anchor_path(const char *path) {
  const char *prefix = "/proc/self/fd/";
  size_t prefix_length = strlen(prefix);
  if (path == NULL || strncmp(path, prefix, prefix_length) != 0) return 0;
  const char *cursor = path + prefix_length;
  if (*cursor == '\0') return 0;
  while (*cursor >= '0' && *cursor <= '9') cursor++;
  return *cursor == '\0';
}

static int inject_procfd_traversal_failure(const char *path) {
  const char *requested = getenv("TASKMUX_TEST_PROCFD_TRAVERSAL_ERROR");
  if (requested == NULL || !procfd_anchor_path(path)) return 0;
  errno = strcmp(requested, "EACCES") == 0 ? EACCES : ENOENT;
  return 1;
}

static void inject_root_statx_identity(struct statx *metadata) {
  const char *requested = getenv("TASKMUX_TEST_ROOT_IDENTITY_PATH");
  if (requested == NULL) return;
  int saved_errno = errno;
  struct stat requested_metadata;
  struct stat root_metadata;
  if (
    stat(requested, &requested_metadata) != 0 ||
    stat("/", &root_metadata) != 0 ||
    metadata->stx_dev_major != major(requested_metadata.st_dev) ||
    metadata->stx_dev_minor != minor(requested_metadata.st_dev) ||
    metadata->stx_ino != requested_metadata.st_ino
  ) {
    errno = saved_errno;
    return;
  }
  metadata->stx_dev_major = major(root_metadata.st_dev);
  metadata->stx_dev_minor = minor(root_metadata.st_dev);
  metadata->stx_ino = root_metadata.st_ino;
  errno = saved_errno;
}

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

static void pause_for_doctor_root_fsync(void) {
  static int paused = 0;
  if (paused ||
      getenv("TASKMUX_TEST_DOCTOR_PROBE_UNLINK") == NULL ||
      !doctor_probe_cleanup_complete) {
    return;
  }
  const char *phase = getenv("TASKMUX_TEST_DOCTOR_PROBE_CLEANUP_PHASE");
  if (phase == NULL || strcmp(phase, "root-fsync") != 0) return;
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

int lstat(const char *path, struct stat *metadata) {
  static lstat_function real_lstat = NULL;
  if (real_lstat == NULL) real_lstat = (lstat_function)dlsym(RTLD_NEXT, "lstat");
  if (inject_procfd_traversal_failure(path)) return -1;
  return real_lstat(path, metadata);
}

int lstat64(const char *path, struct stat64 *metadata) {
  static lstat64_function real_lstat64 = NULL;
  if (real_lstat64 == NULL) {
    real_lstat64 = (lstat64_function)dlsym(RTLD_NEXT, "lstat64");
  }
  if (inject_procfd_traversal_failure(path)) return -1;
  return real_lstat64(path, metadata);
}

long syscall(long number, ...) {
  static syscall_function real_syscall = NULL;
  if (real_syscall == NULL) {
    real_syscall = (syscall_function)dlsym(RTLD_NEXT, "syscall");
  }
  va_list arguments;
  va_start(arguments, number);
  long argument1 = va_arg(arguments, long);
  long argument2 = va_arg(arguments, long);
  long argument3 = va_arg(arguments, long);
  long argument4 = va_arg(arguments, long);
  long argument5 = va_arg(arguments, long);
  long argument6 = va_arg(arguments, long);
  va_end(arguments);
#if defined(SYS_statx)
  if (number == SYS_statx && inject_procfd_traversal_failure((const char *)argument2)) {
    return -1;
  }
#endif
  long result = real_syscall(
    number,
    argument1,
    argument2,
    argument3,
    argument4,
    argument5,
    argument6
  );
#if defined(SYS_statx)
  if (result == 0 && number == SYS_statx) {
    inject_root_statx_identity((struct statx *)argument5);
  }
#endif
  return result;
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
  pause_for_doctor_root_fsync();
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

int linkat(
  int source_directory,
  const char *source_path,
  int target_directory,
  const char *target_path,
  int flags
) {
  static linkat_function real_linkat = NULL;
  if (real_linkat == NULL) real_linkat = (linkat_function)dlsym(RTLD_NEXT, "linkat");
  if (getenv("TASKMUX_TEST_DOCTOR_FAIL_PROCFD_LINK") != NULL &&
      source_path != NULL &&
      strncmp(source_path, "/proc/self/fd/", strlen("/proc/self/fd/")) == 0) {
    errno = ENOENT;
    return -1;
  }
  return real_linkat(
    source_directory,
    source_path,
    target_directory,
    target_path,
    flags
  );
}

int statx(
  int directory,
  const char *path,
  int flags,
  unsigned int mask,
  struct statx *metadata
) {
  static statx_function real_statx = NULL;
  if (real_statx == NULL) real_statx = (statx_function)dlsym(RTLD_NEXT, "statx");
  if (inject_procfd_traversal_failure(path)) return -1;
  if (mask == STATX_BTIME) {
    if (getenv("TASKMUX_TEST_DOCTOR_FAIL_STATX_BTIME") != NULL) {
      errno = EOPNOTSUPP;
      return -1;
    }
    if (getenv("TASKMUX_TEST_DOCTOR_FAIL_STATX_ENOENT") != NULL) {
      errno = ENOENT;
      return -1;
    }
    if (getenv("TASKMUX_TEST_DOCTOR_FAIL_STATX_ENOSYS") != NULL) {
      errno = ENOSYS;
      return -1;
    }
  }
  return real_statx(directory, path, flags, mask, metadata);
}
