# Copyright (c) 2025 Apple Inc. Licensed under MIT License.

"""Tests for compute_projection using a placeholder embedder (no real models)."""

import io
import shutil

import numpy as np
import pandas as pd
import polars as pl
import pyarrow as pa
import pytest
from embedding_atlas.embedding import create_embedder
from embedding_atlas.projection import EMBEDDING_STAMP_VERSION, compute_projection
from PIL import Image

NUM_SAMPLES = 30
EMBEDDING_DIM = 16


async def _fake_embedder(batch: list, *, model, embedder_args) -> np.ndarray:
    """Return deterministic random vectors seeded by batch length."""
    rng = np.random.RandomState(len(batch))
    return rng.randn(len(batch), EMBEDDING_DIM).astype(np.float32)


def _make_random_image_bytes(width=64, height=64, seed=0) -> bytes:
    rng = np.random.RandomState(seed)
    pixels = rng.randint(0, 255, (height, width, 3), dtype=np.uint8)
    img = Image.fromarray(pixels, "RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture()
def cache_root(tmp_path):
    path = tmp_path / "cache"
    path.mkdir()
    yield path
    shutil.rmtree(path, ignore_errors=True)


@pytest.fixture()
def text_df():
    return pd.DataFrame({"text": [f"sentence {i}" for i in range(NUM_SAMPLES)]})


@pytest.fixture()
def image_df():
    images = [{"bytes": _make_random_image_bytes(seed=i)} for i in range(NUM_SAMPLES)]
    return pd.DataFrame({"image": images})


@pytest.fixture()
def vector_df():
    rng = np.random.RandomState(42)
    vectors = [rng.randn(EMBEDDING_DIM).astype(np.float32) for _ in range(NUM_SAMPLES)]
    return pd.DataFrame({"vec": vectors})


# ---------------------------------------------------------------------------
# Text modality
# ---------------------------------------------------------------------------


def test_text(text_df, cache_root):
    result = compute_projection(
        text_df,
        inputs="text",
        modality="text",
        embedder=_fake_embedder,
        cache_root=cache_root,
    )
    assert "projection_x" in result.columns
    assert "projection_y" in result.columns
    assert "neighbors" in result.columns
    assert len(result) == NUM_SAMPLES


def test_text_auto_modality(text_df, cache_root):
    result = compute_projection(
        text_df,
        inputs="text",
        modality="auto",
        embedder=_fake_embedder,
        cache_root=cache_root,
    )
    assert len(result) == NUM_SAMPLES
    assert result["projection_x"].notna().all()


# ---------------------------------------------------------------------------
# Image modality
# ---------------------------------------------------------------------------


def test_image(image_df, cache_root):
    result = compute_projection(
        image_df,
        inputs="image",
        modality="image",
        embedder=_fake_embedder,
        cache_root=cache_root,
    )
    assert len(result) == NUM_SAMPLES
    assert "projection_x" in result.columns


def test_image_auto_modality(image_df, cache_root):
    result = compute_projection(
        image_df,
        inputs="image",
        modality="auto",
        embedder=_fake_embedder,
        cache_root=cache_root,
    )
    assert len(result) == NUM_SAMPLES


# ---------------------------------------------------------------------------
# Vector modality (no embedder needed)
# ---------------------------------------------------------------------------


def test_vector(vector_df, cache_root):
    result = compute_projection(
        vector_df,
        inputs="vec",
        modality="vector",
        cache_root=cache_root,
    )
    assert len(result) == NUM_SAMPLES
    assert "projection_x" in result.columns


def test_vector_auto_modality(vector_df, cache_root):
    result = compute_projection(
        vector_df,
        inputs="vec",
        modality="auto",
        cache_root=cache_root,
    )
    assert len(result) == NUM_SAMPLES


# ---------------------------------------------------------------------------
# Custom embedder receives correct data
# ---------------------------------------------------------------------------


def test_custom_embedder_receives_text_strings(text_df, cache_root):
    """Verify the custom embedder receives canonical text (list[str])."""
    received = []

    async def capture_embedder(batch, *, model, embedder_args):
        received.extend(batch)
        rng = np.random.RandomState(0)
        return rng.randn(len(batch), EMBEDDING_DIM).astype(np.float32)

    compute_projection(
        text_df,
        inputs="text",
        modality="text",
        embedder=capture_embedder,
        cache_root=cache_root,
    )
    assert len(received) == NUM_SAMPLES
    assert all(isinstance(item, str) for item in received)


def test_custom_embedder_receives_image_dicts(image_df, cache_root):
    """Verify the custom embedder receives canonical image dicts."""
    received = []

    async def capture_embedder(batch, *, model, embedder_args):
        received.extend(batch)
        rng = np.random.RandomState(0)
        return rng.randn(len(batch), EMBEDDING_DIM).astype(np.float32)

    compute_projection(
        image_df,
        inputs="image",
        modality="image",
        embedder=capture_embedder,
        cache_root=cache_root,
    )
    assert len(received) == NUM_SAMPLES
    assert all(isinstance(item, dict) and "bytes" in item for item in received)


def test_custom_embedder_receives_model_and_args(text_df, cache_root):
    """Verify model and embedder_args are forwarded to the custom embedder."""
    captured_kwargs = {}

    async def capture_embedder(batch, *, model, embedder_args):
        captured_kwargs["model"] = model
        captured_kwargs["embedder_args"] = embedder_args
        rng = np.random.RandomState(0)
        return rng.randn(len(batch), EMBEDDING_DIM).astype(np.float32)

    compute_projection(
        text_df,
        inputs="text",
        modality="text",
        embedder=capture_embedder,
        model="my-model",
        embedder_args={"api_key": "test-key"},
        cache_root=cache_root,
    )
    assert captured_kwargs["model"] == "my-model"
    assert captured_kwargs["embedder_args"] == {"api_key": "test-key"}


# ---------------------------------------------------------------------------
# API behavior
# ---------------------------------------------------------------------------


def test_custom_column_names(text_df, cache_root):
    result = compute_projection(
        text_df,
        inputs="text",
        modality="text",
        x="cx",
        y="cy",
        neighbors="nn",
        embedder=_fake_embedder,
        cache_root=cache_root,
    )
    assert "cx" in result.columns
    assert "cy" in result.columns
    assert "nn" in result.columns


def test_no_neighbors(text_df, cache_root):
    result = compute_projection(
        text_df,
        inputs="text",
        modality="text",
        neighbors=None,
        embedder=_fake_embedder,
        cache_root=cache_root,
    )
    assert "projection_x" in result.columns
    assert "projection_y" in result.columns
    assert "neighbors" not in result.columns


def test_returns_new_dataframe(text_df, cache_root):
    original_columns = list(text_df.columns)
    result = compute_projection(
        text_df,
        inputs="text",
        modality="text",
        embedder=_fake_embedder,
        cache_root=cache_root,
    )
    assert list(text_df.columns) == original_columns
    assert "projection_x" not in text_df.columns
    assert result is not text_df


def test_preserves_original_data(text_df, cache_root):
    text_df["id"] = range(len(text_df))
    result = compute_projection(
        text_df,
        inputs="text",
        modality="text",
        embedder=_fake_embedder,
        cache_root=cache_root,
    )
    assert "id" in result.columns
    assert "text" in result.columns
    assert list(result["id"]) == list(range(NUM_SAMPLES))


def test_neighbors_structure(text_df, cache_root):
    result = compute_projection(
        text_df,
        inputs="text",
        modality="text",
        embedder=_fake_embedder,
        cache_root=cache_root,
    )
    for neighbor in result["neighbors"]:
        assert isinstance(neighbor, dict)
        assert "ids" in neighbor
        assert "distances" in neighbor


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------


def test_invalid_modality(text_df, cache_root):
    with pytest.raises(ValueError, match="Unknown modality"):
        compute_projection(
            text_df,
            inputs="text",
            modality="unknown",
            embedder=_fake_embedder,
            cache_root=cache_root,
        )


def test_invalid_column(text_df, cache_root):
    with pytest.raises(KeyError):
        compute_projection(
            text_df,
            inputs="nonexistent",
            modality="text",
            embedder=_fake_embedder,
            cache_root=cache_root,
        )


def test_unknown_embedder_name(text_df, cache_root):
    with pytest.raises(ValueError, match="Unknown embedder"):
        compute_projection(
            text_df,
            inputs="text",
            modality="text",
            embedder="nonexistent-engine",
            cache_root=cache_root,
        )


def test_sentence_transformers_rejects_image():
    with pytest.raises(NotImplementedError, match="only supports text"):
        create_embedder(
            "sentence-transformers", modality="image", model=None, embedder_args={}
        )


def test_underscore_embedder_name(text_df, cache_root):
    """Test that 'sentence_transformers' (underscore) is accepted and normalized.

    We can't do a full integration test without a real model, so we verify
    indirectly: pass a vector modality (which skips the embedder entirely)
    with the underscore variant to confirm it doesn't blow up on resolution.
    """
    rng = np.random.RandomState(42)
    vectors = [rng.randn(EMBEDDING_DIM).astype(np.float32) for _ in range(NUM_SAMPLES)]
    df = pd.DataFrame({"vec": vectors})
    result = compute_projection(
        df,
        inputs="vec",
        modality="vector",
        embedder="sentence_transformers",
        cache_root=cache_root,
    )
    assert len(result) == NUM_SAMPLES


# ---------------------------------------------------------------------------
# Polars backend
# ---------------------------------------------------------------------------


@pytest.fixture()
def text_pl():
    return pl.DataFrame({"text": [f"sentence {i}" for i in range(NUM_SAMPLES)]})


@pytest.fixture()
def vector_pl():
    rng = np.random.RandomState(42)
    vectors = [
        rng.randn(EMBEDDING_DIM).astype(np.float32).tolist() for _ in range(NUM_SAMPLES)
    ]
    return pl.DataFrame({"vec": vectors})


def test_text_polars(text_pl, cache_root):
    result = compute_projection(
        text_pl,
        inputs="text",
        modality="text",
        embedder=_fake_embedder,
        cache_root=cache_root,
    )
    assert isinstance(result, pl.DataFrame)
    assert "projection_x" in result.columns
    assert "projection_y" in result.columns
    assert "neighbors" in result.columns
    assert len(result) == NUM_SAMPLES


def test_vector_polars(vector_pl, cache_root):
    result = compute_projection(
        vector_pl,
        inputs="vec",
        modality="vector",
        cache_root=cache_root,
    )
    assert isinstance(result, pl.DataFrame)
    assert "projection_x" in result.columns
    assert len(result) == NUM_SAMPLES


# ---------------------------------------------------------------------------
# Embedding-model stamp + retained embedding column
# ---------------------------------------------------------------------------


def test_stamp_records_model_and_dim(text_df, cache_root):
    """stamp_out is populated with model id and output dimensions."""
    stamp: dict = {}
    compute_projection(
        text_df,
        inputs="text",
        modality="text",
        embedder=_fake_embedder,
        model="my-embedding-model",
        cache_root=cache_root,
        stamp_out=stamp,
    )
    assert stamp["model"] == "my-embedding-model"
    assert stamp["dimensions"] == EMBEDDING_DIM
    assert stamp["modality"] == "text"
    assert stamp["version"] == EMBEDDING_STAMP_VERSION
    assert isinstance(stamp["hash"], str) and len(stamp["hash"]) > 0
    assert stamp["normalization"] in ("l2", "none")
    # Embedding not retained by default -> no column info in the stamp.
    assert "column" not in stamp


def test_keep_embedding_retains_fixed_width_column(text_df, cache_root):
    """--keep-embedding retains a fixed-width FLOAT[N] array column."""
    stamp: dict = {}
    result = compute_projection(
        text_df,
        inputs="text",
        modality="text",
        embedder=_fake_embedder,
        cache_root=cache_root,
        keep_embedding=True,
        embedding="embedding",
        stamp_out=stamp,
    )
    assert "embedding" in result.columns
    # The retained column is a fixed-width array of length EMBEDDING_DIM.
    first = result["embedding"].iloc[0]
    assert len(list(first)) == EMBEDDING_DIM
    # Stamp records the retained column name + dim.
    assert stamp["column"] == "embedding"
    assert stamp["columnDim"] == EMBEDDING_DIM


def test_no_keep_embedding_discards_column(text_df, cache_root):
    """Default behavior discards the embedding (no column added)."""
    result = compute_projection(
        text_df,
        inputs="text",
        modality="text",
        embedder=_fake_embedder,
        cache_root=cache_root,
    )
    assert "embedding" not in result.columns


def test_stamp_detects_l2_normalization(text_df, cache_root):
    """L2-normalized embeddings are flagged as normalization='l2'."""

    async def unit_embedder(batch, *, model, embedder_args):
        rng = np.random.RandomState(len(batch))
        vecs = rng.randn(len(batch), EMBEDDING_DIM).astype(np.float32)
        vecs /= np.linalg.norm(vecs, axis=1, keepdims=True)
        return vecs

    stamp: dict = {}
    compute_projection(
        text_df,
        inputs="text",
        modality="text",
        embedder=unit_embedder,
        cache_root=cache_root,
        stamp_out=stamp,
    )
    assert stamp["normalization"] == "l2"


def test_retained_embedding_column_survives_parquet(text_df, cache_root):
    """The retained FLOAT[N] column roundtrips through parquet as fixed_size_list."""
    import pyarrow.parquet as pq
    from embedding_atlas.utils import to_parquet_bytes

    result = compute_projection(
        text_df,
        inputs="text",
        modality="text",
        embedder=_fake_embedder,
        cache_root=cache_root,
        keep_embedding=True,
        embedding="embedding",
    )
    table = pq.read_table(io.BytesIO(to_parquet_bytes(result)))
    field = table.schema.field("embedding")
    assert pa.types.is_fixed_size_list(field.type)
    assert field.type.list_size == EMBEDDING_DIM
