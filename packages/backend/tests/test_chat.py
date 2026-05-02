# Copyright (c) 2025 Apple Inc. Licensed under MIT License.

from embedding_atlas.chat import _build_system_prompt


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
        [{"doi": "10.1/x", "arxiv_id": "1", "pmid": "2", "url": "http://x", "title": "T"}]
    )
    assert "https://doi.org/{doi}" in prompt
    assert "scholarly/paper-shaped" in prompt


def test_arxiv_when_no_doi():
    prompt = _prompt([{"arxiv_id": "1234.5678", "pmid": "9", "url": "http://x", "title": "T"}])
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
