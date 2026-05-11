// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import { createUMAP } from "@embedding-atlas/umap-wasm";
import { imageToDataUrl } from "@embedding-atlas/utils";
import { load_image, pipeline } from "@huggingface/transformers";

import { WorkerRPC } from "./worker_helper.js";

let { handler, register } = WorkerRPC.runtime();

onmessage = handler;

interface EmbeddingOptions {
  type: "text" | "image";
  model: string;
}

interface EmbeddingComputer {
  batch(data: any[]): Promise<void>;
  finalize(): Promise<Float32Array>;
}

let embeddings = new Map<string, EmbeddingComputer>();

function makeEmbeddingComputer(runBatch: (data: any[]) => Promise<any>): EmbeddingComputer {
  let batches: any[] = [];
  return {
    async batch(data) {
      batches.push(await runBatch(data));
    },
    async finalize() {
      let count = batches.reduce((a, b) => a + b.dims[0], 0);
      let inputDim = batches[0].dims[1];
      let outputDim = 2;
      let data = new Float32Array(count * inputDim);
      let offset = 0;
      for (let i = 0; i < batches.length; i++) {
        let length = batches[i].dims[0] * inputDim;
        data.set(batches[i].data.subarray(0, length), offset);
        offset += length;
      }
      let umap = await createUMAP(count, inputDim, outputDim, data, {
        metric: "cosine",
      });
      await umap.run();
      let result = new Float32Array(umap.embedding);
      umap.destroy();
      return result;
    },
  };
}

register("embedding.new", async (options: EmbeddingOptions) => {
  let instance = new Date().getTime() + "-" + Math.random();
  let pipelineOptions: any = { device: "webgpu" };
  if (options.type == "text") {
    let extractor = await pipeline("feature-extraction", options.model, pipelineOptions);
    let computer = makeEmbeddingComputer(async (data) => {
      let inputs = data.map((x) => x?.toString() ?? "");
      let embedding = await extractor(inputs, { pooling: "mean", normalize: true });
      if (embedding.dims.length == 3) {
        embedding = embedding.mean(1);
      }
      if (embedding.dims.length != 2 || embedding.dims[0] != data.length) {
        throw new Error("output embedding dimension mismatch");
      }
      return embedding;
    });
    embeddings.set(instance, computer);
    return instance;
  } else if (options.type == "image") {
    let extractor = await pipeline("image-feature-extraction", options.model, pipelineOptions);
    let computer = makeEmbeddingComputer(async (data) => {
      let imgs = data.map((x) => imageToDataUrl(x) ?? "");
      imgs = await Promise.all(imgs.map((x) => load_image(x)));
      let embedding = await extractor(imgs);
      if (embedding.dims.length == 3) {
        embedding = embedding.mean(1);
      }
      if (embedding.dims.length != 2 || embedding.dims[0] != imgs.length) {
        throw new Error("output embedding dimension mismatch");
      }
      return embedding;
    });
    embeddings.set(instance, computer);
    return instance;
  } else {
    throw new Error("invalid data type");
  }
});

register("embedding.batch", async (instance: string, data: any[]) => {
  await embeddings.get(instance)?.batch(data);
});

register("embedding.finalize", async (instance: string) => {
  let obj = embeddings.get(instance);
  if (obj) {
    embeddings.delete(instance);
    return obj.finalize();
  }
});

// Session-style raw embedding for search. Different lifecycle from
// the projection flow above: the model stays loaded across calls and
// each `embed` returns raw N×dim vectors without UMAP. Used by
// FullTextSearcher.hybridSearch.
interface RawEmbedder {
  (texts: string[]): Promise<{ data: Float32Array; dim: number }>;
}

let sessions = new Map<string, RawEmbedder>();

register("embedding.session_new", async (options: { model: string }) => {
  let id = new Date().getTime() + "-" + Math.random();
  let extractor = await pipeline("feature-extraction", options.model, { device: "webgpu" });
  sessions.set(id, async (texts: string[]) => {
    let embedding = await extractor(texts, { pooling: "mean", normalize: true });
    if (embedding.dims.length == 3) {
      embedding = embedding.mean(1);
    }
    if (embedding.dims.length != 2 || embedding.dims[0] != texts.length) {
      throw new Error("output embedding dimension mismatch");
    }
    let dim = embedding.dims[1] as number;
    // Tensor.data is a DataArray union that includes BigInt64Array
    // in the type but never returns it for feature-extraction
    // pipelines (always Float32Array in practice). Cast to bypass
    // the union; we always copy into a fresh Float32Array so the
    // result is well-typed downstream.
    return { data: new Float32Array(embedding.data as any), dim };
  });
  return id;
});

register("embedding.session_embed", async (instance: string, texts: string[]) => {
  let fn = sessions.get(instance);
  if (!fn) throw new Error("unknown embedding session: " + instance);
  return await fn(texts);
});

register("embedding.session_dispose", async (instance: string) => {
  sessions.delete(instance);
});
