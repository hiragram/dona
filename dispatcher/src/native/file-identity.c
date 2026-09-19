#include "sqlite3ext.h"
SQLITE_EXTENSION_INIT1

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
  return sqlite3_create_function(database, "dona_file_identity_ok", 0,
    SQLITE_UTF8 | SQLITE_DIRECTONLY, 0, file_identity_ok, 0, 0);
}
