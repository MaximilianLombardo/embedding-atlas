// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

/**
 * Security guard for model-emitted chart specs (`add_chart`,
 * `render_chart_in_chat`).
 *
 * The chat assistant can hand a `spec: any` object straight into the shared
 * Mosaic coordinator. The existing JSON-schema `validate()` check enforces the
 * *shape* of a spec, but two risks remain that a structural schema does not
 * cover:
 *
 *   1. Unknown / dangerous fields — a malicious or confabulated spec could
 *      carry a `type` we don't render, or smuggle keys (`__proto__`,
 *      `constructor`, `prototype`) that pollute prototypes when the spec is
 *      merged into chart state.
 *   2. Chart-embedded SQL — SQLField / SQLTable (`{ sql: "…" }`), an
 *      InstancesSpec `query`, and PredicatesSpec `items[].predicate` are all
 *      SQL the model controls. They are executed against the dataset
 *      connection, so they must be read-only and single-statement, exactly
 *      like the chat `run_sql_query` path.
 *
 * This module is deliberately standalone (no chart-runtime imports) so it can
 * be unit-tested in isolation and wired into the tool handlers with a single
 * call. It is a *gate*, not a transformer: it never rewrites the spec, only
 * accepts or rejects it.
 */

/**
 * Chart `type` values the assistant is allowed to emit through add_chart /
 * render_chart_in_chat. Layered charts (`ChartSpec`) and `EmbeddingSpec` have
 * no `type` discriminator, so a spec with no `type` is allowed through to the
 * schema validator. Everything that *does* declare a type must be on this
 * list — this rejects unknown/future types the runtime can't render.
 */
const ALLOWED_CHART_TYPES = new Set(["count-plot", "predicates", "instances", "markdown", "content-viewer"]);

/**
 * Object keys that must never appear anywhere in a spec. These are the
 * prototype-pollution vectors; a spec carrying them is rejected outright
 * rather than sanitized.
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Leading SQL keywords that must never start an embedded SQL fragment, even
 * the InstancesSpec `query` body. Mirrors the backend chat guard
 * (`_FORBIDDEN_LEADING_KEYWORDS`): these are writes / DDL / side-effecting or
 * statement-control keywords that have no place in a read-only chart query.
 */
const FORBIDDEN_SQL_LEADING_KEYWORDS = new Set([
  "insert",
  "update",
  "delete",
  "create",
  "drop",
  "alter",
  "truncate",
  "replace",
  "merge",
  "attach",
  "detach",
  "copy",
  "pragma",
  "call",
  "set",
  "reset",
  "install",
  "load",
  "export",
  "import",
  "use",
  "begin",
  "commit",
  "rollback",
  "checkpoint",
  "vacuum",
  "grant",
  "revoke",
]);

export interface ChartSpecGuardResult {
  ok: boolean;
  /** Human-readable rejection reason, only set when `ok` is false. */
  error?: string;
}

/**
 * Reject a SQL fragment / query that could break out of the single read-only
 * statement we intend to run. SQLField expressions and predicates are
 * fragments spliced into a larger SELECT, so a `;` (statement chaining) or a
 * comment marker (`--`, `/*`) that could neuter the rest of the query is
 * disallowed — the same contract the backend predicate guard enforces. An
 * InstancesSpec `query` is a full body, so we additionally reject a dangerous
 * leading keyword.
 */
function checkSqlString(sql: string, where: string, isFullQuery: boolean): string | null {
  if (sql.includes(";")) {
    return `${where} must not contain ';' (statement chaining is not allowed).`;
  }
  if (sql.includes("--") || sql.includes("/*")) {
    return `${where} must not contain SQL comment markers ('--' or '/*').`;
  }
  if (isFullQuery) {
    const leading = sql
      .trim()
      .replace(/^\(+\s*/, "")
      .split(/\s+/, 1)[0]
      ?.toLowerCase()
      .replace(/[(;]+$/, "");
    if (leading && FORBIDDEN_SQL_LEADING_KEYWORDS.has(leading)) {
      return `${where} must be a read-only SELECT/WITH query (got '${leading}').`;
    }
  }
  return null;
}

/**
 * Recursively walk a spec value, enforcing the forbidden-key and embedded-SQL
 * rules. Returns the first rejection reason found, or null if clean.
 *
 * SQL surfaces recognized:
 *   - `{ sql: <string> }`         SQLField / SQLTable / aggregate expression
 *   - `query: <string>`           InstancesSpec custom query (full body)
 *   - `items: [{ predicate }]`    PredicatesSpec predicate fragments
 */
function walk(value: any, path: string, depth: number): string | null {
  // Guard against pathological / cyclic specs blowing the stack.
  if (depth > 64) {
    return `${path}: spec is nested too deeply.`;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const err = walk(value[i], `${path}[${i}]`, depth + 1);
      if (err) return err;
    }
    return null;
  }
  if (value === null || typeof value !== "object") {
    return null;
  }

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return `${path}: forbidden key '${key}'.`;
    }
    const child = value[key];

    // `{ sql: "<expr>" }` — a raw SQL fragment (SQLField / SQLTable /
    // aggregate). Treat as a fragment, not a full query.
    if (key === "sql" && typeof child === "string") {
      const err = checkSqlString(child, `${path}.sql`, false);
      if (err) return err;
      continue;
    }
    // InstancesSpec `query` — a full SQL body the runtime substitutes
    // `$table` / `$filter` into, so apply the stricter full-query check.
    if (key === "query" && typeof child === "string") {
      const err = checkSqlString(child, `${path}.query`, true);
      if (err) return err;
      continue;
    }
    // PredicatesSpec `items[].predicate` — a SQL WHERE fragment.
    if (key === "predicate" && typeof child === "string") {
      const err = checkSqlString(child, `${path}.predicate`, false);
      if (err) return err;
      continue;
    }

    const err = walk(child, `${path}.${key}`, depth + 1);
    if (err) return err;
  }
  return null;
}

/**
 * Validate a model-emitted chart spec against the strict allowlist before it
 * is accepted into chart state or the chat coordinator. Run this *in addition
 * to* the JSON-schema `validate()` check (which enforces field shapes); this
 * guard covers the type allowlist, prototype-pollution keys, and embedded SQL.
 */
export function validateChartSpec(spec: any): ChartSpecGuardResult {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    return { ok: false, error: "Chart spec must be an object." };
  }
  if (typeof spec.type === "string" && !ALLOWED_CHART_TYPES.has(spec.type)) {
    return { ok: false, error: `Unknown chart type '${spec.type}'.` };
  }
  const err = walk(spec, "spec", 0);
  if (err) {
    return { ok: false, error: err };
  }
  return { ok: true };
}
