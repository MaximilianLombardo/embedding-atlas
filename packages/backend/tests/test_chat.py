# Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import asyncio
import json

import duckdb
import pytest

from embedding_atlas.chat import (
    CITED_ROWS_CAP,
    _build_refine_system_prompt,
    _build_system_prompt,
    _extract_cited_rows,
    _guard_select,
    _looks_safe_predicate,
    _run_sql_tool,
    refine_prompt,
)


def _prompt(sample):
    return _build_system_prompt(
        predicate=None,
        table="data",
        text_column=None,
        row_count=None,
        sample=sample,
        has_sql_tool=False,
    )


def test_no_citation_columns_omits_instruction():
    prompt = _prompt([{"text": "hello", "score": 1.0}])
    assert "doi.org" not in prompt
    assert "scholarly/paper-shaped" not in prompt


def test_empty_sample_omits_instruction():
    prompt = _prompt([])
    assert "scholarly/paper-shaped" not in prompt


def test_doi_takes_priority():
    prompt = _prompt(
        [
            {
                "doi": "10.1/x",
                "arxiv_id": "1",
                "pmid": "2",
                "url": "http://x",
                "title": "T",
            }
        ]
    )
    assert "https://doi.org/{doi}" in prompt
    assert "scholarly/paper-shaped" in prompt


def test_arxiv_when_no_doi():
    prompt = _prompt(
        [{"arxiv_id": "1234.5678", "pmid": "9", "url": "http://x", "title": "T"}]
    )
    assert "https://arxiv.org/abs/{arxiv_id}" in prompt


def test_pmid_when_no_doi_or_arxiv():
    prompt = _prompt([{"pmid": "9", "url": "http://x", "title": "T"}])
    assert "https://pubmed.ncbi.nlm.nih.gov/{pmid}/" in prompt


def test_url_when_no_identifiers():
    prompt = _prompt([{"url": "http://x", "title": "T"}])
    assert "[Title]({url})" in prompt


def test_title_only_uses_bold_quote():
    prompt = _prompt([{"title": "T", "authors": "A"}])
    assert '**"Title"**' in prompt


def test_case_insensitive_detection():
    prompt = _prompt([{"DOI": "10.1/x", "Title": "T"}])
    assert "https://doi.org/{doi}" in prompt


# ─── _extract_cited_rows ─────────────────────────────────────────────────


def test_cited_rows_from_local_sql_envelope():
    payload = json.dumps(
        {
            "rows": [
                {"id": 1, "text": "a"},
                {"id": 2, "text": "b"},
                {"id": 3, "text": "c"},
            ],
            "row_count": 3,
            "truncated": False,
        }
    )
    assert _extract_cited_rows(payload, "id") == [
        {"id": 1, "label": "a"},
        {"id": 2, "label": "b"},
        {"id": 3, "label": "c"},
    ]


def test_cited_rows_picks_title_over_text():
    payload = json.dumps(
        {"rows": [{"id": 1, "title": "Hello", "text": "Long abstract..."}]}
    )
    assert _extract_cited_rows(payload, "id") == [{"id": 1, "label": "Hello"}]


def test_cited_rows_falls_back_to_first_string_column():
    payload = json.dumps(
        {"rows": [{"id": 5, "doi": "10.1/foo", "year": 2024}]}
    )
    assert _extract_cited_rows(payload, "id") == [
        {"id": 5, "label": "10.1/foo"}
    ]


def test_cited_rows_truncates_long_labels():
    long_title = "x" * 500
    payload = json.dumps({"rows": [{"id": 1, "title": long_title}]})
    result = _extract_cited_rows(payload, "id")
    assert result[0]["id"] == 1
    assert result[0]["label"].endswith("…")
    assert len(result[0]["label"]) <= 100


def test_cited_rows_label_none_when_no_string_columns():
    payload = json.dumps({"rows": [{"id": 7, "year": 2024, "count": 12}]})
    assert _extract_cited_rows(payload, "id") == [{"id": 7, "label": None}]


def test_cited_rows_from_bare_array():
    payload = json.dumps([{"row_id": "x", "title": "A"}, {"row_id": "y", "title": "B"}])
    assert _extract_cited_rows(payload, "row_id") == [
        {"id": "x", "label": "A"},
        {"id": "y", "label": "B"},
    ]


def test_cited_rows_dedupes_preserving_order():
    payload = json.dumps(
        {"rows": [{"id": 1, "title": "a"}, {"id": 2, "title": "b"}, {"id": 1, "title": "a"}, {"id": 3, "title": "c"}]}
    )
    assert _extract_cited_rows(payload, "id") == [
        {"id": 1, "label": "a"},
        {"id": 2, "label": "b"},
        {"id": 3, "label": "c"},
    ]


def test_cited_rows_caps_at_limit():
    payload = json.dumps(
        {"rows": [{"id": i, "title": f"row {i}"} for i in range(CITED_ROWS_CAP + 5)]}
    )
    extracted = _extract_cited_rows(payload, "id")
    assert len(extracted) == CITED_ROWS_CAP
    assert extracted[0] == {"id": 0, "label": "row 0"}


def test_cited_rows_empty_when_id_column_absent():
    payload = json.dumps({"rows": [{"text": "hi"}]})
    assert _extract_cited_rows(payload, "id") == []


def test_cited_rows_empty_when_no_id_column_configured():
    payload = json.dumps({"rows": [{"id": 1}]})
    assert _extract_cited_rows(payload, None) == []


def test_cited_rows_empty_for_plain_text():
    assert _extract_cited_rows("Just a text answer.", "id") == []


def test_cited_rows_empty_for_invalid_json():
    assert _extract_cited_rows("{not json", "id") == []


def test_cited_rows_empty_for_non_string_content():
    assert _extract_cited_rows(None, "id") == []
    assert _extract_cited_rows([{"id": 1}], "id") == []


def test_cited_rows_empty_when_rows_missing():
    payload = json.dumps({"row_count": 0})
    assert _extract_cited_rows(payload, "id") == []


# ─── read-only SQL guard ───────────────────────────────────────────────────


@pytest.fixture
def con():
    c = duckdb.connect(":memory:")
    c.sql("CREATE TABLE dataset AS SELECT * FROM (VALUES (1, 'a'), (2, 'b')) t(id, name)")
    yield c
    c.close()


# Statements that must be ACCEPTED (plain reads, including CTEs).
ACCEPTED_SQL = [
    "SELECT * FROM dataset",
    "select id, name from dataset where id > 0",
    "WITH x AS (SELECT id FROM dataset) SELECT * FROM x",
    "with recent as (select * from dataset where id > 1) select count(*) from recent",
    "SELECT COUNT(*) FROM dataset",
    "  SELECT 1  ",
    "SELECT * FROM dataset;",  # trailing semicolon is stripped, single statement
]

# Statements that must be REJECTED (writes, DDL, side-effecting, multi-stmt).
REJECTED_SQL = [
    "COPY dataset TO '/tmp/exfil.csv'",
    "COPY (SELECT * FROM dataset) TO '/tmp/exfil.csv'",
    "ATTACH 'evil.db' AS evil",
    "ATTACH 'evil.db'",
    "DETACH evil",
    "PRAGMA database_list",  # parses as SELECT but must be blocked lexically
    "pragma version",
    "INSTALL httpfs",
    "LOAD httpfs",
    "SET enable_external_access=true",
    "RESET memory_limit",
    "CALL pragma_version()",
    "INSERT INTO dataset VALUES (3, 'c')",
    "UPDATE dataset SET name='x'",
    "DELETE FROM dataset",
    "CREATE TABLE evil AS SELECT 1",
    "DROP TABLE dataset",
    "SELECT 1; DROP TABLE dataset",  # multiple statements
    "SELECT 1; SELECT 2",  # multiple statements, both reads
    "",  # empty
    "   ",  # whitespace only
    # CTE-wrapped write: DuckDB's parser rejects DML inside a CTE, so the
    # guard surfaces a parse error rather than silently accepting it.
    "WITH w AS (INSERT INTO dataset VALUES (9, 'z') RETURNING id) SELECT * FROM w",
]


@pytest.mark.parametrize("sql", ACCEPTED_SQL)
def test_guard_accepts_reads(con, sql):
    ok, error = _guard_select(con, sql)
    assert ok, f"expected accept, got error: {error!r}"
    assert error is None


@pytest.mark.parametrize("sql", REJECTED_SQL)
def test_guard_rejects_non_reads(con, sql):
    ok, error = _guard_select(con, sql)
    assert not ok, f"expected reject for: {sql!r}"
    assert isinstance(error, str) and error


def test_run_sql_tool_executes_select(con):
    text, is_error = _run_sql_tool(con, "SELECT id, name FROM dataset ORDER BY id")
    assert not is_error
    payload = json.loads(text)
    assert payload["row_count"] == 2
    assert payload["rows"][0]["name"] == "a"


def test_run_sql_tool_blocks_copy(con):
    text, is_error = _run_sql_tool(con, "COPY dataset TO '/tmp/exfil.csv'")
    assert is_error
    assert "read-only" in text.lower() or "allowed" in text.lower()


def test_run_sql_tool_blocks_cte_wrapped_write(con):
    text, is_error = _run_sql_tool(
        con, "WITH w AS (INSERT INTO dataset VALUES (9,'z') RETURNING id) SELECT * FROM w"
    )
    assert is_error


def test_run_sql_tool_accepts_plain_cte(con):
    text, is_error = _run_sql_tool(
        con, "WITH x AS (SELECT id FROM dataset) SELECT count(*) AS n FROM x"
    )
    assert not is_error
    payload = json.loads(text)
    assert payload["rows"][0]["n"] == 2


# ─── predicate guard ───────────────────────────────────────────────────────


def test_predicate_guard_accepts_simple():
    assert _looks_safe_predicate("year > 2020 AND domain = 'x'")
    assert _looks_safe_predicate(None)


def test_predicate_guard_rejects_semicolon_and_comments():
    assert not _looks_safe_predicate("1=1; DROP TABLE dataset")
    assert not _looks_safe_predicate("1=1 -- comment")


# ─── optional prompt refinement ────────────────────────────────────────────


def test_refine_prompt_injects_selection_and_capabilities():
    prompt = _build_refine_system_prompt(
        predicate="cluster = 3",
        table="dataset",
        text_column="abstract",
        row_count=1240,
        sample=[{"id": 1, "title": "T", "doi": "10.1/x", "abstract": "a"}],
    )
    # Rewriter framing, not analyst framing.
    assert "rewrite" in prompt.lower()
    assert "Output ONLY the rewritten prompt" in prompt
    # Context injection: schema, selection + count, capability + domain surface.
    assert "`dataset`" in prompt
    assert "cluster = 3" in prompt
    assert "1240 rows" in prompt
    assert "retrieve" in prompt  # text column → retrieve capability mentioned
    assert "scholarly/paper-shaped" in prompt  # doi → domain hint
    # Deixis resolution against the live selection.
    assert "these" in prompt.lower()


def test_refine_prompt_no_selection_branch():
    prompt = _build_refine_system_prompt(
        predicate=None,
        table="dataset",
        text_column=None,
        row_count=None,
        sample=[],
    )
    assert "no selection is active" in prompt
    # No text column → retrieve capability is omitted.
    assert "retrieve" not in prompt
    # Deixis guidance still present for the no-selection case.
    assert "lasso" in prompt.lower()


def test_refine_prompt_empty_prompt_is_noop():
    result = asyncio.run(
        refine_prompt(
            {"prompt": "   ", "context": {}},
            duckdb_connection=None,
            table="dataset",
        )
    )
    assert result["refined_applied"] is False
    assert result["refined"] == ""
    assert result["reason"] == "empty prompt"


def test_refine_prompt_falls_back_without_api_key(monkeypatch):
    # With no API key available, refine degrades to echoing the original prompt
    # so the composer can just send what the user typed.
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_KEY", raising=False)
    result = asyncio.run(
        refine_prompt(
            {"prompt": "summarize these", "context": {"predicate": "cluster = 3"}},
            duckdb_connection=None,
            table="dataset",
        )
    )
    assert result["refined_applied"] is False
    assert result["refined"] == "summarize these"
    assert result["original"] == "summarize these"
    assert "no API key" in (result["reason"] or "")
    assert not _looks_safe_predicate("1=1 /* comment */")
