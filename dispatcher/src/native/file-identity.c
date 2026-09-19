#ifdef __linux__
#define _GNU_SOURCE
#endif
#include "sqlite3ext.h"
#include <string.h>
#include <stdio.h>
#include <fcntl.h>
#include <errno.h>
SQLITE_EXTENSION_INIT1

typedef struct { sqlite3 *database; int active; unsigned char token[32]; } mutation_guard;

static int authorize_mutation(void *data, int action, const char *first,
  const char *second, const char *database, const char *source) {
  (void)data; (void)source;
  switch (action) {
    case SQLITE_READ: case SQLITE_SELECT: case SQLITE_RECURSIVE: return SQLITE_OK;
    case SQLITE_INSERT: case SQLITE_UPDATE: case SQLITE_DELETE:
      if (!database || strcmp(database, "main") || !first ||
        !strncmp(first, "sqlite_", 7) || !strncmp(first, "security_audit_", 15)) return SQLITE_DENY;
      return SQLITE_OK;
    case SQLITE_FUNCTION:
      return second && sqlite3_stricmp(second, "load_extension") && sqlite3_stricmp(second, "dona_publish_mutex") ? SQLITE_OK : SQLITE_DENY;
    case SQLITE_PRAGMA:
      /* Only the fixed read-only checks used by the repository are permitted. */
      return !second && first && (!strcmp(first, "foreign_keys") ||
        !strcmp(first, "recursive_triggers") || !strcmp(first, "foreign_key_check") ||
        !strcmp(first, "ignore_check_constraints")) ? SQLITE_OK : SQLITE_DENY;
    default: return SQLITE_DENY;
  }
}

/* Publish a CLOSED private staging file without a hardlink interval and without
 * replacing an existing inode. Never fall back to ordinary replacing rename. */
static void publish_mutex(sqlite3_context *context, int argc, sqlite3_value **argv) {
  (void)argc;
  if (sqlite3_value_type(argv[0]) != SQLITE_TEXT || sqlite3_value_type(argv[1]) != SQLITE_TEXT) goto failed;
  const char *source = (const char *)sqlite3_value_text(argv[0]);
  const char *target = (const char *)sqlite3_value_text(argv[1]);
  if (!source || !target || strlen(source) != (size_t)sqlite3_value_bytes(argv[0]) ||
      strlen(target) != (size_t)sqlite3_value_bytes(argv[1])) goto failed;
  int status;
#ifdef __APPLE__
  status = renamex_np(source, target, RENAME_EXCL);
#elif defined(__linux__)
  status = renameat2(AT_FDCWD, source, AT_FDCWD, target, RENAME_NOREPLACE);
#else
  goto failed;
#endif
  if (status == 0) { sqlite3_result_int(context, 1); return; }
  if (errno == EEXIST) { sqlite3_result_int(context, 0); return; }
failed:
  sqlite3_result_error(context, "security_mutex_publish_failed", -1);
}

static void control_mutation(sqlite3_context *context, int argc, sqlite3_value **argv) {
  mutation_guard *guard = sqlite3_user_data(context);
  (void)argc;
  if (sqlite3_value_type(argv[0]) != SQLITE_BLOB || sqlite3_value_bytes(argv[0]) != 32 ||
      sqlite3_value_type(argv[1]) != SQLITE_INTEGER) goto rejected;
  sqlite3_int64 enabled = sqlite3_value_int64(argv[1]);
  const unsigned char *token = sqlite3_value_blob(argv[0]);
  if (!token) goto rejected;
  if (enabled == 1 && !guard->active && !sqlite3_get_autocommit(guard->database)) {
    memcpy(guard->token, token, 32);
    if (sqlite3_set_authorizer(guard->database, authorize_mutation, guard) != SQLITE_OK) goto rejected;
    guard->active = 1;
  } else if (enabled == 0 && guard->active) {
    unsigned int difference = 0;
    for (int i = 0; i < 32; i++) difference |= guard->token[i] ^ token[i];
    if (difference || sqlite3_set_authorizer(guard->database, 0, 0) != SQLITE_OK) goto rejected;
    guard->active = 0;
    memset(guard->token, 0, 32);
  } else goto rejected;
  sqlite3_result_int(context, 1);
  return;
rejected:
  sqlite3_result_error(context, "security_sql_guard_unverified", -1);
}

/* Ask SQLite's own open file, not a second pathname lookup. No extra file
 * descriptor is opened or closed on a database that may hold POSIX locks. */
static void file_identity_ok(sqlite3_context *context, int argc, sqlite3_value **argv) {
  int moved = -1;
  (void)argc;
  (void)argv;
  int status = sqlite3_file_control(sqlite3_context_db_handle(context), "main", SQLITE_FCNTL_HAS_MOVED, &moved);
  if (status != SQLITE_OK || (moved != 0 && moved != 1)) {
    sqlite3_result_error(context, "security_file_identity_unavailable", -1);
    return;
  }
  sqlite3_result_int(context, moved == 0);
}

int sqlite3_extension_init(sqlite3 *database, char **error, const sqlite3_api_routines *api) {
  (void)error;
  SQLITE_EXTENSION_INIT2(api);
  int status = sqlite3_create_function(database, "dona_file_identity_ok", 0,
    SQLITE_UTF8 | SQLITE_DIRECTONLY, 0, file_identity_ok, 0, 0);
  if (status != SQLITE_OK) return status;
  status = sqlite3_create_function(database, "dona_publish_mutex", 2,
    SQLITE_UTF8 | SQLITE_DIRECTONLY, 0, publish_mutex, 0, 0);
  if (status != SQLITE_OK) return status;
  mutation_guard *guard = sqlite3_malloc(sizeof(*guard));
  if (!guard) return SQLITE_NOMEM;
  memset(guard, 0, sizeof(*guard));
  guard->database = database;
  return sqlite3_create_function_v2(database, "dona_mutation_guard", 2,
    SQLITE_UTF8 | SQLITE_DIRECTONLY, guard, control_mutation, 0, 0, sqlite3_free);
}
