import { loadManifest } from "./manifest";
import { createViewer } from "./viewer";

const app = document.getElementById("app")!;
const id = new URLSearchParams(location.search).get("c") ?? "mine";

loadManifest(id)
  .then(({ manifest, baseUrl }) => {
    document.title = `${manifest.title} · Splat Compare`;
    createViewer(app, manifest, baseUrl).ready.catch(console.error);
  })
  .catch((err: Error) => {
    app.innerHTML = `<p class="fatal"></p>`;
    app.querySelector(".fatal")!.textContent = err.message;
  });
