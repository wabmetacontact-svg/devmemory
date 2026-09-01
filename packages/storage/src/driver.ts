/**
 * Storage driver interface (PRD 12: "architecture must use interfaces so future
 * alternatives can be added"). The default implementation is node:sqlite, which
 * needs no native build step; a better-sqlite3 or libsql driver can be dropped in
 * behind this interface without touching any engine code.
 */
export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface SqliteStatement {
  all<T = SqlRow>(...params: SqlValue[]): T[];
  get<T = SqlRow>(...params: SqlValue[]): T | undefined;
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface SqliteDatabase {
  readonly file: string;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: () => T): T;
  close(): void;
  readonly isOpen: boolean;
}

export interface OpenOptions {
  readOnly?: boolean;
}

export interface SqliteDriver {
  readonly name: string;
  open(file: string, options?: OpenOptions): SqliteDatabase;
}
