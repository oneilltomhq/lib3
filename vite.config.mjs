// vite.config.js (root - for library build + examples serve/build)
import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import glob from "fast-glob"; // For dynamic example inputs

const __dirname = dirname(fileURLToPath(import.meta.url));

// Helpers and plugins to auto-generate an index for examples/
function humanize(input) {
  // Remove trailing slash and get last non-empty segment
  const withoutTrailing = input.replace(/\/$/, "");
  // Only split by path separators, not hyphens/underscores
  const base =
    withoutTrailing.split(/[\\/]/).filter(Boolean).pop() || withoutTrailing;
  return base
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function renderIndex(entries) {
  const items = entries
    .map(({ href, title }) => `<li><a href="/${href}">${title}</a></li>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>Examples</title>
    <style>
      body{font:16px system-ui;margin:2rem;}
      h1{margin:0 0 1rem;}
      ul{list-style:none;padding:0;margin:0;}
      li{margin:.5rem 0;}
      a{color:#2563eb;text-decoration:none;}
      a:hover{text-decoration:underline;}
    </style></head>
    <body><h1>Examples</h1>
    <ul id="list">${items}</ul>
    </body></html>`;
}

const exampleIndexFiles = () =>
  glob("examples/**/index.html", { ignore: ["examples/dist/**"] });

const exampleIndexFilesSync = () =>
  glob.sync("examples/**/index.html", { ignore: ["examples/dist/**"] });

function examplesIndexPlugin() {
  return {
    name: "examples-index",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/" && req.url !== "/index.html") return next();
        const files = await exampleIndexFiles();
        const entries = files
          .map((file) => {
            const href = file.replace(/index.html$/, "");
            const title = humanize(href);
            return { href, title };
          })
          .sort((a, b) => a.title.localeCompare(b.title));
        const html = renderIndex(entries);
        res.setHeader("Content-Type", "text/html");
        res.end(html);
      });
    },
  };
}

function examplesIndexBuildPlugin() {
  return {
    name: "examples-index-build",
    apply: "build",
    generateBundle() {
      const files = exampleIndexFilesSync();
      const entries = files
        .map((file) => {
          const href = file.replace(/index.html$/, "");
          const title = humanize(href);
          return { href, title };
        })
        .sort((a, b) => a.title.localeCompare(b.title));
      const html = renderIndex(entries);
      this.emitFile({ type: "asset", fileName: "index.html", source: html });
    },
  };
}

export default defineConfig(({ mode }) => {
  const common = {
    // Shared config (e.g., resolve alias for examples to import from src/)
    resolve: {
      alias: {
        "@oneilltom/lib3": resolve(__dirname, "src/index.js"),
        "@videos": resolve(__dirname, "examples/assets/videos"),
        "@textures": resolve(__dirname, "examples/assets/textures"),
        "@assets": resolve(__dirname, "examples/assets"),
      },
    },
  };

  const commonPlugins = [];

  if (mode === "examples") {
    // Serve/build examples as multi-page app
    return {
      ...common,
      appType: "mpa",
    server: { allowedHosts: true },
      plugins: [
        ...commonPlugins,
        examplesIndexPlugin(),
        examplesIndexBuildPlugin(),
      ],
      build: {
        // Keep examples output separate from the library build
        outDir: "examples/dist",
        // Multi-page build config (dynamic inputs via glob)
        rollupOptions: {
          input: Object.fromEntries(
            exampleIndexFilesSync().map((file) => [
              // Key: relative path without .html (e.g., 'examples/example1/index')
              // This preserves sub-directory structure in dist-examples/
              file.slice(0, -5),
              fileURLToPath(new URL(file, import.meta.url)),
            ])
          ),
        },
      },
    };
  } else {
    // Default: Library build mode (from src/)
    return {
      ...common,
      plugins: [
        // No dts generation for now (JS library). Add back later if needed.
      ],
      build: {
        lib: {
          entry: {
            index: resolve(__dirname, "src/index.js"),
            waves: resolve(__dirname, "src/waves.js"),
            knotMorph: resolve(__dirname, "src/knotMorph.js"),
            thunder: resolve(__dirname, "src/thunder.js"),
            nimbus: resolve(__dirname, "src/nimbus/index.js"),
            metaballs: resolve(__dirname, "src/metaballs.js"),
            lissajous: resolve(__dirname, "src/lissajous.js"),
            journey: resolve(__dirname, "src/journey.js"),
            hydra: resolve(__dirname, "src/hydra/index.js"),
            rack: resolve(__dirname, "src/rack.js"),
            sdf: resolve(__dirname, "src/sdf/index.js"),
            sdfText: resolve(__dirname, "src/sdf-text/index.js"),
          },
          formats: ["es"],
        },
        rollupOptions: {
          // three is a peer dep (externalized). opentype.js is bundled into an
          // on-demand chunk so canvas-path consumers never resolve or load it,
          // and vector-path consumers need nothing installed. See VectorFont.js.
          external: (id) => id === "three" || id.startsWith("three/"),
        },
        sourcemap: true,
        emptyOutDir: true,
      },
    };
  }
});
