<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script lang="ts">
  import Viewer from "./Viewer.svelte";

  import { BackendDataSource } from "./backend_data_source.js";

  let serverUrl = "./data/";
  if (import.meta.env.MODE == "development") {
    // Vite proxies /data and /mcp to the backend (see vite.config.js).
    serverUrl = "/data/";
  }

  let dataSource = new BackendDataSource(serverUrl);
</script>

<Viewer dataSource={dataSource} />
