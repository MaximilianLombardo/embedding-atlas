# Embedding Atlas — Chat Roadmap

> Status: living planning doc. Part A (the "chat polish pass", items A1–A6) shipped on
> `feat/chat-polish-pass`. Everything below is backlog, prioritized by **leverage × fit
> with what Embedding Atlas uniquely is**: a *selection-aware data copilot **and**
> UI-automation agent* over a live embedding map (Svelte 5 + DuckDB/Mosaic + WebGPU).
>
> The Tier breakdown below is backed by a 5-agent research pass (2026): a codebase
> inventory + four external surveys (consumer LLM chat, BI/data copilots, agentic
> dev-tools, and technical/hardening best practices). A second, deliberately *orthogonal*
> research pass (generative UI, visual grounding, latent-space-native chat, HCI reframes)
> is in progress — see "Orthogonal research" at the end.

## Where chat sits today (shipped)

Selection-aware: knows the current filter predicate + row count; runs read-only SQL.
Renders **inline live cross-filter-aware charts** (`render_chart_in_chat`) sharing the
Mosaic coordinator — this is our current "generative UI". Takes screenshots. Drives the
viewer via a **19-tool MCP bridge** (add/recolor/spec/state charts, `apply_filter` /
`clear_filter` through a visible Predicates panel, switch layout, screenshots). Streams
over SSE from a Python/Claude backend (default Opus for tool fidelity). Multiple chat
tabs in a side panel (list layout only); conversations persist to localStorage per
dataset. Polish pass A1–A6: stop/abort, persistence, smart autoscroll + jump-to-latest,
inline screenshots, retry + error strips, copy buttons, token-usage readout. Multi-tab
streams are pinned to their originating tab (cross-tab leak fixed).

## The strategic insight

Every comparable category solves a *different* problem: BI copilots (Genie, Cortex, Sage)
are metric/table-oriented; consumer chat is generic; agentic dev-tools drive code; the
closest analog, Nomic Atlas, only *labels* clusters. **None do selection-scoped,
contrastive reasoning over a live map** — and our architecture makes it cheap (we know the
active predicate + row count and own the entire viewer state). Two structural advantages
fall out of this:

- **Our "citations" are queries + rows**, not web pages: every number can click through to
  the exact SQL and rows behind it, then apply them as a filter. The strongest trust
  feature for a data copilot, and we have all the pieces.
- **We can do complete, deterministic undo** — almost no agent product can (Cursor/Windsurf/
  Replit all carry "revert covers tracked files only, not DB/deploy side effects"). Our
  agent's entire effect surface (chart specs, encodings, predicates, selection) is state we
  serialize, so snapshot-and-restore is genuinely achievable.
- **The Predicates panel is a free approval + preview surface**: agent-proposed filters can
  render *disabled/pending* until the user enables them — a gate and a diff with no new UI.

---

## Tier 0 — Security & correctness (do before leaning harder on the agent)

Net-new vs the original roadmap, and more urgent the moment we ship selection-summary
features (which pipe raw row text into the model).

| Item | Why | Effort | Lands in |
|---|---|---|---|
| **Capability-based read-only SQL** | Current guard is lexical (`startswith select`) → bypassable via `COPY … TO` / `ATTACH` / `PRAGMA` = local file write / exfil on DuckDB | S–M | open DuckDB handle read-only; `enable_external_access=false`, disable filesystems/extensions; `chat.py` `run_sql_query` + `_looks_safe_predicate` |
| **Prompt-injection trust boundaries** | Malicious row values / tool results / screenshot text can hijack the 19 mutation tools. Spotlighting (delimit untrusted data) + re-assert user instruction after tool results | S–M | `chat.py` `_build_system_prompt`, tool-result assembly |
| **Validate model-emitted chart specs** | `render_chart_in_chat` mounts `spec: any` into the shared coordinator unvalidated | M | strict schema (Zod/JSON-Schema); route chart SQL through the RO guard |
| **Output-sanitization hardening** | Copy-button HTML injected *after* DOMPurify; no link/img URL scheme allowlist (`javascript:`/`data:`/exfil-image) | S–M | `ChatView.renderMarkdown`, `sanitize.ts` |
| **Server-side cancellation on disconnect** | Orphaned Anthropic streams + agent subprocesses keep burning Opus after the user leaves | M | FastAPI handler (`request.is_disconnected()`); cancel tool `gather`; kill `claude` subprocess |

## Tier 1 — Unique differentiators (build these to stand out)

| Item | What | Status | Effort |
|---|---|---|---|
| **Contrastive "what's different about these rows vs. the rest"** | selection-vs-complement: distribution deltas, over-represented categories, distinctive tokens; compute in DuckDB, LLM narrates. The killer cluster-understanding feature. | new | M |
| **"Summarize this selection" as a first-class verb** | auto-scope query to active predicate | planned (#4) | S |
| **Reversible viewer-state checkpoints + one-click undo** | snapshot chart specs/colors/predicates/selection before each mutating turn; restore. Uniquely feasible for us. | elevates #9 | M |
| **Tool-call step cards + always-visible SQL + data provenance** | stream each tool call as an expandable card with a *domain* summary ("Filtered to year>2020 — 3,182 rows"); show the SQL; click a number → see/apply the rows behind it | extends #5 | M |
| **Tiered approval via the Predicates panel** | reads auto-run; mutations propose as *pending/disabled* until enabled (gate + preview, no new UI) | new | S–M |
| **Bidirectional chart/selection ↔ map cross-filter** | selecting in a chat chart pushes a predicate to the global filter; chat narrates the current selection | new | M |
| **Cluster labeling / naming** (Nomic-style) feeding recolor/legend | new | M |

## Tier 2 — Table-stakes we're missing

- **Slash commands over the 19 tools** (`/filter`, `/sql`, `/color by`, `/screenshot`, `/reset`) — skip the LLM for deterministic actions. *Planned (#10); confirmed highest-ROI command surface.* **M**
- **Optional prompt refinement ("refine" toggle / wand in the composer)** — a user-toggleable button that rewrites a rough typed prompt into a well-specified one *using EA's context* (schema + column meanings, the current selection + predicate + row count, the available tool/capability surface, citation columns, dataset domain) before it's sent to the agent. Show the refined prompt **editable** so the user can accept / tweak / revert. Pairs directly with deixis: "summarize these" → "Summarize the 1,240 currently-selected rows (`cluster = 3`), contrasting their distinguishing themes against the rest, and cite paper titles." Prior art: Anthropic prompt improver, ChatGPT/Gemini "enhance prompt", image-gen prompt enhancers. *new* **S–M** — a cheap model call + a composer toggle; lands in `ChatView` composer + a backend `/refine` path (or a fast-model call). *Maintainer-requested.*
- **Schema grounding up front + hard validation against the DuckDB catalog** → kills hallucinated columns; enables **refuse-and-suggest** instead of guessing. *new* **S–M**
- **Edit-and-resend a user message + regenerate any response** (truncate-variant first; branching later). *new* **S** (M–L for branching)
- **Result tables: truncation + total count + "show more"/export** (never inline thousands of rows; never silently truncate). *extends #6* **S–M**
- **Custom instructions / dataset-scoped memory** ("I'm a biologist; log scale; `emb_x/y` are UMAP coords"). *new* **S**
- **Collapsible streamed "thinking" block** (Claude `thinking_delta`) — trust before the agent mutates. *new* **M**
- **Self-repair**: feed SQL/predicate errors back as tool results so the agent fixes itself (cap retries); optional **verify-by-screenshot** after high-value mutations. *new* **M**

## Tier 3 — Strong adds / hardening

`@`-mention dataset entities (`@column`, `@selection`, `@chart`) · live plan/todo for
multi-step turns · editable/re-runnable SQL artifact · conversational chart re-spec ("make
it a bar, group by cluster") · paste-image into composer · auto-title tabs + cross-tab
search (#1) · conversation export (#2) · schema-aware starter chips (#3) · client model
picker / fast-vs-thinking toggle (#8) · inline-chart "save edited version" (#11) ·
**IndexedDB/Dexie + message IDs + schema versioning** (localStorage quota blows up on
base64 screenshots — real risk today) · **aria-live / role=log** accessibility · throttle
token→DOM + memoize markdown + virtualize long chats · OTel cost/TTFT tracing + rate limit
· idempotency keys for side-effecting tools + retry-with-backoff.

## Deferred infra (multi-user prerequisites)

Per-session WebSocket routing (replace the single `last_handler` with a session-keyed map;
two viewer tabs collide today — #12) · auth + per-user cost attribution (#13) · bridge
reconnection after WS drop (#14) · resumable streams (SSE event IDs + `streamId` + replay
endpoint, Vercel `resumable-stream` pattern).

## Recommended first sprint

① Tier-0 read-only + injection hardening (cheap, unblocks everything safely) · ②
contrastive selection-vs-rest + summarize-selection (the differentiator) · ③ undo via state
checkpoints · ④ tool-call step cards + provenance · ⑤ slash commands. Mostly S/M, plays to
our architecture, most defensible.

## Explicitly de-prioritized (poor fit)

Voice input · generic file upload (anti-pattern for single dataset) · hosted public share
links (no multi-user backend) · folders/archive/pinning · full message-tree branching with
sibling arrows (multi-tab already approximates it) · classifier-based "auto mode" (overkill
for single-user).

## Code-hardening backlog (non-chat)

~57 `any` types · silent `catch {}` blocks · no ESLint config · thin frontend test
coverage · 1000+ line components (`EmbeddingAtlas.svelte`, `runtime.ts`) to decompose.

---

## Orthogonal research (2026 pass 2) — the creative angles

Pass 1 was parity-driven (catch up to comparable products). Pass 2 attacked from four
deliberately orthogonal lenses. **Key meta-finding: most of these are unusually cheap
because the substrate already exists in the repo** — they're tool-surface + UI work, not
new infra:

- The WebGPU embedding canvas **already supports clean off-screen readback**
  (`EmbeddingViewImpl.svelte` overrides `toDataURL` to submit GPU commands first); coloring
  is already a spec patch, filtering a predicate, camera a `viewportState`. → targeted
  rendering is an *extension*, not new infra.
- EA **already ships a `Searcher`** (`vectorSearch`, `nearestNeighbors`, `hybridSearch` w/
  RRF), an **in-browser MiniLM embedding worker**, and **`allRowVectors`** (client vector
  cache ≤100k rows). → latent-space chat is mostly client-side linear algebra + tool
  plumbing, **no vector DB needed** (DuckDB VSS/HNSW only as a >100k scale-out).
- EA **bundles its own UMAP** (Rust/WASM + `nndescent` GPU kNN). → live local re-projection
  is uniquely feasible client-side.
- The **19-tool MCP bridge IS the "UI automation layer"** that published mixed-initiative
  systems (ProactiveVA) require — proactivity is just the missing controller half.
- Inline charts **already share the Mosaic coordinator** → any agent-emitted control is
  instantly cross-filter-aware.

### Lens 1 — Generative UI frontier (beyond inline charts)

| Idea | What | Effort |
|---|---|---|
| **`render_control_in_chat`** | agent emits column-bound widgets (slider/multiselect/threshold) that write a Mosaic `Param`/`Selection` → live-filter the whole app | M |
| **`render_dashboard_in_chat`** | compose N primitives (charts + controls + stat tiles) into a cross-filtered mini-dashboard in the conversation; "Add to panel" promotes it | M |
| **Conversation → saved parameterized tool/view** | crystallize a useful turn into a named, re-openable view with live knobs (malleable-software "tools not apps") | M–L |
| **Editable, re-runnable analysis blocks** | SQL/analysis renders as a literate cell; edit & re-run through the read-only guard (no LLM round-trip) | M |
| **Round-trip controls** | a widget value re-invokes the agent in place (Adaptive Cards `Action.Execute` analog) | M |
| **Progressive block assembly** | skeleton-then-fill streaming for composite UI | S–M |
| **Annotate-and-regenerate** | scribble on an emitted chart → regenerate that block in place (tldraw Make-Real loop) | M |
| **MOONSHOT: data-bound generative artifacts** | agent writes a sandboxed micro-app handed a narrow `query()`/`setParam()` capability against the live coordinator | L |
| **MOONSHOT: self-assembling adaptive workspace** | agent reorganizes the whole layout per task (QA / compare / presentation modes) as named, versioned workspaces | L |

*Prereqs: the Tier-0 read-only SQL guard + strict spec validation are hard requirements for
any of these (they widen the model-controlled surface).*

### Lens 2 — Visual grounding & agent vision (fixes the `get_full_screenshot` gap)

The current screenshot tool dumps the whole app. Redesign (capture infra already exists;
only an off-screen render target is new):

| Tool | Signature / behavior | Effort |
|---|---|---|
| **`render_embedding_view`** (headline) | `{coloring, filter, bbox|cluster|fitToSelection, highlight, width, height}` → tight PNG of *just the embedding* under a transient config, off-screen (live view untouched) **+ structured legend JSON** | L (off-screen renderer) |
| **`get_region_screenshot(bbox)`** | minimal stopgap: crop the existing embedding-canvas `toDataURL` to a screen bbox | **S** (ship first) |
| **Set-of-Marks overlay** | number the top-K cluster centroids on a render; return image **+ legend** `[{mark, cluster_id, centroid, count, terms}]` → agent points by *index* not pixels | M |
| **`set_camera` / `fitTo`** | frame by data semantics (`{cluster}`/`{predicate}`/`{ids}`), not screen pixels | S–M |
| **`annotate_view`** | agent draws boxes/arrows/labels/contours as *output* ("these 3 clusters", "this outlier") | M |
| **`compare_views(a,b)`** | stitched A/B panels (e.g. colored-by-X vs -Y, filter on/off) + JSON delta | M |
| **Multi-resolution thumbnail + tiles** | overview thumb + detail tiles; density-heatmap fallback when overplotted | M |
| **Data-first policy** (no tool) | answer *quantitative* questions from `run_sql_query`; render only for *spatial/shape* questions (VLMs collapse on dense scatters — DePlot finding) | S |
| **Visual self-verification** | after a recolor/filter, render the embedding to confirm it landed before claiming done | S |

*Throughline: EA owns the renderer AND the database, so it can sidestep every pixel-vision
weakness — render exactly what's asked, mark it symbolically (SoM), answer numbers from SQL.*

### Lens 3 — Latent-space-native chat (the embedding-native superpower)

Almost all client-side math over `allRowVectors` + the loaded MiniLM worker at ≤100k rows:

| Idea | What | Effort |
|---|---|---|
| **Concept Axis** (flagship) | define an interpretable direction from two text poles or two selections (`a = c_right − c_left`); project rows → a **new named numeric dimension** + a slider that filters/colors. Turns 384-dim space into a human dial. | M |
| **Contrastive Concept** | "what concept distinguishes selection A from B?" — vector contrast exemplars + c-TF-IDF terms → LLM names it | M |
| **Semantic-neighbors-of-a-set** | "find the 50 nearest to this cluster and select them" (mostly wiring existing `Searcher`) | S–M |
| **Diverse exemplars (MMR)** | "20 representative-but-different rows" — geometric, unlike `LIMIT` | S |
| **Semantic outliers & near-duplicates** | kNN-distance score → derived column; data-quality auditing in the geometry (reuses `nndescent`) | M |
| **Region → concept auto-labeling** | medoid + MMR exemplars + c-TF-IDF → grounded cluster names | M |
| **Local re-projection** | re-UMAP just a selection client-side (EA bundles UMAP) — reveals structure the global projection collapses | L |
| **Path between A and B** | order rows along the `c_A→c_B` segment → semantic gradient walk | M |
| **MOONSHOT: steerable search** | "like this but *more methodological*" — `q' = q + α·axis`, re-kNN with an α slider (representation steering for data) | M |
| **MOONSHOT: cross-modal / dual-space** | query text↔image embeddings; find rows where the two spaces *disagree* (needs multi-embedding data model) | L |

*Composability is the story: Concept Axis + neighbors + steering chain into "navigate the
manifold with concept dials" — what no SQL-over-columns chat can do.*

### Lens 4 — Orthogonal HCI reframes + scientific-discovery lens

| Idea | What | Effort |
|---|---|---|
| **Deictic chat** (highest leverage/lowest effort) | "this/these/here/that cluster" resolves against the live lasso/hover/viewport — the map *is* the noun phrase; inject selection/cursor/viewport as first-class context every turn | S–M |
| **Lasso-then-ask** | finishing a lasso surfaces an inline action puck ("Summarize · Compare to rest · Name · Find similar") at the selection | M |
| **Pin-a-question-to-a-region** | anchored conversation/annotation threads that persist across pan/zoom — conversation as a property of *space* | M |
| **AI region labels / living legend** | auto-label density clusters in-place with semantic LOD (coarse far, fine near); link to gene/GO/DOI for scientists | M |
| **ProactiveVA mixed-initiative agent** (most defensible "next agent") | a proactivity controller watches state and *offers* next actions; aggressiveness slider + "leave me alone"; EA already has the automation bridge | M–L |
| **Anomaly/structure spotlight** | flag embedding-native anomalies on load (isolated micro-clusters, label that's spatially scattered = likely mislabel; QC gold for science) | M |
| **"Explain this dataset" navigable tour** | map-driving guided walkthrough; best cold-start | M |
| **Chat → re-runnable notebook** | capture turns' SQL/tool-calls as a versioned, exportable, replayable provenance artifact (scientific table-stakes) | M |
| **Counterfactual query** (signature scientific verb) | "find points like *these* but where `condition=treated`" — kNN ∩ metadata pivot | M |
| **CellWhisperer-style on-map grounding** | peer-reviewed CZI/CELLxGENE precedent (map + chat fusion) — de-risks the whole direction | M |
| **Sonified / described embedding** | verbal alt-text of high-dim structure + optional sonification; accessibility no competitor has, doubles as machine summary | M / L |
| **MOONSHOT: Figures-as-Interfaces** | the scatter as a machine-addressable, provenance-carrying LLM-native artifact (arXiv 2604.08491) | L |
| **MOONSHOT: SemanticTours KG tours** | non-linear tours that follow domain ontology, not point order | L |

*Mixed-initiative constraint (Horvitz/ProactiveVA): any proactivity ships with timing
control, transparency ("show why"), a tunable aggressiveness knob, and failure recovery —
or it becomes Clippy.*

### Highest-leverage orthogonal bets (the shortlist)

1. **`render_embedding_view` + `get_region_screenshot` + legend JSON** — fixes the screenshot
   gap you flagged; ship the screen-space crop first, then the off-screen renderer.
2. **Concept Axis** — the embedding-native flagship; turns latent space into named dials.
3. **Deictic chat** — tiny change, huge UX payoff; the map becomes the noun phrase.
4. **`render_control_in_chat`** — generative UI's next step beyond charts; cross-filter-aware for free.
5. **Counterfactual query + semantic-neighbors-of-a-set** — signature scientific verbs, mostly wiring.
6. **ProactiveVA controller** — the defensible "next version of the agent".
7. **Optional prompt refinement** (Tier 2) — context-aware rewrite of the user's prompt before send; composes with deixis. *Maintainer-requested.*

> **Maintainer steer (2026):** pursue *all four* orthogonal lenses (vision · latent-space ·
> generative UI · deixis/proactive) **plus prompt refinement**. A separate **RAG / retrieval**
> research pass is queued — corpus = papers with precomputed embeddings; the open question is
> not "can we embed the query at runtime" (EA already runs MiniLM in-browser) but
> **embedding-space parity** (corpus model vs runtime query model must match) and whether to
> take that on now or defer. Findings fold in here.

### Selected sources

**Pass 1:** Anthropic extended thinking & Claude Code auto/plan-mode; OpenAI Canvas; Claude
Artifacts; Perplexity citation pipeline; Hex Notebook Agent; Databricks Genie; Snowflake
Cortex Analyst; ThoughtSpot Sage; Tableau Pulse; Nomic Atlas; Cursor/Windsurf/Cline/Devin/
Replit; Vercel AI SDK resumable streams; OWASP LLM01/LLM05 + prompt-to-SQL (ICSE'25); Dexie;
OTel GenAI conventions; ARIA live-region guidance.

**Pass 2:** Vercel AI SDK `streamUI`/GenUI; Thesys C1; Microsoft Adaptive Cards; Claude Live
Artifacts; tldraw Make Real; Ink & Switch malleable software / Geoffrey Litt; ScrollyVis /
WaitGPT (scrollytelling). Set-of-Mark (arXiv 2310.11441); ChartAgent (2510.04514); DePlot/
MatCha; OpenAI CUA + Visual Confused Deputy (2603.14707); deck.gl/WebGPU readback. Latent
Scope (Ian Johnson); WizMap; TF Embedding Projector; Nomic Atlas; BERTopic c-TF-IDF;
Cleanlab; MMR; DuckDB VSS; representation engineering/steering; local re-projection (2101.04378).
ProactiveVA (2507.18165); Horvitz mixed-initiative; NL4DV/Eviza/DataTone; Bolt "Put-That-There";
FigJam; SemanticTours (2512.07483); Figures-as-Interfaces (2604.08491); CellWhisperer (Nat
Biotech 2025); CellTypeAgent; Elicit/Consensus/SciSpace; ChartA11y/TactualPlot.

---

## RAG / retrieval over content (2026 pass 3)

Goal: let the agent answer *from actual paper content* (not metadata/SQL), with citations.
A 4-agent pass (architecture · runtime-embedding risk · EA-native grounding · infra/eval).

### The load-bearing discovery (changes the risk picture)

**EA discards the high-dim embedding at ingest.** `projection.py` feeds vectors to UMAP and
persists only `projection_x/y` + a precomputed `neighbors` struct (`{ids, distances}`); the
raw vectors are dropped and the embedding model id is only a transient cache key, never
stored. **So there is no corpus vector space to query against** from the shipped artifact —
which means:

- **Item→item RAG** ("find papers similar to this one") already works via the precomputed
  `neighbors` graph — **parity-safe by construction, no query embedding needed.**
- **Free-text query→corpus RAG** via EA's existing **MiniLM hybrid path is self-consistent**:
  query *and* candidate text are both embedded by the same in-browser MiniLM at runtime, so
  there is **no parity bug**. The parity trap only appears if someone wires the query against
  a `--vector`-ingested column produced by an unknown model.

### Verdict on the runtime-embedding risk (the maintainer's open question)

**Runtime query embedding is routine and low-risk — adopt it, don't defer.** EA already
embeds query text client-side via the MiniLM worker (~50 ms, offline, query never leaves the
browser — ideal for sensitive bio data). The *only* real risk is **embedding-space parity**,
and EA should **eliminate it by construction at ingest** rather than manage it at query time:

1. **Standardize the encoder at ingest + persist `embedding_model`/version/dim into
   `metadata.json`**; default it to the **same MiniLM the browser already runs** → corpus and
   query share one space with zero extra work. (If RAG over the *original* vectors is wanted,
   stop discarding the `embedding` column.) **S, highest-ROI correctness fix.**
2. **Embed the query client-side** with that same model (already implemented). 
3. **No-runtime-embedding fallback, ship-ready today: lexical BM25 RAG** via Orama (EA already
   has `fullTextSearch`) + the precomputed `neighbors` graph — zero query embedding, zero
   parity risk. Use for air-gapped / unknown-encoder datasets.
4. **Avoid the trap:** don't retrieve against a `--vector` column from an unknown/proprietary
   encoder unless you can run that exact encoder at query time *and* stored its id.

### MVP: expose retrieval as a tool (the keystone, mostly already built)

EA's `hybridSearch` **already accepts a `predicate`**, and the `cited_rows` → citation-pill
pipeline already pans the map / scrolls the table. So scoped, cited RAG is ~80% built:

| Item | What | Effort |
|---|---|---|
| **`retrieve(query, k, within_selection?)` as MCP tool #20** | wrap the existing `hybridSearch`; return passage text **+ `cited_rows`** (pills render for free); `within_selection` defaults to the live predicate | **S–M** |
| **Selection-size routing** | small selection (≤~150 rows) → feed rows' text into context (long-context, no retrieval); large/whole-corpus → `retrieve`. "Selection size decides." | S |
| **Inline citation markers `[1][2]`** tied to pills (claim-level grounding, NotebookLM/Perplexity-style) instead of just a Sources footer | S–M |
| **True two-arm hybrid** | EA's fusion is one-sided (dense only re-ranks the BM25 pool); add an independent dense arm = brute-force cosine over `allRowVectors`, fuse via RRF (make `k`/weights configurable) | S |
| **HyDE inside the tool** | agent drafts a 1-sentence hypothetical abstract → embed → retrieve; big recall win for paper abstracts, nearly free | S |
| **Agentic retrieve-vs-SQL routing + re-query** | content question → retrieve; aggregate → SQL; weak results → refine/widen (poor-man's CRAG, emergent from the tool loop) | M |

### EA-native RAG (what a chatbot can't do)

- **"RAG over what's on screen"** — retrieval scoped to the lasso/predicate; the selection *is*
  the pre-filter. The wedge no generic RAG tool has. **S** (predicate) / **M** (geometric lasso region).
- **MOONSHOT: retrieval-as-map-layer** — retrieved points pulse on the map, relevance→opacity;
  the answer becomes spatially legible ("evidence clusters here"). Reuses x/y + selection plumbing. **L**
- **MOONSHOT: spatial multi-hop** — hops = `nearestNeighbors` over the embedding (a free
  knowledge graph); retrieve→follow-neighbors→retrieve, map animates the frontier. **L**
- **Cohort grounding / closed-corpus contract** — "across these 47 papers, is there support for
  H?"; refuse-if-unsupported, cite per paper, link DOI/PubMed (reuses `CITATION_KEYS`). **M** *(scientific)*

### Chunking, infra & eval (defer most until full-text)

- **Chunking is only needed for full-text.** The papers demo is abstracts → one abstract ≈ one
  chunk, no chunking. When full-text lands: **parent-document** (retrieve child chunks, return
  parent section) + a `chunks.parquet` (`chunk_id, parent_row_id, char_span, text, embedding
  FLOAT[384]`). **L.** Higher near-term ROI: a **longer-context small embedder** (Jina-small/
  Nomic ONNX) — MiniLM silently truncates abstracts at ~256 tokens.
- **Scaling ladder:** ≤100k → client brute force over `allRowVectors` (exact, ~20 ms, already
  gated by `MAX_ROWS_FOR_VECTOR_CACHE`) · 100k–1M → server **DuckDB VSS/HNSW** built once,
  read-only (dodges its experimental-persistence/WAL caveats) · 1M+/multi-dataset → **LanceDB**
  (Arrow-native, embeddable, DuckDB-joinable; Qdrant/Turbopuffer only if it becomes hosted SaaS).
- **Eval harness (minimal, CI):** RAGAS triad (faithfulness, context precision/recall, answer
  relevance) + a 30–100 `question→source` golden set + a **citation-groundedness gate** (each
  cited span actually supports its claim) + a **model-parity assertion** (query encoder ==
  corpus encoder from `metadata.json`). **M.**

### RAG first step

Ship **`retrieve()` tool + selection-scoping + inline pills** (all S–M, on existing
primitives) and **stamp the embedding model at ingest** (S, kills the parity risk). That's a
genuinely map-native, cited RAG MVP. Defer chunking/contextual-retrieval/GraphRAG (GraphRAG is
overkill — the embedding + `neighbors` already *is* the graph) until full-text corpora exist.

### Selected sources (pass 3)
Anthropic Contextual Retrieval; Jina late chunking & reranker-v3; HyDE; RRF/hybrid tuning;
Self-RAG / CRAG; AgenticRAG survey; long-context-vs-RAG (Self-Route); transformers.js v3
WebGPU + query/passage prefixes; embedding versioning / index drift; LocalRAG + privacy-RAG
(biomedical, BGE-small+BM25); DuckDB VSS docs + caveats; LanceDB (Arrow-native) / Qdrant /
Turbopuffer / pgvector; RAGAS + DeepEval; NotebookLM / Perplexity / Elicit citation grounding;
PaperTrail claim↔evidence provenance.
