// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

// Read-only guard for the viewer-side `run_sql_query` MCP tool.
//
// The chat agent (and, transitively, untrusted row content / prompt
// injection) can author the SQL that flows through the viewer's
// `run_sql_query` bridge into `coordinator.query()`. The backend chat path
// is already guarded by `_guard_select` (chat.py), which uses DuckDB's own
// `extract_statements` parser. The viewer bridge is a *separate* execution
// path and was previously unguarded — this is the matching second layer.
//
// DuckDB-WASM does not expose a statement parser to JS, so this guard is
// lexical rather than structural. It is intentionally fail-closed: anything
// it can't confidently classify as a single read-only statement is rejected,
// and the model is free to rewrite. The browser DuckDB handle has no
// filesystem/external access, so the threat we're closing is mutation of the
// shared in-memory table (INSERT/UPDATE/DELETE/DROP/…) and side-effecting
// engine statements (ATTACH/COPY/PRAGMA/INSTALL/LOAD/…), not RCE.

/** Result of guarding a SQL string. */
export type SqlGuardResult = { ok: true } | { ok: false; error: string };

// Side-effecting / engine statements that have no place in a read query.
// Matched as whole words anywhere in the (de-stringed, de-commented) text so
// they're caught even if smuggled past the leading-keyword check. These are
// not ordinary column names, so a whole-word match is low-false-positive.
const FORBIDDEN_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "drop",
  "create",
  "alter",
  "truncate",
  "merge",
  "attach",
  "detach",
  "copy",
  "pragma",
  "install",
  "load",
  "export",
  "import",
  "use",
  "set",
  "reset",
  "call",
  "begin",
  "commit",
  "rollback",
  "checkpoint",
  "vacuum",
  "analyze",
  "grant",
  "revoke",
];

const FORBIDDEN_RE = new RegExp(`\\b(?:${FORBIDDEN_KEYWORDS.join("|")})\\b`, "i");

/**
 * Strip string literals, identifier quotes, and comments so the structural
 * checks below see only SQL keywords/operators — not user data that happens
 * to contain a semicolon or the word "delete". Replaces each removed span
 * with a single space to preserve token boundaries.
 */
function stripLiteralsAndComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    // Line comment: -- ... \n
    if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    // Block comment: /* ... */
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    // Single-quoted string, double-quoted identifier, or dollar quote: skip
    // to the matching close. SQL escapes a quote by doubling it, which this
    // loop handles naturally (the doubled quote re-opens then immediately
    // closes), so the whole literal is still consumed.
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The first whitespace/punctuation-delimited token, lowercased. */
function leadingKeyword(sql: string): string {
  const stripped = sql.replace(/^[\s(]+/, "");
  const token = stripped.split(/[\s(;]/, 1)[0] ?? "";
  return token.toLowerCase();
}

/**
 * Return `{ ok: true }` if `sql` is a single read-only statement, else
 * `{ ok: false, error }`. Accepts exactly one `SELECT`/`WITH` statement
 * (DuckDB has no data-modifying CTEs, so a `WITH` body cannot hide a write),
 * rejects statement chaining, and denylists side-effecting keywords.
 */
export function guardReadOnlySql(sql: string): SqlGuardResult {
  const stripped = sql
    .trim()
    .replace(/;+\s*$/, "")
    .trim();
  if (!stripped) {
    return { ok: false, error: "Empty query." };
  }

  const sanitized = stripLiteralsAndComments(stripped);

  // Statement chaining: any semicolon left after trimming the trailing one
  // (and once string literals are removed) means a second statement.
  if (sanitized.includes(";")) {
    return { ok: false, error: "Only a single statement is allowed." };
  }

  const leading = leadingKeyword(sanitized);
  if (leading !== "select" && leading !== "with") {
    return {
      ok: false,
      error: "Only read-only SELECT/WITH queries are allowed.",
    };
  }

  if (FORBIDDEN_RE.test(sanitized)) {
    return {
      ok: false,
      error: "Only read-only SELECT/WITH queries are allowed (no DDL/DML).",
    };
  }

  return { ok: true };
}
