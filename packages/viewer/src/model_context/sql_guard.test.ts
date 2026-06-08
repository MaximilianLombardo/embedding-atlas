// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import { describe, expect, it } from "vitest";
import { guardReadOnlySql } from "./sql_guard.js";

describe("guardReadOnlySql", () => {
  it("accepts a plain SELECT", () => {
    expect(guardReadOnlySql("SELECT id, title FROM dataset LIMIT 5").ok).toBe(true);
  });

  it("accepts a WITH/CTE read query", () => {
    const sql = "WITH t AS (SELECT id, year FROM dataset) SELECT * FROM t WHERE year > 2020";
    expect(guardReadOnlySql(sql).ok).toBe(true);
  });

  it("tolerates a trailing semicolon and surrounding whitespace", () => {
    expect(guardReadOnlySql("  SELECT 1 ;  ").ok).toBe(true);
  });

  it("accepts a leading open-paren before SELECT", () => {
    expect(guardReadOnlySql("(SELECT id FROM dataset)").ok).toBe(true);
  });

  it.each([
    "DELETE FROM dataset",
    "DROP TABLE dataset",
    "UPDATE dataset SET x = 1",
    "INSERT INTO dataset VALUES (1)",
    "ALTER TABLE dataset ADD COLUMN x INT",
    "ATTACH 'evil.db' AS e",
    "COPY dataset TO 'out.csv'",
    "PRAGMA database_list",
    "INSTALL httpfs",
    "LOAD httpfs",
    "SET memory_limit = '1GB'",
    "CALL pragma_version()",
  ])("rejects the write/side-effect statement: %s", (sql) => {
    expect(guardReadOnlySql(sql).ok).toBe(false);
  });

  it("rejects statement chaining via semicolon", () => {
    const r = guardReadOnlySql("SELECT 1; DROP TABLE dataset");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/single statement/i);
  });

  it("rejects a forbidden keyword smuggled after a CTE", () => {
    // DuckDB has no data-modifying CTEs, but the denylist scan is belt-and-
    // suspenders against anything the leading-keyword check would miss.
    expect(guardReadOnlySql("WITH t AS (SELECT 1) DELETE FROM dataset").ok).toBe(false);
  });

  it("rejects an empty query", () => {
    expect(guardReadOnlySql("   ").ok).toBe(false);
    expect(guardReadOnlySql(";").ok).toBe(false);
  });

  it("does not false-positive on a string literal containing a semicolon", () => {
    expect(guardReadOnlySql("SELECT id FROM dataset WHERE title = 'a; b; c'").ok).toBe(true);
  });

  it("does not false-positive on a string literal containing a keyword", () => {
    expect(guardReadOnlySql("SELECT id FROM dataset WHERE note = 'please delete this'").ok).toBe(true);
  });

  it("does not false-positive on a comment containing a semicolon", () => {
    expect(guardReadOnlySql("SELECT id FROM dataset -- drop; this\n").ok).toBe(true);
  });

  it("does not match substrings (e.g. column named set_value)", () => {
    expect(guardReadOnlySql("SELECT set_value, updated_at FROM dataset").ok).toBe(true);
  });
});
