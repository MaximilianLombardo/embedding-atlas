# Data Formats

## Input Data

Embedding Atlas supports loading data from the following file formats:

- **Parquet** (`.parquet`)
- **JSONL** (`.jsonl`) — one JSON object per line
- **CSV** (`.csv`)

When using the [Python Notebook Widget](./widget.md) or [Streamlit Component](./streamlit.md), you can pass a **pandas DataFrame** directly.

## Column Display Types

Embedding Atlas provides several built-in renderers for displaying column values in the tooltip, instances view, and search results:

| Renderer          | Description                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `markdown`        | Render the value as Markdown.                                                                                              |
| `liquid-template` | Render the value with a [Liquid](https://liquidjs.com/) template. Options: `template` (string), defaults to `{{ value }}`. |
| `image`           | Render the value as an image. Options: `size` (number), the max width/height in pixels.                                    |
| `audio`           | Render the value as an audio player.                                                                                       |
| `url`             | Render the value as a clickable link.                                                                                      |
| `json`            | Render the value as formatted JSON.                                                                                        |
| `messages`        | Render the value as chat messages (OpenAI format).                                                                         |

## Image Data

Embedding Atlas can display images in tooltips and the instances view. Image column values can be provided in the following formats:

- **URL**: A string starting with `http://` or `https://` pointing to the image.
- **Data URL**: A string starting with `data:image/...` containing inline image data.
- **Base64 string**: A raw base64-encoded string (without the `data:` prefix). The image type will be auto-detected from the binary content.
- **Binary object**: An object with a `bytes` field containing a `Uint8Array` of image data, and an optional `path` field with the file name (used for type detection).

Supported image formats: **PNG**, **JPEG**, **TIFF**, **BMP**, **GIF**. The format must also be supported by the browser for display.

## Audio Data

Embedding Atlas can play audio in tooltips and the instances view. Audio column values can be provided in the following formats:

- **URL**: A string starting with `http://` or `https://` pointing to the audio file.
- **Data URL**: A string starting with `data:audio/...` containing inline audio data.
- **Base64 string**: A raw base64-encoded string (without the `data:` prefix). The audio type will be auto-detected from the binary content.
- **Binary object**: An object with a `bytes` field containing a `Uint8Array` of audio data, and an optional `path` field with the file name (used for type detection via file extension).

Supported audio formats: **MP3**, **WAV**, **OGG**, **FLAC**, **AAC**, **M4A (MP4)**, **WebM**. The format must also be supported by the browser for playback.

## Embedding Stamp (`metadata.json`)

When the CLI computes embeddings at ingest, it records an embedding-model
"stamp" under the top-level `embedding` key of the exported `metadata.json`.
The stamp identifies the embedding space so a query/retrieval side can verify
**parity** (that query and corpus embeddings share the same space) before doing
vector RAG over the original embeddings.

| Field           | Type             | Description                                                                                                                       |
| --------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `version`       | number           | Schema version of the stamp.                                                                                                      |
| `modality`      | string           | The embedded modality: `text`, `image`, `audio`, or `vector`.                                                                     |
| `embedder`      | string \| null   | Backend used: `sentence-transformers`, `transformers`, `litellm`, a custom callable name, or `null` for the `vector` modality.    |
| `model`         | string \| null   | Resolved embedding model name when known (e.g. `all-MiniLM-L6-v2`).                                                               |
| `dimensions`    | number           | Output dimensionality `N` of the embedding.                                                                                       |
| `normalization` | string           | `l2` when row vectors are unit-norm (within tolerance), otherwise `none`.                                                          |
| `hash`          | string           | Short content hash over the identifying fields above; a cheap parity/version key.                                                 |
| `column`        | string           | _(only when retained)_ Name of the dataset column holding the high-dim embedding.                                                 |
| `columnDim`     | number           | _(only when retained)_ Fixed width `N` of that column.                                                                            |

### Retaining the high-dimensional embedding

By default the high-dimensional embedding is discarded after the 2D projection
is computed (preserving output size). Pass `--keep-embedding` to the CLI to
**retain** it in the dataset as a fixed-width `FLOAT[N]` (32-bit) array column,
suitable for DuckDB
[`array_cosine_distance`](https://duckdb.org/docs/sql/functions/array). When
retained, the stamp's `column` and `columnDim` fields point at it.

Size note: retaining adds roughly `N × 4` bytes per row to `dataset.parquet`
(before compression). For example, a 384-dim model adds on the order of ~1.5 KB
per row.
