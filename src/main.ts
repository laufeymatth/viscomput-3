import { loadManifest } from "./manifest";

const app = document.getElementById("app")!;
const params = new URLSearchParams(location.search);
const id = params.get("c") ?? "mine";

loadManifest(id)
  .then(async ({ manifest, baseUrl }) => {
    document.title = `${manifest.title} · Splat Compare`;
    // The VR viewer is the main one; `?web` opens the phone/desktop split viewer.
    // Each lives in its own chunk so neither loads the other.
    if (params.has("web")) {
      const { createViewer } = await import("./viewer");
      createViewer(app, manifest, baseUrl).ready.catch(console.error);
    } else {
      const { createXrViewer, parseXrOptions } = await import("./xrViewer");
      createXrViewer(app, manifest, baseUrl, parseXrOptions(params)).ready.catch(console.error);
    }
  })
  .catch((err: Error) => {
    app.innerHTML = `<p class="fatal"></p>`;
    app.querySelector(".fatal")!.textContent = err.message;
  });
