#include <node_api.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/fs.h>
#include <linux/openat2.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

extern int renameat2(
  int olddirfd,
  const char *oldpath,
  int newdirfd,
  const char *newpath,
  unsigned int flags
) __attribute__((weak));

#define TASKMUX_PRIVATE_FILE_MODE 0600U
#define TASKMUX_PRIVATE_DIRECTORY_MODE 0700U
#define TASKMUX_MAX_PUBLICATION_BYTES (64U * 1024U * 1024U)
#define TASKMUX_MAX_READ_BYTES (64U * 1024U * 1024U)

#if defined(SYS_openat2)
#define TASKMUX_OPENAT2_SYSCALL SYS_openat2
#elif defined(__NR_openat2)
#define TASKMUX_OPENAT2_SYSCALL __NR_openat2
#elif defined(__x86_64__) || defined(__aarch64__)
/* Linux reserves openat2 as syscall 437 on both TaskMux-supported architectures. */
#define TASKMUX_OPENAT2_SYSCALL 437
#endif

typedef struct {
  int number;
  const char *stage;
  const char *state;
} storage_error;

typedef struct {
  uint64_t dev;
  uint64_t ino;
  uint64_t uid;
  uint64_t mode;
  uint64_t nlink;
  uint64_t birthtime_ns;
} exact_identity;

typedef struct {
  exact_identity identity;
  uint64_t size;
} exact_receipt;

typedef struct {
  int descriptor;
  pid_t owner_pid;
  bool active;
  int lock_mode;
  exact_identity identity;
} stable_ancestor_barrier;

typedef struct {
  int descriptor;
  pid_t owner_pid;
  bool active;
  exact_identity identity;
} pinned_directory;

static const napi_type_tag STABLE_ANCESTOR_BARRIER_TAG = {
  0x51cf70f1a8a5d6f2ULL,
  0x8dc11a687d3ad8c1ULL
};

static const napi_type_tag PINNED_DIRECTORY_TAG = {
  0x2f10b530be2eaa9cULL,
  0x9ea52d933db7f207ULL
};

static const char *errno_code(int number) {
  switch (number) {
    case EACCES: return "EACCES";
    case EAGAIN: return "EWOULDBLOCK";
    case EBADF: return "EBADF";
    case EEXIST: return "EEXIST";
    case EFBIG: return "EFBIG";
    case EINVAL: return "EINVAL";
    case EIO: return "EIO";
    case EISDIR: return "EISDIR";
    case ELOOP: return "ELOOP";
    case EMFILE: return "EMFILE";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case ENFILE: return "ENFILE";
    case ENOENT: return "ENOENT";
    case ENOMEM: return "ENOMEM";
    case ENOSPC: return "ENOSPC";
    case ENOSYS: return "ENOTSUP";
    case ENOTDIR: return "ENOTDIR";
    case EOPNOTSUPP: return "ENOTSUP";
    case EPERM: return "EPERM";
    case EROFS: return "EROFS";
    case ESTALE: return "ESTALE";
    default: return "ERR_NATIVE_STORAGE";
  }
}

static napi_status define_readonly_value(
  napi_env env,
  napi_value object,
  const char *name,
  napi_value value
) {
  napi_property_descriptor property = {
    .utf8name = name,
    .name = NULL,
    .method = NULL,
    .getter = NULL,
    .setter = NULL,
    .value = value,
    .attributes = napi_enumerable,
    .data = NULL
  };
  return napi_define_properties(env, object, 1, &property);
}

static napi_status define_readonly_string(
  napi_env env,
  napi_value object,
  const char *name,
  const char *value
) {
  napi_value string;
  napi_status status = napi_create_string_utf8(
    env,
    value,
    NAPI_AUTO_LENGTH,
    &string
  );
  if (status != napi_ok) return status;
  return define_readonly_value(env, object, name, string);
}

static napi_value throw_structured_error(
  napi_env env,
  const char *kind,
  const char *prefix,
  storage_error error
) {
  char message[640];
  (void)snprintf(
    message,
    sizeof(message),
    "%s failed at %s (%s): %s",
    prefix,
    error.stage,
    error.state,
    strerror(error.number)
  );

  napi_value code;
  napi_value message_value;
  napi_value exception;
  napi_value errno_value;
  napi_status status = napi_create_string_utf8(
    env,
    errno_code(error.number),
    NAPI_AUTO_LENGTH,
    &code
  );
  if (status == napi_ok) {
    status = napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value);
  }
  if (status == napi_ok) status = napi_create_error(env, code, message_value, &exception);
  if (status == napi_ok) status = define_readonly_string(env, exception, "kind", kind);
  if (status == napi_ok) status = define_readonly_string(env, exception, "stage", error.stage);
  if (status == napi_ok) status = define_readonly_string(env, exception, "state", error.state);
  if (status == napi_ok) status = napi_create_int32(env, error.number, &errno_value);
  if (status == napi_ok) {
    status = define_readonly_value(env, exception, "errno", errno_value);
  }
  if (status == napi_ok) {
    napi_throw(env, exception);
    return NULL;
  }

  bool pending = false;
  (void)napi_is_exception_pending(env, &pending);
  if (!pending) napi_throw_error(env, "ERR_NATIVE_STORAGE", message);
  return NULL;
}

static napi_value throw_barrier_error(napi_env env, storage_error error) {
  return throw_structured_error(
    env,
    "native-stable-ancestor-barrier",
    "Native stable ancestor barrier",
    error
  );
}

static napi_value throw_read_error(napi_env env, storage_error error) {
  return throw_structured_error(
    env,
    "native-anchored-read",
    "Native anchored read",
    error
  );
}

static napi_value throw_publication_error(napi_env env, storage_error error) {
  return throw_structured_error(
    env,
    "external-publication",
    "External publication",
    error
  );
}

static napi_value throw_type_error(napi_env env, const char *message) {
  napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", message);
  return NULL;
}

static int exact_nonnegative_int(napi_env env, napi_value value, int *result) {
  double number;
  if (napi_get_value_double(env, value, &number) != napi_ok ||
      number != number || number < 0.0 || number > (double)INT_MAX) {
    return 0;
  }
  int converted = (int)number;
  if ((double)converted != number) return 0;
  *result = converted;
  return 1;
}

static int exact_nonnegative_size(
  napi_env env,
  napi_value value,
  size_t maximum,
  size_t *result
) {
  double number;
  if (napi_get_value_double(env, value, &number) != napi_ok ||
      number != number || number < 0.0 || number > (double)maximum) {
    return 0;
  }
  size_t converted = (size_t)number;
  if ((double)converted != number) return 0;
  *result = converted;
  return 1;
}

static int duplicate_cloexec(int descriptor) {
  int duplicated;
  do {
    duplicated = fcntl(descriptor, F_DUPFD_CLOEXEC, 3);
  } while (duplicated < 0 && errno == EINTR);
  return duplicated;
}

static int descriptor_birthtime_ns(int descriptor, uint64_t *birthtime_ns) {
#if !defined(__linux__) || !defined(STATX_BTIME)
  (void)descriptor;
  (void)birthtime_ns;
  errno = EOPNOTSUPP;
  return -1;
#else
  struct statx identity;
  memset(&identity, 0, sizeof(identity));
  if (statx(
        descriptor,
        "",
        AT_EMPTY_PATH | AT_STATX_SYNC_AS_STAT,
        STATX_BTIME,
        &identity
      ) != 0) {
    return -1;
  }
  if ((identity.stx_mask & STATX_BTIME) == 0 ||
      identity.stx_btime.tv_sec < 0 ||
      identity.stx_btime.tv_nsec > 999999999U ||
      (uint64_t)identity.stx_btime.tv_sec >
        (UINT64_MAX - (uint64_t)identity.stx_btime.tv_nsec) / 1000000000ULL) {
    errno = EOPNOTSUPP;
    return -1;
  }
  *birthtime_ns = (uint64_t)identity.stx_btime.tv_sec * 1000000000ULL +
    (uint64_t)identity.stx_btime.tv_nsec;
  return 0;
#endif
}

static int capture_identity(
  int descriptor,
  struct stat *metadata,
  uint64_t *birthtime_ns
) {
  if (fstat(descriptor, metadata) != 0) return -1;
  return descriptor_birthtime_ns(descriptor, birthtime_ns);
}

static int stat_matches_identity(
  const struct stat *actual,
  uint64_t birthtime_ns,
  const exact_identity *expected,
  int required_type
) {
  if (required_type == S_IFDIR && !S_ISDIR(actual->st_mode)) return 0;
  if (required_type == S_IFREG && !S_ISREG(actual->st_mode)) return 0;
  return actual->st_uid == geteuid() &&
    (uint64_t)actual->st_dev == expected->dev &&
    (uint64_t)actual->st_ino == expected->ino &&
    (uint64_t)actual->st_uid == expected->uid &&
    (uint64_t)actual->st_mode == expected->mode &&
    (uint64_t)actual->st_nlink == expected->nlink &&
    birthtime_ns == expected->birthtime_ns;
}

static int stat_matches_receipt(
  const struct stat *actual,
  uint64_t birthtime_ns,
  const exact_receipt *expected
) {
  return stat_matches_identity(
    actual,
    birthtime_ns,
    &expected->identity,
    S_IFREG
  ) &&
    actual->st_size >= 0 &&
    (uint64_t)actual->st_size == expected->size;
}

static int same_regular_file(
  const struct stat *left,
  const struct stat *right
) {
  return S_ISREG(left->st_mode) &&
    S_ISREG(right->st_mode) &&
    left->st_dev == right->st_dev &&
    left->st_ino == right->st_ino &&
    left->st_uid == right->st_uid &&
    left->st_size == right->st_size;
}

static int private_regular_file(const struct stat *metadata) {
  return S_ISREG(metadata->st_mode) &&
    metadata->st_uid == geteuid() &&
    ((uint32_t)metadata->st_mode & 0777U) == TASKMUX_PRIVATE_FILE_MODE &&
    metadata->st_size >= 0;
}

static int read_own_bigint_property(
  napi_env env,
  napi_value object,
  const char *name,
  uint64_t *result
) {
  napi_value key;
  napi_value value;
  bool has_own = false;
  bool lossless = false;
  if (napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &key) != napi_ok ||
      napi_has_own_property(env, object, key, &has_own) != napi_ok || !has_own ||
      napi_get_property(env, object, key, &value) != napi_ok ||
      napi_get_value_bigint_uint64(env, value, result, &lossless) != napi_ok || !lossless) {
    return 0;
  }
  return 1;
}

static int read_expected_identity(
  napi_env env,
  napi_value value,
  exact_identity *identity
) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_object) return 0;
  return read_own_bigint_property(env, value, "dev", &identity->dev) &&
    read_own_bigint_property(env, value, "ino", &identity->ino) &&
    read_own_bigint_property(env, value, "uid", &identity->uid) &&
    read_own_bigint_property(env, value, "mode", &identity->mode) &&
    read_own_bigint_property(env, value, "nlink", &identity->nlink) &&
    read_own_bigint_property(env, value, "birthtimeNs", &identity->birthtime_ns);
}

static int read_expected_receipt(
  napi_env env,
  napi_value value,
  exact_receipt *receipt
) {
  return read_expected_identity(env, value, &receipt->identity) &&
    read_own_bigint_property(env, value, "size", &receipt->size);
}

static napi_status create_null_object(napi_env env, napi_value *result) {
  napi_value script;
  napi_status status = napi_create_string_utf8(
    env,
    "({__proto__:null})",
    NAPI_AUTO_LENGTH,
    &script
  );
  if (status == napi_ok) status = napi_run_script(env, script, result);
  return status;
}

static napi_status create_identity_result(
  napi_env env,
  const struct stat *metadata,
  uint64_t birthtime_ns,
  napi_value *result
) {
  napi_status status = create_null_object(env, result);
  napi_value value;
  if (status == napi_ok) {
    status = napi_create_bigint_uint64(env, (uint64_t)metadata->st_dev, &value);
  }
  if (status == napi_ok) status = define_readonly_value(env, *result, "dev", value);
  if (status == napi_ok) {
    status = napi_create_bigint_uint64(env, (uint64_t)metadata->st_ino, &value);
  }
  if (status == napi_ok) status = define_readonly_value(env, *result, "ino", value);
  if (status == napi_ok) {
    status = napi_create_bigint_uint64(env, (uint64_t)metadata->st_uid, &value);
  }
  if (status == napi_ok) status = define_readonly_value(env, *result, "uid", value);
  if (status == napi_ok) {
    status = napi_create_bigint_uint64(env, (uint64_t)metadata->st_mode, &value);
  }
  if (status == napi_ok) status = define_readonly_value(env, *result, "mode", value);
  if (status == napi_ok) {
    status = napi_create_bigint_uint64(env, (uint64_t)metadata->st_nlink, &value);
  }
  if (status == napi_ok) status = define_readonly_value(env, *result, "nlink", value);
  if (status == napi_ok) {
    status = napi_create_bigint_uint64(env, birthtime_ns, &value);
  }
  if (status == napi_ok) status = define_readonly_value(env, *result, "birthtimeNs", value);
  return status;
}

static napi_status create_receipt_result(
  napi_env env,
  const struct stat *metadata,
  uint64_t birthtime_ns,
  napi_value *result
) {
  napi_status status = create_identity_result(env, metadata, birthtime_ns, result);
  napi_value value;
  if (status == napi_ok) {
    status = napi_create_bigint_uint64(env, (uint64_t)metadata->st_size, &value);
  }
  if (status == napi_ok) status = define_readonly_value(env, *result, "size", value);
  if (status == napi_ok) status = napi_object_freeze(env, *result);
  return status;
}

static int valid_basename(const char *name, size_t length) {
  if (length == 0 || length > NAME_MAX || memchr(name, '\0', length) != NULL) return 0;
  if ((length == 1 && name[0] == '.') ||
      (length == 2 && name[0] == '.' && name[1] == '.')) {
    return 0;
  }
  for (size_t index = 0; index < length; index += 1) {
    if (name[index] == '/') return 0;
  }
  return 1;
}

static int valid_relative_path(const char *path, size_t length) {
  if (length == 0 || memchr(path, '\0', length) != NULL) return 0;
  if (length == 1 && path[0] == '.') return 1;
  if (path[0] == '/' || path[length - 1] == '/') return 0;
  size_t segment_start = 0;
  for (size_t index = 0; index <= length; index += 1) {
    if (index != length && path[index] != '/') continue;
    size_t segment_length = index - segment_start;
    if (segment_length == 0 ||
        (segment_length == 1 && path[segment_start] == '.') ||
        (segment_length == 2 && path[segment_start] == '.' &&
          path[segment_start + 1] == '.')) {
      return 0;
    }
    segment_start = index + 1;
  }
  return 1;
}

static int copy_string_argument(
  napi_env env,
  napi_value value,
  char **result,
  size_t *length
) {
  size_t measured = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &measured) != napi_ok) return 0;
  char *copy = malloc(measured + 1U);
  if (copy == NULL) {
    errno = ENOMEM;
    return -1;
  }
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, copy, measured + 1U, &copied) != napi_ok ||
      copied != measured) {
    free(copy);
    return 0;
  }
  *result = copy;
  *length = measured;
  return 1;
}

static int write_all(int descriptor, const unsigned char *bytes, size_t length) {
  size_t written = 0;
  while (written < length) {
    ssize_t result = write(descriptor, bytes + written, length - written);
    if (result > 0) {
      written += (size_t)result;
      continue;
    }
    if (result < 0 && errno == EINTR) continue;
    if (result == 0) errno = EIO;
    return -1;
  }
  return 0;
}

static int read_all(int descriptor, unsigned char *bytes, size_t length) {
  size_t read_count = 0;
  while (read_count < length) {
    ssize_t result = read(descriptor, bytes + read_count, length - read_count);
    if (result > 0) {
      read_count += (size_t)result;
      continue;
    }
    if (result < 0 && errno == EINTR) continue;
    errno = result == 0 ? EIO : errno;
    return -1;
  }
  return 0;
}

static int flock_eintr(int descriptor, int operation) {
  int result;
  do {
    result = flock(descriptor, operation);
  } while (result != 0 && errno == EINTR);
  return result;
}

static int openat2_beneath(int parent_descriptor, const char *path, int flags) {
#if defined(__linux__) && defined(TASKMUX_OPENAT2_SYSCALL)
  struct open_how how;
  memset(&how, 0, sizeof(how));
  how.flags = (uint64_t)(flags | O_CLOEXEC | O_NOFOLLOW);
  how.resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS |
    RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV;
  long result;
  do {
    result = syscall(
      TASKMUX_OPENAT2_SYSCALL,
      parent_descriptor,
      path,
      &how,
      sizeof(how)
    );
  } while (result < 0 && errno == EINTR);
  if (result < 0 && errno == ENOSYS) errno = EOPNOTSUPP;
  return (int)result;
#else
  (void)parent_descriptor;
  (void)path;
  (void)flags;
  errno = EOPNOTSUPP;
  return -1;
#endif
}

static int renameat2_noreplace(
  int source_parent,
  const char *source_name,
  int target_parent,
  const char *target_name
) {
  if (renameat2 != NULL) {
    int result;
    do {
      result = renameat2(
        source_parent,
        source_name,
        target_parent,
        target_name,
        RENAME_NOREPLACE
      );
    } while (result != 0 && errno == EINTR);
    return result;
  }
#if defined(__linux__) && defined(SYS_renameat2)
  long result;
  do {
    result = syscall(
      SYS_renameat2,
      source_parent,
      source_name,
      target_parent,
      target_name,
      RENAME_NOREPLACE
    );
  } while (result < 0 && errno == EINTR);
  if (result < 0 && errno == ENOSYS) errno = EOPNOTSUPP;
  return (int)result;
#else
  (void)source_parent;
  (void)source_name;
  (void)target_parent;
  (void)target_name;
  errno = EOPNOTSUPP;
  return -1;
#endif
}

static int link_pinned_fd_no_replace(
  int source_descriptor,
  int parent_descriptor,
  const char *target_name
) {
  char source_path[64];
  int length = snprintf(
    source_path,
    sizeof(source_path),
    "/proc/self/fd/%d",
    source_descriptor
  );
  if (length <= 0 || (size_t)length >= sizeof(source_path)) {
    errno = ENAMETOOLONG;
    return -1;
  }
  return linkat(
    AT_FDCWD,
    source_path,
    parent_descriptor,
    target_name,
    AT_SYMLINK_FOLLOW
  );
}

static void finalize_stable_ancestor_barrier(
  napi_env env,
  void *data,
  void *hint
) {
  (void)env;
  (void)hint;
  stable_ancestor_barrier *barrier = data;
  if (barrier == NULL) return;
  if (barrier->active) {
    if (barrier->owner_pid == getpid()) {
      (void)flock_eintr(barrier->descriptor, LOCK_UN);
    }
    (void)close(barrier->descriptor);
    barrier->active = false;
  }
  free(barrier);
}

static void finalize_pinned_directory(
  napi_env env,
  void *data,
  void *hint
) {
  (void)env;
  (void)hint;
  pinned_directory *directory = data;
  if (directory == NULL) return;
  if (directory->active) {
    (void)close(directory->descriptor);
    directory->active = false;
  }
  free(directory);
}

static int unwrap_barrier(
  napi_env env,
  napi_value value,
  bool require_exclusive,
  stable_ancestor_barrier **result
) {
  bool tagged = false;
  if (napi_check_object_type_tag(
        env,
        value,
        &STABLE_ANCESTOR_BARRIER_TAG,
        &tagged
      ) != napi_ok || !tagged) {
    (void)throw_type_error(env, "Expected active native stable-ancestor barrier.");
    return 0;
  }
  stable_ancestor_barrier *barrier = NULL;
  if (napi_unwrap(env, value, (void **)&barrier) != napi_ok || barrier == NULL ||
      !barrier->active) {
    (void)throw_type_error(env, "Expected active native stable-ancestor barrier.");
    return 0;
  }
  if (barrier->owner_pid != getpid()) {
    (void)throw_barrier_error(env, (storage_error){
      EPERM, "use-after-fork", "indeterminate"
    });
    return 0;
  }
  if (require_exclusive && barrier->lock_mode != LOCK_EX) {
    (void)throw_publication_error(env, (storage_error){
      EACCES, "require-exclusive-barrier", "not-published"
    });
    return 0;
  }
  *result = barrier;
  return 1;
}

static int unwrap_pinned_directory(
  napi_env env,
  napi_value value,
  pinned_directory **result
) {
  bool tagged = false;
  if (napi_check_object_type_tag(
        env,
        value,
        &PINNED_DIRECTORY_TAG,
        &tagged
      ) != napi_ok || !tagged) {
    (void)throw_type_error(env, "Expected active native pinned directory.");
    return 0;
  }
  pinned_directory *directory = NULL;
  if (napi_unwrap(env, value, (void **)&directory) != napi_ok || directory == NULL ||
      !directory->active) {
    (void)throw_type_error(env, "Expected active native pinned directory.");
    return 0;
  }
  if (directory->owner_pid != getpid()) {
    (void)throw_read_error(env, (storage_error){
      EPERM, "use-after-fork", "indeterminate"
    });
    return 0;
  }
  *result = directory;
  return 1;
}

static int open_directory_from_barrier(
  stable_ancestor_barrier *barrier,
  const char *relative_path,
  const exact_identity *expected,
  int *descriptor
) {
  int opened;
  if (strcmp(relative_path, ".") == 0) {
    opened = duplicate_cloexec(barrier->descriptor);
  } else {
    opened = openat2_beneath(
      barrier->descriptor,
      relative_path,
      O_RDONLY | O_DIRECTORY
    );
  }
  if (opened < 0) return -1;

  struct stat metadata;
  uint64_t birthtime_ns = 0;
  if (capture_identity(opened, &metadata, &birthtime_ns) != 0 ||
      !stat_matches_identity(&metadata, birthtime_ns, expected, S_IFDIR)) {
    int number = errno == 0 ? ESTALE : errno;
    (void)close(opened);
    errno = number;
    return -1;
  }
  *descriptor = opened;
  return 0;
}

static int open_directory_unchecked(
  int parent_descriptor,
  const char *relative_path,
  int *descriptor,
  struct stat *metadata,
  uint64_t *birthtime_ns
) {
  int opened;
  if (strcmp(relative_path, ".") == 0) {
    opened = duplicate_cloexec(parent_descriptor);
  } else {
    opened = openat2_beneath(
      parent_descriptor,
      relative_path,
      O_RDONLY | O_DIRECTORY
    );
  }
  if (opened < 0) return -1;
  if (capture_identity(opened, metadata, birthtime_ns) != 0 ||
      !S_ISDIR(metadata->st_mode) || metadata->st_uid != geteuid()) {
    int number = errno == 0 ? EACCES : errno;
    (void)close(opened);
    errno = number;
    return -1;
  }
  *descriptor = opened;
  return 0;
}

static int open_regular_unchecked(
  int parent_descriptor,
  const char *relative_path,
  int *descriptor,
  struct stat *metadata,
  uint64_t *birthtime_ns
) {
  int opened = openat2_beneath(parent_descriptor, relative_path, O_RDONLY);
  if (opened < 0) return -1;
  if (capture_identity(opened, metadata, birthtime_ns) != 0 ||
      !S_ISREG(metadata->st_mode) || metadata->st_uid != geteuid()) {
    int number = errno == 0 ? EACCES : errno;
    (void)close(opened);
    errno = number;
    return -1;
  }
  *descriptor = opened;
  return 0;
}

static int open_regular_basename(
  int parent_descriptor,
  const char *name,
  int *descriptor,
  struct stat *metadata,
  uint64_t *birthtime_ns
) {
  int opened;
  do {
    opened = openat(
      parent_descriptor,
      name,
      O_RDONLY | O_CLOEXEC | O_NOFOLLOW
    );
  } while (opened < 0 && errno == EINTR);
  if (opened < 0) return -1;
  if (capture_identity(opened, metadata, birthtime_ns) != 0 ||
      !S_ISREG(metadata->st_mode) || metadata->st_uid != geteuid()) {
    int number = errno == 0 ? EACCES : errno;
    (void)close(opened);
    errno = number;
    return -1;
  }
  *descriptor = opened;
  return 0;
}

static int open_expected_regular(
  int parent_descriptor,
  const char *name,
  const exact_receipt *expected,
  int *descriptor,
  struct stat *metadata,
  uint64_t *birthtime_ns
) {
  if (open_regular_basename(
        parent_descriptor,
        name,
        descriptor,
        metadata,
        birthtime_ns
      ) != 0) {
    return -1;
  }
  if (!stat_matches_receipt(metadata, *birthtime_ns, expected) ||
      !private_regular_file(metadata)) {
    (void)close(*descriptor);
    *descriptor = -1;
    errno = ESTALE;
    return -1;
  }
  return 0;
}

static int open_expected_entry(
  int parent_descriptor,
  const char *name,
  const exact_receipt *expected,
  bool require_directory,
  int *descriptor,
  struct stat *metadata,
  uint64_t *birthtime_ns
) {
  int opened = openat2_beneath(parent_descriptor, name, O_PATH);
  if (opened < 0) return -1;
  if (capture_identity(opened, metadata, birthtime_ns) != 0 ||
      !stat_matches_identity(
        metadata,
        *birthtime_ns,
        &expected->identity,
        require_directory ? S_IFDIR : S_IFREG
      ) ||
      (!require_directory && (
        metadata->st_size < 0 || (uint64_t)metadata->st_size != expected->size
      ))) {
    int number = errno == 0 ? ESTALE : errno;
    (void)close(opened);
    errno = number;
    return -1;
  }
  *descriptor = opened;
  return 0;
}

static int create_stable_barrier_handle(
  napi_env env,
  stable_ancestor_barrier *barrier,
  napi_value *result
) {
  napi_status status = napi_create_object(env, result);
  if (status == napi_ok) {
    status = napi_type_tag_object(env, *result, &STABLE_ANCESTOR_BARRIER_TAG);
  }
  if (status == napi_ok) {
    status = napi_wrap(
      env,
      *result,
      barrier,
      finalize_stable_ancestor_barrier,
      NULL,
      NULL
    );
  }
  if (status == napi_ok) status = napi_object_freeze(env, *result);
  return status == napi_ok;
}

static int create_pinned_directory_handle(
  napi_env env,
  pinned_directory *directory,
  napi_value *result
) {
  napi_status status = napi_create_object(env, result);
  if (status == napi_ok) {
    status = napi_type_tag_object(env, *result, &PINNED_DIRECTORY_TAG);
  }
  if (status == napi_ok) {
    status = napi_wrap(
      env,
      *result,
      directory,
      finalize_pinned_directory,
      NULL,
      NULL
    );
  }
  if (status == napi_ok) status = napi_object_freeze(env, *result);
  return status == napi_ok;
}

static napi_value inspect_directory_descriptor(
  napi_env env,
  napi_callback_info info
) {
  size_t argument_count = 1;
  napi_value arguments[1];
  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok ||
      argument_count != 1) {
    return throw_type_error(env, "Expected an inherited directory descriptor.");
  }

  int descriptor;
  if (!exact_nonnegative_int(env, arguments[0], &descriptor) ||
      descriptor <= STDERR_FILENO) {
    return throw_type_error(
      env,
      "directory descriptor must be an inherited non-stdio file descriptor."
    );
  }

  struct stat metadata;
  uint64_t birthtime_ns = 0;
  if (capture_identity(descriptor, &metadata, &birthtime_ns) != 0) {
    return throw_barrier_error(env, (storage_error){
      errno, "stat-ancestor", "not-acquired"
    });
  }
  if (!S_ISDIR(metadata.st_mode) || metadata.st_uid != geteuid()) {
    return throw_barrier_error(env, (storage_error){
      ESTALE, "verify-ancestor", "not-acquired"
    });
  }

  napi_value result;
  if (create_identity_result(env, &metadata, birthtime_ns, &result) != napi_ok) {
    bool pending = false;
    (void)napi_is_exception_pending(env, &pending);
    if (!pending) {
      napi_throw_error(
        env,
        "ERR_NATIVE_STORAGE_IDENTITY",
        "Could not inspect the exact native directory identity."
      );
    }
    return NULL;
  }
  return result;
}

static napi_value acquire_stable_ancestor_barrier(
  napi_env env,
  napi_callback_info info,
  int lock_mode
) {
  size_t argument_count = 2;
  napi_value arguments[2];
  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok ||
      argument_count != 2) {
    return throw_type_error(env, "Expected ancestor descriptor and exact directory identity.");
  }

  int input_descriptor;
  if (!exact_nonnegative_int(env, arguments[0], &input_descriptor) ||
      input_descriptor <= STDERR_FILENO) {
    return throw_type_error(
      env,
      "ancestor descriptor must be an inherited non-stdio file descriptor."
    );
  }
  exact_identity expected;
  if (!read_expected_identity(env, arguments[1], &expected)) {
    return throw_type_error(
      env,
      "expected ancestor identity must contain exact BigInt dev, ino, uid, mode, nlink, and birthtimeNs."
    );
  }

  struct stat before;
  struct stat duplicated;
  struct stat locked;
  uint64_t before_birthtime_ns = 0;
  uint64_t duplicated_birthtime_ns = 0;
  uint64_t locked_birthtime_ns = 0;
  if (capture_identity(input_descriptor, &before, &before_birthtime_ns) != 0) {
    return throw_barrier_error(env, (storage_error){
      errno, "stat-ancestor", "not-acquired"
    });
  }
  if (!stat_matches_identity(&before, before_birthtime_ns, &expected, S_IFDIR)) {
    return throw_barrier_error(env, (storage_error){
      ESTALE, "verify-ancestor", "not-acquired"
    });
  }

  stable_ancestor_barrier *barrier = calloc(1, sizeof(*barrier));
  if (barrier == NULL) {
    return throw_barrier_error(env, (storage_error){
      ENOMEM, "allocate-barrier", "not-acquired"
    });
  }
  barrier->descriptor = duplicate_cloexec(input_descriptor);
  barrier->owner_pid = getpid();
  barrier->lock_mode = lock_mode;
  barrier->identity = expected;
  if (barrier->descriptor < 0) {
    int number = errno;
    free(barrier);
    return throw_barrier_error(env, (storage_error){
      number, "duplicate-ancestor", "not-acquired"
    });
  }
  if (capture_identity(
        barrier->descriptor,
        &duplicated,
        &duplicated_birthtime_ns
      ) != 0 ||
      !stat_matches_identity(
        &duplicated,
        duplicated_birthtime_ns,
        &expected,
        S_IFDIR
      )) {
    int number = errno == 0 ? ESTALE : errno;
    (void)close(barrier->descriptor);
    free(barrier);
    return throw_barrier_error(env, (storage_error){
      number, "verify-duplicate", "not-acquired"
    });
  }
  if (flock_eintr(barrier->descriptor, lock_mode | LOCK_NB) != 0) {
    int number = errno;
    (void)close(barrier->descriptor);
    free(barrier);
    return throw_barrier_error(env, (storage_error){
      number, "flock", "not-acquired"
    });
  }
  barrier->active = true;
  if (capture_identity(barrier->descriptor, &locked, &locked_birthtime_ns) != 0 ||
      !stat_matches_identity(&locked, locked_birthtime_ns, &expected, S_IFDIR)) {
    int number = errno == 0 ? ESTALE : errno;
    (void)flock_eintr(barrier->descriptor, LOCK_UN);
    (void)close(barrier->descriptor);
    free(barrier);
    return throw_barrier_error(env, (storage_error){
      number, "verify-locked", "not-acquired"
    });
  }

  napi_value result;
  if (!create_stable_barrier_handle(env, barrier, &result)) {
    finalize_stable_ancestor_barrier(env, barrier, NULL);
    bool pending = false;
    (void)napi_is_exception_pending(env, &pending);
    if (!pending) {
      napi_throw_error(
        env,
        "ERR_NATIVE_BARRIER_EVIDENCE",
        "Could not create opaque stable-ancestor barrier evidence."
      );
    }
    return NULL;
  }
  return result;
}

static napi_value acquire_stable_ancestor_shared_barrier(
  napi_env env,
  napi_callback_info info
) {
  return acquire_stable_ancestor_barrier(env, info, LOCK_SH);
}

static napi_value acquire_stable_ancestor_exclusive_barrier(
  napi_env env,
  napi_callback_info info
) {
  return acquire_stable_ancestor_barrier(env, info, LOCK_EX);
}

static napi_value release_stable_ancestor_barrier(
  napi_env env,
  napi_callback_info info
) {
  size_t argument_count = 1;
  napi_value argument;
  if (napi_get_cb_info(env, info, &argument_count, &argument, NULL, NULL) != napi_ok ||
      argument_count != 1) {
    return throw_type_error(env, "Expected native stable-ancestor barrier.");
  }
  bool tagged = false;
  if (napi_check_object_type_tag(
        env,
        argument,
        &STABLE_ANCESTOR_BARRIER_TAG,
        &tagged
      ) != napi_ok || !tagged) {
    return throw_type_error(env, "Expected native stable-ancestor barrier.");
  }
  stable_ancestor_barrier *barrier = NULL;
  if (napi_unwrap(env, argument, (void **)&barrier) != napi_ok || barrier == NULL) {
    return throw_type_error(env, "Expected native stable-ancestor barrier.");
  }
  if (!barrier->active) {
    napi_value undefined;
    napi_get_undefined(env, &undefined);
    return undefined;
  }
  if (barrier->owner_pid != getpid()) {
    (void)close(barrier->descriptor);
    barrier->active = false;
    barrier->descriptor = -1;
    return throw_barrier_error(env, (storage_error){
      EPERM, "release-after-fork", "indeterminate"
    });
  }
  if (flock_eintr(barrier->descriptor, LOCK_UN) != 0) {
    int number = errno;
    (void)close(barrier->descriptor);
    barrier->active = false;
    barrier->descriptor = -1;
    return throw_barrier_error(env, (storage_error){
      number, "unlock", "indeterminate"
    });
  }
  if (close(barrier->descriptor) != 0) {
    int number = errno;
    barrier->active = false;
    barrier->descriptor = -1;
    return throw_barrier_error(env, (storage_error){
      number, "close-barrier", "released"
    });
  }
  barrier->active = false;
  barrier->descriptor = -1;
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value inspect_directory_at(
  napi_env env,
  napi_callback_info info
) {
  size_t argument_count = 2;
  napi_value arguments[2];
  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok ||
      argument_count != 2) {
    return throw_type_error(env, "Expected stable-ancestor barrier and strict relative path.");
  }
  stable_ancestor_barrier *barrier;
  if (!unwrap_barrier(env, arguments[0], false, &barrier)) return NULL;
  char *relative_path = NULL;
  size_t relative_length = 0;
  int string_status = copy_string_argument(
    env,
    arguments[1],
    &relative_path,
    &relative_length
  );
  if (string_status < 0) {
    return throw_read_error(env, (storage_error){
      ENOMEM, "copy-relative-path", "not-opened"
    });
  }
  if (string_status == 0 || !valid_relative_path(relative_path, relative_length)) {
    free(relative_path);
    return throw_type_error(env, "relativePath must be one strict relative path.");
  }

  int descriptor = -1;
  struct stat metadata;
  uint64_t birthtime_ns = 0;
  if (open_directory_unchecked(
        barrier->descriptor,
        relative_path,
        &descriptor,
        &metadata,
        &birthtime_ns
      ) != 0) {
    int number = errno;
    free(relative_path);
    if (number == ENOENT) {
      napi_value undefined;
      napi_get_undefined(env, &undefined);
      return undefined;
    }
    return throw_read_error(env, (storage_error){
      number, "openat2-directory", "not-opened"
    });
  }
  free(relative_path);

  napi_value result;
  napi_status status = create_identity_result(env, &metadata, birthtime_ns, &result);
  if (status == napi_ok) status = napi_object_freeze(env, result);
  int close_error = close(descriptor);
  if (status != napi_ok) {
    bool pending = false;
    (void)napi_is_exception_pending(env, &pending);
    if (!pending) napi_throw_error(env, "ERR_NATIVE_READ_RESULT", "Could not create directory identity.");
    return NULL;
  }
  if (close_error != 0) {
    return throw_read_error(env, (storage_error){
      errno, "close-directory", "indeterminate"
    });
  }
  return result;
}

static napi_value mkdir_exact_no_replace(
  napi_env env,
  napi_callback_info info
) {
  size_t argument_count = 4;
  napi_value arguments[4];
  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok ||
      argument_count != 4) {
    return throw_type_error(
      env,
      "Expected exclusive barrier, parent path, exact parent identity, and child basename."
    );
  }
  stable_ancestor_barrier *barrier;
  if (!unwrap_barrier(env, arguments[0], true, &barrier)) return NULL;
  exact_identity expected_parent;
  if (!read_expected_identity(env, arguments[2], &expected_parent)) {
    return throw_type_error(env, "expectedParent must contain exact BigInt directory identity.");
  }

  char *parent_path = NULL;
  char *name = NULL;
  size_t parent_length = 0;
  size_t name_length = 0;
  int parent_status = copy_string_argument(
    env,
    arguments[1],
    &parent_path,
    &parent_length
  );
  int name_status = copy_string_argument(env, arguments[3], &name, &name_length);
  if (parent_status < 0 || name_status < 0) {
    free(parent_path);
    free(name);
    return throw_publication_error(env, (storage_error){
      ENOMEM, "copy-path", "not-published"
    });
  }
  if (parent_status == 0 || !valid_relative_path(parent_path, parent_length) ||
      name_status == 0 || !valid_basename(name, name_length)) {
    free(parent_path);
    free(name);
    return throw_type_error(env, "parent path and child name must be strict relative path and basename.");
  }

  int parent_descriptor = -1;
  int child_descriptor = -1;
  struct stat child_metadata;
  uint64_t child_birthtime_ns = 0;
  storage_error failure = {0, "", ""};
  if (open_directory_from_barrier(
        barrier,
        parent_path,
        &expected_parent,
        &parent_descriptor
      ) != 0) {
    failure = (storage_error){ errno, "openat2-parent", "not-published" };
    goto finish_mkdir;
  }
  if (mkdirat(parent_descriptor, name, TASKMUX_PRIVATE_DIRECTORY_MODE) != 0) {
    failure = (storage_error){
      errno,
      "mkdir-target",
      errno == EEXIST ? "conflict" : "not-published"
    };
    goto finish_mkdir;
  }
  child_descriptor = openat2_beneath(
    parent_descriptor,
    name,
    O_RDONLY | O_DIRECTORY
  );
  if (child_descriptor < 0 ||
      capture_identity(child_descriptor, &child_metadata, &child_birthtime_ns) != 0 ||
      !S_ISDIR(child_metadata.st_mode) ||
      child_metadata.st_uid != geteuid() ||
      ((uint32_t)child_metadata.st_mode & 0777U) != TASKMUX_PRIVATE_DIRECTORY_MODE) {
    int number = errno == 0 ? EIO : errno;
    failure = (storage_error){ number, "verify-directory", "indeterminate" };
    goto finish_mkdir;
  }
  if (fsync(parent_descriptor) != 0) {
    failure = (storage_error){ errno, "fsync-parent", "published-not-durable" };
    goto finish_mkdir;
  }

finish_mkdir:
  if (child_descriptor >= 0) (void)close(child_descriptor);
  if (parent_descriptor >= 0) (void)close(parent_descriptor);
  free(parent_path);
  free(name);
  if (failure.number != 0) return throw_publication_error(env, failure);

  napi_value result;
  napi_status status = create_identity_result(
    env,
    &child_metadata,
    child_birthtime_ns,
    &result
  );
  if (status == napi_ok) status = napi_object_freeze(env, result);
  if (status != napi_ok) {
    bool pending = false;
    (void)napi_is_exception_pending(env, &pending);
    if (!pending) napi_throw_error(env, "ERR_NATIVE_MKDIR_RESULT", "Could not create directory identity.");
    return NULL;
  }
  return result;
}

static napi_value open_pinned_root_at(
  napi_env env,
  napi_callback_info info
) {
  size_t argument_count = 3;
  napi_value arguments[3];
  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok ||
      argument_count != 3) {
    return throw_type_error(
      env,
      "Expected stable-ancestor barrier, root relative path, and optional exact root identity."
    );
  }
  stable_ancestor_barrier *barrier;
  if (!unwrap_barrier(env, arguments[0], false, &barrier)) return NULL;

  char *relative_path = NULL;
  size_t relative_length = 0;
  int path_status = copy_string_argument(
    env,
    arguments[1],
    &relative_path,
    &relative_length
  );
  if (path_status < 0) {
    return throw_read_error(env, (storage_error){
      ENOMEM, "copy-root-path", "not-opened"
    });
  }
  if (path_status == 0 || !valid_relative_path(relative_path, relative_length)) {
    free(relative_path);
    return throw_type_error(env, "rootRelativePath must be one strict relative path.");
  }

  napi_valuetype expected_type;
  if (napi_typeof(env, arguments[2], &expected_type) != napi_ok) {
    free(relative_path);
    return throw_type_error(env, "expectedRoot must be exact identity or undefined.");
  }
  bool expect_absent = expected_type == napi_undefined;
  exact_identity expected;
  if (!expect_absent && !read_expected_identity(env, arguments[2], &expected)) {
    free(relative_path);
    return throw_type_error(env, "expectedRoot must be exact BigInt directory identity or undefined.");
  }

  int descriptor = -1;
  struct stat metadata;
  uint64_t birthtime_ns = 0;
  if (open_directory_unchecked(
        barrier->descriptor,
        relative_path,
        &descriptor,
        &metadata,
        &birthtime_ns
      ) != 0) {
    int number = errno;
    free(relative_path);
    if (expect_absent && number == ENOENT) {
      napi_value undefined;
      napi_get_undefined(env, &undefined);
      return undefined;
    }
    return throw_read_error(env, (storage_error){
      number == ENOENT && !expect_absent ? ESTALE : number,
      "openat2-root",
      "not-opened"
    });
  }
  free(relative_path);
  if (expect_absent ||
      !stat_matches_identity(&metadata, birthtime_ns, &expected, S_IFDIR)) {
    (void)close(descriptor);
    return throw_read_error(env, (storage_error){
      ESTALE, "verify-root", "not-opened"
    });
  }

  pinned_directory *directory = calloc(1, sizeof(*directory));
  if (directory == NULL) {
    (void)close(descriptor);
    return throw_read_error(env, (storage_error){
      ENOMEM, "allocate-pinned-root", "not-opened"
    });
  }
  directory->descriptor = descriptor;
  directory->owner_pid = getpid();
  directory->active = true;
  directory->identity.dev = (uint64_t)metadata.st_dev;
  directory->identity.ino = (uint64_t)metadata.st_ino;
  directory->identity.uid = (uint64_t)metadata.st_uid;
  directory->identity.mode = (uint64_t)metadata.st_mode;
  directory->identity.nlink = (uint64_t)metadata.st_nlink;
  directory->identity.birthtime_ns = birthtime_ns;

  napi_value result;
  if (!create_pinned_directory_handle(env, directory, &result)) {
    finalize_pinned_directory(env, directory, NULL);
    bool pending = false;
    (void)napi_is_exception_pending(env, &pending);
    if (!pending) {
      napi_throw_error(env, "ERR_NATIVE_PINNED_ROOT", "Could not create opaque pinned root.");
    }
    return NULL;
  }
  return result;
}

static napi_value get_pinned_directory_identity(
  napi_env env,
  napi_callback_info info
) {
  size_t argument_count = 1;
  napi_value argument;
  if (napi_get_cb_info(env, info, &argument_count, &argument, NULL, NULL) != napi_ok ||
      argument_count != 1) {
    return throw_type_error(env, "Expected active native pinned directory.");
  }
  pinned_directory *directory;
  if (!unwrap_pinned_directory(env, argument, &directory)) return NULL;
  struct stat metadata;
  uint64_t birthtime_ns = 0;
  if (capture_identity(directory->descriptor, &metadata, &birthtime_ns) != 0 ||
      !stat_matches_identity(
        &metadata,
        birthtime_ns,
        &directory->identity,
        S_IFDIR
      )) {
    return throw_read_error(env, (storage_error){
      errno == 0 ? ESTALE : errno, "verify-pinned-root", "indeterminate"
    });
  }
  napi_value result;
  napi_status status = create_identity_result(env, &metadata, birthtime_ns, &result);
  if (status == napi_ok) status = napi_object_freeze(env, result);
  if (status != napi_ok) {
    bool pending = false;
    (void)napi_is_exception_pending(env, &pending);
    if (!pending) napi_throw_error(env, "ERR_NATIVE_READ_RESULT", "Could not create root identity.");
    return NULL;
  }
  return result;
}

static napi_value release_pinned_directory(
  napi_env env,
  napi_callback_info info
) {
  size_t argument_count = 1;
  napi_value argument;
  if (napi_get_cb_info(env, info, &argument_count, &argument, NULL, NULL) != napi_ok ||
      argument_count != 1) {
    return throw_type_error(env, "Expected native pinned directory.");
  }
  bool tagged = false;
  if (napi_check_object_type_tag(env, argument, &PINNED_DIRECTORY_TAG, &tagged) != napi_ok ||
      !tagged) {
    return throw_type_error(env, "Expected native pinned directory.");
  }
  pinned_directory *directory = NULL;
  if (napi_unwrap(env, argument, (void **)&directory) != napi_ok || directory == NULL) {
    return throw_type_error(env, "Expected native pinned directory.");
  }
  if (!directory->active) {
    napi_value undefined;
    napi_get_undefined(env, &undefined);
    return undefined;
  }
  if (directory->owner_pid != getpid()) {
    (void)close(directory->descriptor);
    directory->active = false;
    directory->descriptor = -1;
    return throw_read_error(env, (storage_error){
      EPERM, "release-after-fork", "indeterminate"
    });
  }
  if (close(directory->descriptor) != 0) {
    int number = errno;
    directory->active = false;
    directory->descriptor = -1;
    return throw_read_error(env, (storage_error){
      number, "close-pinned-root", "indeterminate"
    });
  }
  directory->active = false;
  directory->descriptor = -1;
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value lstat_pinned_directory(
  napi_env env,
  napi_callback_info info
) {
  size_t argument_count = 2;
  napi_value arguments[2];
  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok ||
      argument_count != 2) {
    return throw_type_error(env, "Expected pinned directory and strict relative path.");
  }
  pinned_directory *directory;
  if (!unwrap_pinned_directory(env, arguments[0], &directory)) return NULL;
  char *relative_path = NULL;
  size_t relative_length = 0;
  int path_status = copy_string_argument(
    env,
    arguments[1],
    &relative_path,
    &relative_length
  );
  if (path_status < 0) {
    return throw_read_error(env, (storage_error){
      ENOMEM, "copy-relative-path", "not-opened"
    });
  }
  if (path_status == 0 || !valid_relative_path(relative_path, relative_length)) {
    free(relative_path);
    return throw_type_error(env, "relativePath must be one strict relative path.");
  }

  int descriptor = -1;
  struct stat metadata;
  uint64_t birthtime_ns = 0;
  if (strcmp(relative_path, ".") == 0) {
    descriptor = duplicate_cloexec(directory->descriptor);
    if (descriptor >= 0) {
      (void)capture_identity(descriptor, &metadata, &birthtime_ns);
    }
  } else {
    descriptor = openat2_beneath(directory->descriptor, relative_path, O_PATH);
    if (descriptor >= 0) {
      (void)capture_identity(descriptor, &metadata, &birthtime_ns);
    }
  }
  int number = descriptor < 0 ? errno : 0;
  free(relative_path);
  if (descriptor < 0) {
    if (number == ENOENT) {
      napi_value undefined;
      napi_get_undefined(env, &undefined);
      return undefined;
    }
    return throw_read_error(env, (storage_error){
      number, "openat2-lstat", "not-opened"
    });
  }
  if (metadata.st_uid != geteuid()) {
    (void)close(descriptor);
    return throw_read_error(env, (storage_error){
      EACCES, "verify-lstat", "not-opened"
    });
  }

  napi_value result;
  napi_status status = create_receipt_result(env, &metadata, birthtime_ns, &result);
  int close_error = close(descriptor);
  if (status != napi_ok) {
    bool pending = false;
    (void)napi_is_exception_pending(env, &pending);
    if (!pending) napi_throw_error(env, "ERR_NATIVE_READ_RESULT", "Could not create stat receipt.");
    return NULL;
  }
  if (close_error != 0) {
    return throw_read_error(env, (storage_error){
      errno, "close-lstat", "indeterminate"
    });
  }
  return result;
}

static int compare_strings(const void *left, const void *right) {
  const char *const *left_name = left;
  const char *const *right_name = right;
  return strcmp(*left_name, *right_name);
}

static napi_value readdir_pinned_directory(
  napi_env env,
  napi_callback_info info
) {
  size_t argument_count = 2;
  napi_value arguments[2];
  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok ||
      argument_count != 2) {
    return throw_type_error(env, "Expected pinned directory and strict relative directory path.");
  }
  pinned_directory *directory;
  if (!unwrap_pinned_directory(env, arguments[0], &directory)) return NULL;
  char *relative_path = NULL;
  size_t relative_length = 0;
  int path_status = copy_string_argument(
    env,
    arguments[1],
    &relative_path,
    &relative_length
  );
  if (path_status < 0) {
    return throw_read_error(env, (storage_error){
      ENOMEM, "copy-relative-path", "not-opened"
    });
  }
  if (path_status == 0 || !valid_relative_path(relative_path, relative_length)) {
    free(relative_path);
    return throw_type_error(env, "relativePath must be one strict relative path.");
  }

  int child_descriptor = -1;
  struct stat child_metadata;
  uint64_t child_birthtime_ns = 0;
  if (open_directory_unchecked(
        directory->descriptor,
        relative_path,
        &child_descriptor,
        &child_metadata,
        &child_birthtime_ns
      ) != 0) {
    int number = errno;
    free(relative_path);
    return throw_read_error(env, (storage_error){
      number, "openat2-readdir", "not-opened"
    });
  }
  free(relative_path);
  DIR *stream = fdopendir(child_descriptor);
  if (stream == NULL) {
    int number = errno;
    (void)close(child_descriptor);
    return throw_read_error(env, (storage_error){
      number, "fdopendir", "not-opened"
    });
  }

  char **names = NULL;
  size_t count = 0;
  size_t capacity = 0;
  storage_error failure = {0, "", ""};
  errno = 0;
  struct dirent *entry;
  while ((entry = readdir(stream)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (count == capacity) {
      size_t next_capacity = capacity == 0 ? 8U : capacity * 2U;
      char **next_names = realloc(names, next_capacity * sizeof(*names));
      if (next_names == NULL) {
        failure = (storage_error){ ENOMEM, "allocate-readdir", "indeterminate" };
        break;
      }
      names = next_names;
      capacity = next_capacity;
    }
    names[count] = strdup(entry->d_name);
    if (names[count] == NULL) {
      failure = (storage_error){ ENOMEM, "copy-readdir-entry", "indeterminate" };
      break;
    }
    count += 1U;
  }
  if (failure.number == 0 && errno != 0) {
    failure = (storage_error){ errno, "readdir", "indeterminate" };
  }
  if (closedir(stream) != 0 && failure.number == 0) {
    failure = (storage_error){ errno, "close-readdir", "indeterminate" };
  }
  if (failure.number != 0) {
    for (size_t index = 0; index < count; index += 1U) free(names[index]);
    free(names);
    return throw_read_error(env, failure);
  }

  qsort(names, count, sizeof(*names), compare_strings);
  napi_value result;
  napi_status status = napi_create_array_with_length(env, count, &result);
  for (size_t index = 0; status == napi_ok && index < count; index += 1U) {
    napi_value name;
    status = napi_create_string_utf8(env, names[index], NAPI_AUTO_LENGTH, &name);
    if (status == napi_ok) status = napi_set_element(env, result, (uint32_t)index, name);
  }
  for (size_t index = 0; index < count; index += 1U) free(names[index]);
  free(names);
  if (status != napi_ok) {
    bool pending = false;
    (void)napi_is_exception_pending(env, &pending);
    if (!pending) napi_throw_error(env, "ERR_NATIVE_READDIR_RESULT", "Could not create directory listing.");
    return NULL;
  }
  return result;
}

static napi_value read_pinned_file_exact(
  napi_env env,
  napi_callback_info info
) {
  size_t argument_count = 3;
  napi_value arguments[3];
  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok ||
      argument_count != 3) {
    return throw_type_error(env, "Expected pinned directory, strict relative file path, and maxBytes.");
  }
  pinned_directory *directory;
  if (!unwrap_pinned_directory(env, arguments[0], &directory)) return NULL;
  size_t max_bytes;
  if (!exact_nonnegative_size(
        env,
        arguments[2],
        TASKMUX_MAX_READ_BYTES,
        &max_bytes
      )) {
    return throw_type_error(env, "maxBytes must be one exact non-negative bounded integer.");
  }
  char *relative_path = NULL;
  size_t relative_length = 0;
  int path_status = copy_string_argument(
    env,
    arguments[1],
    &relative_path,
    &relative_length
  );
  if (path_status < 0) {
    return throw_read_error(env, (storage_error){
      ENOMEM, "copy-relative-path", "not-opened"
    });
  }
  if (path_status == 0 || !valid_relative_path(relative_path, relative_length) ||
      strcmp(relative_path, ".") == 0) {
    free(relative_path);
    return throw_type_error(env, "relativePath must be one strict non-directory file path.");
  }

  int descriptor = -1;
  struct stat before;
  struct stat after;
  uint64_t before_birthtime_ns = 0;
  uint64_t after_birthtime_ns = 0;
  if (open_regular_unchecked(
        directory->descriptor,
        relative_path,
        &descriptor,
        &before,
        &before_birthtime_ns
      ) != 0) {
    int number = errno;
    free(relative_path);
    return throw_read_error(env, (storage_error){
      number, "openat2-read", "not-opened"
    });
  }
  free(relative_path);
  if (before.st_size < 0 || (uint64_t)before.st_size > (uint64_t)max_bytes) {
    (void)close(descriptor);
    return throw_read_error(env, (storage_error){
      EFBIG, "verify-read-size", "not-opened"
    });
  }
  size_t length = (size_t)before.st_size;
  unsigned char *bytes = NULL;
  if (length > 0) {
    bytes = malloc(length);
    if (bytes == NULL) {
      (void)close(descriptor);
      return throw_read_error(env, (storage_error){
        ENOMEM, "allocate-read", "not-opened"
      });
    }
    if (read_all(descriptor, bytes, length) != 0) {
      int number = errno;
      free(bytes);
      (void)close(descriptor);
      return throw_read_error(env, (storage_error){
        number, "read-file", "not-opened"
      });
    }
  }
  if (capture_identity(descriptor, &after, &after_birthtime_ns) != 0 ||
      !same_regular_file(&before, &after) ||
      before_birthtime_ns != after_birthtime_ns) {
    int number = errno == 0 ? ESTALE : errno;
    free(bytes);
    (void)close(descriptor);
    return throw_read_error(env, (storage_error){
      number, "verify-read", "indeterminate"
    });
  }
  if (close(descriptor) != 0) {
    int number = errno;
    free(bytes);
    return throw_read_error(env, (storage_error){
      number, "close-read", "indeterminate"
    });
  }

  napi_value result;
  napi_value buffer;
  napi_value receipt;
  napi_status status = create_null_object(env, &result);
  if (status == napi_ok) {
    status = napi_create_buffer_copy(env, length, bytes, NULL, &buffer);
  }
  if (status == napi_ok) {
    status = create_receipt_result(env, &after, after_birthtime_ns, &receipt);
  }
  if (status == napi_ok) status = define_readonly_value(env, result, "bytes", buffer);
  if (status == napi_ok) status = define_readonly_value(env, result, "identity", receipt);
  if (status == napi_ok) status = napi_object_freeze(env, result);
  free(bytes);
  if (status != napi_ok) {
    bool pending = false;
    (void)napi_is_exception_pending(env, &pending);
    if (!pending) napi_throw_error(env, "ERR_NATIVE_READ_RESULT", "Could not create pinned read result.");
    return NULL;
  }
  return result;
}

static int parse_barrier_parent_target_bytes(
  napi_env env,
  napi_value *arguments,
  stable_ancestor_barrier **barrier,
  char **parent_path,
  exact_identity *expected_parent,
  char **target_name,
  unsigned char **private_bytes,
  size_t *buffer_length
) {
  if (!unwrap_barrier(env, arguments[0], true, barrier)) return 0;
  if (!read_expected_identity(env, arguments[2], expected_parent)) {
    (void)throw_type_error(env, "expectedParent must contain exact BigInt directory identity.");
    return 0;
  }
  size_t parent_length = 0;
  size_t target_length = 0;
  int parent_status = copy_string_argument(
    env,
    arguments[1],
    parent_path,
    &parent_length
  );
  int target_status = copy_string_argument(
    env,
    arguments[3],
    target_name,
    &target_length
  );
  if (parent_status < 0 || target_status < 0) {
    free(*parent_path);
    free(*target_name);
    (void)throw_publication_error(env, (storage_error){
      ENOMEM, "copy-path", "not-published"
    });
    return 0;
  }
  if (parent_status == 0 || !valid_relative_path(*parent_path, parent_length) ||
      target_status == 0 || !valid_basename(*target_name, target_length)) {
    free(*parent_path);
    free(*target_name);
    (void)throw_type_error(env, "parent path must be strict relative and target name must be a basename.");
    return 0;
  }
  bool is_buffer = false;
  void *buffer_data = NULL;
  if (napi_is_buffer(env, arguments[4], &is_buffer) != napi_ok || !is_buffer ||
      napi_get_buffer_info(env, arguments[4], &buffer_data, buffer_length) != napi_ok) {
    free(*parent_path);
    free(*target_name);
    (void)throw_type_error(env, "bytes must be a Buffer.");
    return 0;
  }
  if (*buffer_length > TASKMUX_MAX_PUBLICATION_BYTES) {
    free(*parent_path);
    free(*target_name);
    (void)throw_publication_error(env, (storage_error){
      EFBIG, "validate-bytes", "not-published"
    });
    return 0;
  }
  *private_bytes = NULL;
  if (*buffer_length > 0) {
    *private_bytes = malloc(*buffer_length);
    if (*private_bytes == NULL) {
      free(*parent_path);
      free(*target_name);
      (void)throw_publication_error(env, (storage_error){
        ENOMEM, "copy-bytes", "not-published"
      });
      return 0;
    }
    memcpy(*private_bytes, buffer_data, *buffer_length);
  }
  return 1;
}

static napi_value publish_anonymous_file_no_replace(
  napi_env env,
  napi_callback_info info
) {
  size_t argument_count = 5;
  napi_value arguments[5];
  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok ||
      argument_count != 5) {
    return throw_type_error(
      env,
      "Expected exclusive barrier, parent path, exact parent identity, target basename, and bytes."
    );
  }
  stable_ancestor_barrier *barrier = NULL;
  exact_identity expected_parent;
  char *parent_path = NULL;
  char *target_name = NULL;
  unsigned char *private_bytes = NULL;
  size_t buffer_length = 0;
  if (!parse_barrier_parent_target_bytes(
        env,
        arguments,
        &barrier,
        &parent_path,
        &expected_parent,
        &target_name,
        &private_bytes,
        &buffer_length
      )) {
    return NULL;
  }

  int parent_descriptor = -1;
  int source_descriptor = -1;
  int target_descriptor = -1;
  struct stat source_metadata;
  struct stat target_metadata;
  uint64_t source_birthtime_ns = 0;
  uint64_t target_birthtime_ns = 0;
  storage_error failure = {0, "", ""};
  if (open_directory_from_barrier(
        barrier,
        parent_path,
        &expected_parent,
        &parent_descriptor
      ) != 0) {
    failure = (storage_error){ errno, "openat2-parent", "not-published" };
    goto finish_publish;
  }
  source_descriptor = openat(
    parent_descriptor,
    ".",
    O_TMPFILE | O_RDWR | O_CLOEXEC,
    TASKMUX_PRIVATE_FILE_MODE
  );
  if (source_descriptor < 0) {
    failure = (storage_error){ errno, "open-source", "not-published" };
    goto finish_publish;
  }
  if (write_all(source_descriptor, private_bytes, buffer_length) != 0) {
    failure = (storage_error){ errno, "write-source", "not-published" };
    goto finish_publish;
  }
  if (fchmod(source_descriptor, TASKMUX_PRIVATE_FILE_MODE) != 0 ||
      fsync(source_descriptor) != 0) {
    failure = (storage_error){ errno, "fsync-source", "not-published" };
    goto finish_publish;
  }
  if (capture_identity(
        source_descriptor,
        &source_metadata,
        &source_birthtime_ns
      ) != 0 ||
      !private_regular_file(&source_metadata) ||
      source_metadata.st_nlink != 0 ||
      source_metadata.st_dev != expected_parent.dev ||
      (uint64_t)source_metadata.st_size != (uint64_t)buffer_length) {
    failure = (storage_error){
      errno == 0 ? EIO : errno, "verify-source", "not-published"
    };
    goto finish_publish;
  }
  if (link_pinned_fd_no_replace(
        source_descriptor,
        parent_descriptor,
        target_name
      ) != 0) {
    int link_error = errno;
    if (link_error == EEXIST) {
      failure = (storage_error){ EEXIST, "link-target", "conflict" };
      goto finish_publish;
    }
    struct stat maybe_target;
    if (fstatat(
          parent_descriptor,
          target_name,
          &maybe_target,
          AT_SYMLINK_NOFOLLOW
        ) == 0 &&
        same_regular_file(&source_metadata, &maybe_target) &&
        private_regular_file(&maybe_target)) {
      failure = (storage_error){
        link_error, "link-target", "published-not-durable"
      };
    } else {
      failure = (storage_error){
        link_error, "link-target", "indeterminate"
      };
    }
    goto finish_publish;
  }
  if (open_regular_basename(
        parent_descriptor,
        target_name,
        &target_descriptor,
        &target_metadata,
        &target_birthtime_ns
      ) != 0 ||
      !same_regular_file(&source_metadata, &target_metadata) ||
      !private_regular_file(&target_metadata)) {
    failure = (storage_error){
      errno == 0 ? EIO : errno, "verify-target", "indeterminate"
    };
    goto finish_publish;
  }
  if (fsync(parent_descriptor) != 0) {
    failure = (storage_error){ errno, "fsync-target-parent", "published-not-durable" };
    goto finish_publish;
  }

finish_publish:
  if (target_descriptor >= 0) (void)close(target_descriptor);
  if (source_descriptor >= 0) (void)close(source_descriptor);
  if (parent_descriptor >= 0) (void)close(parent_descriptor);
  free(private_bytes);
  free(parent_path);
  free(target_name);
  if (failure.number != 0) return throw_publication_error(env, failure);

  napi_value result;
  napi_status status = create_receipt_result(
    env,
    &target_metadata,
    target_birthtime_ns,
    &result
  );
  if (status != napi_ok) {
    bool pending = false;
    (void)napi_is_exception_pending(env, &pending);
    if (!pending) napi_throw_error(env, "ERR_NATIVE_PUBLICATION_RECEIPT", "Could not create durable publication receipt.");
    return NULL;
  }
  return result;
}

static int parse_link_or_rename_arguments(
  napi_env env,
  napi_value *arguments,
  stable_ancestor_barrier **barrier,
  char **source_parent_path,
  exact_identity *expected_source_parent,
  char **source_name,
  exact_receipt *expected_source,
  char **target_parent_path,
  exact_identity *expected_target_parent,
  char **target_name
) {
  if (!unwrap_barrier(env, arguments[0], true, barrier)) return 0;
  if (!read_expected_identity(env, arguments[2], expected_source_parent) ||
      !read_expected_receipt(env, arguments[4], expected_source) ||
      !read_expected_identity(env, arguments[6], expected_target_parent)) {
    (void)throw_type_error(env, "Expected exact source/target directory identities and source receipt.");
    return 0;
  }
  size_t source_parent_length = 0;
  size_t source_name_length = 0;
  size_t target_parent_length = 0;
  size_t target_name_length = 0;
  int source_parent_status = copy_string_argument(
    env,
    arguments[1],
    source_parent_path,
    &source_parent_length
  );
  int source_name_status = copy_string_argument(
    env,
    arguments[3],
    source_name,
    &source_name_length
  );
  int target_parent_status = copy_string_argument(
    env,
    arguments[5],
    target_parent_path,
    &target_parent_length
  );
  int target_name_status = copy_string_argument(
    env,
    arguments[7],
    target_name,
    &target_name_length
  );
  if (source_parent_status < 0 || source_name_status < 0 ||
      target_parent_status < 0 || target_name_status < 0) {
    free(*source_parent_path);
    free(*source_name);
    free(*target_parent_path);
    free(*target_name);
    (void)throw_publication_error(env, (storage_error){
      ENOMEM, "copy-path", "not-published"
    });
    return 0;
  }
  if (source_parent_status == 0 ||
      !valid_relative_path(*source_parent_path, source_parent_length) ||
      source_name_status == 0 || !valid_basename(*source_name, source_name_length) ||
      target_parent_status == 0 ||
      !valid_relative_path(*target_parent_path, target_parent_length) ||
      target_name_status == 0 || !valid_basename(*target_name, target_name_length)) {
    free(*source_parent_path);
    free(*source_name);
    free(*target_parent_path);
    free(*target_name);
    (void)throw_type_error(env, "Source/target parent paths must be strict relative and names must be basenames.");
    return 0;
  }
  return 1;
}

static void free_link_or_rename_paths(
  char *source_parent_path,
  char *source_name,
  char *target_parent_path,
  char *target_name
) {
  free(source_parent_path);
  free(source_name);
  free(target_parent_path);
  free(target_name);
}

static napi_value link_prepared_file_no_replace(
  napi_env env,
  napi_callback_info info
) {
  size_t argument_count = 8;
  napi_value arguments[8];
  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok ||
      argument_count != 8) {
    return throw_type_error(
      env,
      "Expected exclusive barrier, source parent/path receipt, and target parent/name."
    );
  }
  stable_ancestor_barrier *barrier = NULL;
  char *source_parent_path = NULL;
  char *source_name = NULL;
  char *target_parent_path = NULL;
  char *target_name = NULL;
  exact_identity expected_source_parent;
  exact_identity expected_target_parent;
  exact_receipt expected_source;
  if (!parse_link_or_rename_arguments(
        env,
        arguments,
        &barrier,
        &source_parent_path,
        &expected_source_parent,
        &source_name,
        &expected_source,
        &target_parent_path,
        &expected_target_parent,
        &target_name
      )) {
    return NULL;
  }
  int source_parent_descriptor = -1;
  int target_parent_descriptor = -1;
  int source_descriptor = -1;
  int target_descriptor = -1;
  struct stat source_metadata;
  struct stat target_metadata;
  uint64_t source_birthtime_ns = 0;
  uint64_t target_birthtime_ns = 0;
  storage_error failure = {0, "", ""};
  if (open_directory_from_barrier(
        barrier,
        source_parent_path,
        &expected_source_parent,
        &source_parent_descriptor
      ) != 0) {
    failure = (storage_error){ errno, "openat2-source-parent", "not-published" };
    goto finish_link;
  }
  if (open_directory_from_barrier(
        barrier,
        target_parent_path,
        &expected_target_parent,
        &target_parent_descriptor
      ) != 0) {
    failure = (storage_error){ errno, "openat2-target-parent", "not-published" };
    goto finish_link;
  }
  if (open_expected_regular(
        source_parent_descriptor,
        source_name,
        &expected_source,
        &source_descriptor,
        &source_metadata,
        &source_birthtime_ns
      ) != 0) {
    failure = (storage_error){ errno, "openat2-source", "not-published" };
    goto finish_link;
  }
  if (link_pinned_fd_no_replace(
        source_descriptor,
        target_parent_descriptor,
        target_name
      ) != 0) {
    int link_error = errno;
    if (link_error == EEXIST) {
      failure = (storage_error){ EEXIST, "link-target", "conflict" };
    } else {
      struct stat maybe_target;
      if (fstatat(
            target_parent_descriptor,
            target_name,
            &maybe_target,
            AT_SYMLINK_NOFOLLOW
          ) == 0 &&
          same_regular_file(&source_metadata, &maybe_target) &&
          private_regular_file(&maybe_target)) {
        failure = (storage_error){
          link_error, "link-target", "published-not-durable"
        };
      } else {
        failure = (storage_error){
          link_error, "link-target", "indeterminate"
        };
      }
    }
    goto finish_link;
  }
  if (open_regular_basename(
        target_parent_descriptor,
        target_name,
        &target_descriptor,
        &target_metadata,
        &target_birthtime_ns
      ) != 0 ||
      !same_regular_file(&source_metadata, &target_metadata) ||
      !private_regular_file(&target_metadata)) {
    failure = (storage_error){
      errno == 0 ? EIO : errno, "verify-target", "indeterminate"
    };
    goto finish_link;
  }
  if (fsync(target_parent_descriptor) != 0) {
    failure = (storage_error){ errno, "fsync-target-parent", "published-not-durable" };
    goto finish_link;
  }

finish_link:
  if (target_descriptor >= 0) (void)close(target_descriptor);
  if (source_descriptor >= 0) (void)close(source_descriptor);
  if (target_parent_descriptor >= 0) (void)close(target_parent_descriptor);
  if (source_parent_descriptor >= 0) (void)close(source_parent_descriptor);
  free_link_or_rename_paths(
    source_parent_path,
    source_name,
    target_parent_path,
    target_name
  );
  if (failure.number != 0) return throw_publication_error(env, failure);

  napi_value result;
  napi_status status = create_receipt_result(
    env,
    &target_metadata,
    target_birthtime_ns,
    &result
  );
  if (status != napi_ok) {
    bool pending = false;
    (void)napi_is_exception_pending(env, &pending);
    if (!pending) napi_throw_error(env, "ERR_NATIVE_PUBLICATION_RECEIPT", "Could not create durable link receipt.");
    return NULL;
  }
  return result;
}

static napi_value rename_no_replace_exact(
  napi_env env,
  napi_callback_info info
) {
  size_t argument_count = 8;
  napi_value arguments[8];
  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok ||
      argument_count != 8) {
    return throw_type_error(
      env,
      "Expected exclusive barrier, source parent/path receipt, and target parent/name."
    );
  }
  stable_ancestor_barrier *barrier = NULL;
  char *source_parent_path = NULL;
  char *source_name = NULL;
  char *target_parent_path = NULL;
  char *target_name = NULL;
  exact_identity expected_source_parent;
  exact_identity expected_target_parent;
  exact_receipt expected_source;
  if (!parse_link_or_rename_arguments(
        env,
        arguments,
        &barrier,
        &source_parent_path,
        &expected_source_parent,
        &source_name,
        &expected_source,
        &target_parent_path,
        &expected_target_parent,
        &target_name
      )) {
    return NULL;
  }
  bool source_is_directory =
    (expected_source.identity.mode & (uint64_t)S_IFMT) == (uint64_t)S_IFDIR;
  bool source_is_regular =
    (expected_source.identity.mode & (uint64_t)S_IFMT) == (uint64_t)S_IFREG;
  if (!source_is_directory && !source_is_regular) {
    free_link_or_rename_paths(
      source_parent_path,
      source_name,
      target_parent_path,
      target_name
    );
    return throw_type_error(
      env,
      "renameNoReplaceExact supports only exact regular-file or directory receipts."
    );
  }

  int source_parent_descriptor = -1;
  int target_parent_descriptor = -1;
  int source_descriptor = -1;
  int target_descriptor = -1;
  struct stat source_metadata;
  struct stat target_metadata;
  uint64_t source_birthtime_ns = 0;
  uint64_t target_birthtime_ns = 0;
  bool renamed = false;
  storage_error failure = {0, "", ""};
  if (open_directory_from_barrier(
        barrier,
        source_parent_path,
        &expected_source_parent,
        &source_parent_descriptor
      ) != 0) {
    failure = (storage_error){ errno, "openat2-source-parent", "not-published" };
    goto finish_rename;
  }
  if (open_directory_from_barrier(
        barrier,
        target_parent_path,
        &expected_target_parent,
        &target_parent_descriptor
      ) != 0) {
    failure = (storage_error){ errno, "openat2-target-parent", "not-published" };
    goto finish_rename;
  }
  if (open_expected_entry(
        source_parent_descriptor,
        source_name,
        &expected_source,
        source_is_directory,
        &source_descriptor,
        &source_metadata,
        &source_birthtime_ns
      ) != 0) {
    failure = (storage_error){ errno, "openat2-source", "not-published" };
    goto finish_rename;
  }
  if (renameat2_noreplace(
        source_parent_descriptor,
        source_name,
        target_parent_descriptor,
        target_name
      ) != 0) {
    int rename_error = errno;
    if (rename_error == EEXIST) {
      failure = (storage_error){ EEXIST, "rename-target", "conflict" };
      goto finish_rename;
    }
    if (open_expected_entry(
          target_parent_descriptor,
          target_name,
          &expected_source,
          source_is_directory,
          &target_descriptor,
          &target_metadata,
          &target_birthtime_ns
        ) == 0) {
      renamed = true;
      failure = (storage_error){
        rename_error, "rename-target", "published-not-durable"
      };
    } else {
      failure = (storage_error){
        rename_error, "rename-target", "indeterminate"
      };
    }
    goto finish_rename;
  }
  renamed = true;
  if (open_expected_entry(
        target_parent_descriptor,
        target_name,
        &expected_source,
        source_is_directory,
        &target_descriptor,
        &target_metadata,
        &target_birthtime_ns
      ) != 0) {
    int verification_error = errno == 0 ? ESTALE : errno;
    if (renameat2_noreplace(
          target_parent_descriptor,
          target_name,
          source_parent_descriptor,
          source_name
        ) == 0) {
      if (fsync(target_parent_descriptor) != 0 ||
          fsync(source_parent_descriptor) != 0) {
        failure = (storage_error){
          errno, "restore-source", "source-restored-not-durable"
        };
      } else {
        failure = (storage_error){
          verification_error, "verify-target", "source-restored"
        };
      }
    } else {
      failure = (storage_error){
        verification_error, "verify-target", "source-quarantined"
      };
    }
    goto finish_rename;
  }
  if (fsync(target_parent_descriptor) != 0) {
    failure = (storage_error){ errno, "fsync-target-parent", "published-not-durable" };
    goto finish_rename;
  }
  struct stat source_parent_metadata;
  struct stat target_parent_metadata;
  if (fstat(source_parent_descriptor, &source_parent_metadata) != 0 ||
      fstat(target_parent_descriptor, &target_parent_metadata) != 0) {
    failure = (storage_error){
      errno, "stat-rename-parents", "published-not-durable"
    };
    goto finish_rename;
  }
  if (source_parent_metadata.st_dev != target_parent_metadata.st_dev ||
      source_parent_metadata.st_ino != target_parent_metadata.st_ino) {
    if (fsync(source_parent_descriptor) != 0) {
      failure = (storage_error){ errno, "fsync-source-parent", "published-not-durable" };
      goto finish_rename;
    }
  }

finish_rename:
  if (target_descriptor >= 0) (void)close(target_descriptor);
  if (source_descriptor >= 0) (void)close(source_descriptor);
  if (target_parent_descriptor >= 0) (void)close(target_parent_descriptor);
  if (source_parent_descriptor >= 0) (void)close(source_parent_descriptor);
  free_link_or_rename_paths(
    source_parent_path,
    source_name,
    target_parent_path,
    target_name
  );
  if (failure.number != 0) return throw_publication_error(env, failure);
  if (!renamed) {
    return throw_publication_error(env, (storage_error){
      EIO, "rename-target", "indeterminate"
    });
  }

  napi_value result;
  napi_status status = create_receipt_result(
    env,
    &target_metadata,
    target_birthtime_ns,
    &result
  );
  if (status != napi_ok) {
    bool pending = false;
    (void)napi_is_exception_pending(env, &pending);
    if (!pending) napi_throw_error(env, "ERR_NATIVE_PUBLICATION_RECEIPT", "Could not create durable rename receipt.");
    return NULL;
  }
  return result;
}

static napi_value remove_exact_entry(
  napi_env env,
  napi_callback_info info
) {
  size_t argument_count = 7;
  napi_value arguments[7];
  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok ||
      argument_count != 7) {
    return throw_type_error(
      env,
      "Expected exclusive barrier, parent receipts, target basename/receipt, and entry kind."
    );
  }
  stable_ancestor_barrier *barrier = NULL;
  if (!unwrap_barrier(env, arguments[0], true, &barrier)) return NULL;

  exact_identity expected_parent_before;
  exact_identity expected_parent_after;
  exact_receipt expected_target;
  if (!read_expected_identity(env, arguments[2], &expected_parent_before) ||
      !read_expected_receipt(env, arguments[4], &expected_target) ||
      !read_expected_identity(env, arguments[6], &expected_parent_after)) {
    return throw_type_error(
      env,
      "Expected exact parent identities and target receipt."
    );
  }

  char *parent_path = NULL;
  char *target_name = NULL;
  char *entry_kind = NULL;
  size_t parent_length = 0;
  size_t target_length = 0;
  size_t kind_length = 0;
  int parent_status = copy_string_argument(
    env,
    arguments[1],
    &parent_path,
    &parent_length
  );
  int target_status = copy_string_argument(
    env,
    arguments[3],
    &target_name,
    &target_length
  );
  int kind_status = copy_string_argument(
    env,
    arguments[5],
    &entry_kind,
    &kind_length
  );
  if (parent_status < 0 || target_status < 0 || kind_status < 0) {
    free(parent_path);
    free(target_name);
    free(entry_kind);
    return throw_publication_error(env, (storage_error){
      ENOMEM, "copy-path", "not-published"
    });
  }
  bool remove_directory = kind_status > 0 &&
    strcmp(entry_kind, "directory") == 0;
  bool remove_file = kind_status > 0 && strcmp(entry_kind, "file") == 0;
  if (parent_status == 0 || !valid_relative_path(parent_path, parent_length) ||
      target_status == 0 || !valid_basename(target_name, target_length) ||
      (!remove_file && !remove_directory)) {
    free(parent_path);
    free(target_name);
    free(entry_kind);
    return throw_type_error(
      env,
      "Parent path and target name must be strict, and entry kind must be file or directory."
    );
  }

  int parent_descriptor = -1;
  int target_descriptor = -1;
  struct stat target_metadata;
  struct stat parent_after_metadata;
  uint64_t target_birthtime_ns = 0;
  uint64_t parent_after_birthtime_ns = 0;
  storage_error failure = {0, "", ""};
  if (open_directory_from_barrier(
        barrier,
        parent_path,
        &expected_parent_before,
        &parent_descriptor
      ) != 0) {
    failure = (storage_error){ errno, "openat2-parent", "not-published" };
    goto finish_remove;
  }
  if (open_expected_entry(
        parent_descriptor,
        target_name,
        &expected_target,
        remove_directory,
        &target_descriptor,
        &target_metadata,
        &target_birthtime_ns
      ) != 0) {
    failure = (storage_error){ errno, "openat2-target", "not-published" };
    goto finish_remove;
  }
  if (unlinkat(
        parent_descriptor,
        target_name,
        remove_directory ? AT_REMOVEDIR : 0
      ) != 0) {
    failure = (storage_error){ errno, "unlinkat-target", "not-published" };
    goto finish_remove;
  }
  if (fsync(parent_descriptor) != 0) {
    failure = (storage_error){ errno, "fsync-parent", "published-not-durable" };
    goto finish_remove;
  }
  if (capture_identity(
        parent_descriptor,
        &parent_after_metadata,
        &parent_after_birthtime_ns
      ) != 0 ||
      !stat_matches_identity(
        &parent_after_metadata,
        parent_after_birthtime_ns,
        &expected_parent_after,
        S_IFDIR
      )) {
    failure = (storage_error){
      errno == 0 ? ESTALE : errno,
      "verify-parent-after-remove",
      "published-not-durable"
    };
    goto finish_remove;
  }

finish_remove:
  if (target_descriptor >= 0) (void)close(target_descriptor);
  if (parent_descriptor >= 0) (void)close(parent_descriptor);
  free(parent_path);
  free(target_name);
  free(entry_kind);
  if (failure.number != 0) return throw_publication_error(env, failure);

  napi_value result;
  napi_status status = create_identity_result(
    env,
    &parent_after_metadata,
    parent_after_birthtime_ns,
    &result
  );
  if (status == napi_ok) status = napi_object_freeze(env, result);
  if (status != napi_ok) {
    bool pending = false;
    (void)napi_is_exception_pending(env, &pending);
    if (!pending) napi_throw_error(
      env,
      "ERR_NATIVE_REMOVE_RECEIPT",
      "Could not create exact remove parent receipt."
    );
    return NULL;
  }
  return result;
}

static napi_status export_function(
  napi_env env,
  napi_value exports,
  const char *name,
  napi_callback callback
) {
  napi_value function;
  napi_status status = napi_create_function(
    env,
    name,
    NAPI_AUTO_LENGTH,
    callback,
    NULL,
    &function
  );
  if (status != napi_ok) return status;
  napi_property_descriptor property = {
    .utf8name = name,
    .name = NULL,
    .method = NULL,
    .getter = NULL,
    .setter = NULL,
    .value = function,
    .attributes = napi_enumerable,
    .data = NULL
  };
  return napi_define_properties(env, exports, 1, &property);
}

static napi_value initialize(napi_env env, napi_value exports) {
  const struct {
    const char *name;
    napi_callback callback;
  } functions[] = {
    { "inspectDirectoryDescriptor", inspect_directory_descriptor },
    { "acquireStableAncestorSharedBarrier", acquire_stable_ancestor_shared_barrier },
    { "acquireStableAncestorExclusiveBarrier", acquire_stable_ancestor_exclusive_barrier },
    { "releaseStableAncestorBarrier", release_stable_ancestor_barrier },
    { "inspectDirectoryAt", inspect_directory_at },
    { "mkdirExactNoReplace", mkdir_exact_no_replace },
    { "openPinnedRootAt", open_pinned_root_at },
    { "getPinnedDirectoryIdentity", get_pinned_directory_identity },
    { "lstatPinnedDirectory", lstat_pinned_directory },
    { "readdirPinnedDirectory", readdir_pinned_directory },
    { "readPinnedFileExact", read_pinned_file_exact },
    { "releasePinnedDirectory", release_pinned_directory },
    { "publishAnonymousFileNoReplace", publish_anonymous_file_no_replace },
    { "linkPreparedFileNoReplace", link_prepared_file_no_replace },
    { "renameNoReplaceExact", rename_no_replace_exact },
    { "removeExactEntry", remove_exact_entry }
  };
  napi_status status = napi_ok;
  for (size_t index = 0; index < sizeof(functions) / sizeof(functions[0]); index += 1U) {
    status = export_function(env, exports, functions[index].name, functions[index].callback);
    if (status != napi_ok) break;
  }
  if (status != napi_ok) {
    napi_throw_error(
      env,
      "ERR_NATIVE_STORAGE_INIT",
      "Could not initialize canonical native storage authority."
    );
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
