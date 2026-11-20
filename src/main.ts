import { loadManifest } from "./manifest";
import { createViewer } from "./viewer";

const app = document.getElementById("app")!;
const params = new URLSearchParams(location.search);
const id = params.get("c") ?? "mine";

loadManifest(id)
  .then(async ({ manifest, baseUrl }) => {
    document.title = `${manifest.title} · Splat Compare`;
    if (params.has("xr")) {
      // VR spike lives in its own chunk so the phone viewer doesn't load it.
      const { createXrViewer, parseXrOptions } = await import("./xrViewer");
      createXrViewer(app, manifest, baseUrl, parseXrOptions(params)).ready.catch(console.error);
    } else {
      createViewer(app, manifest, baseUrl).ready.catch(console.error);
    }
  })
  .catch((err: Error) => {
    app.innerHTML = `<p class="fatal"></p>`;
    app.querySelector(".fatal")!.textContent = err.message;
  });
