{
  "targets": [
    {
      "target_name": "taskmux_storage_fs",
      "sources": ["storage_fs.c"],
      "defines": ["_GNU_SOURCE", "NAPI_VERSION=8"],
      "cflags": ["-std=c11", "-Wall", "-Wextra", "-Werror"]
    }
  ]
}
