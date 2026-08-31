# Deploying to GitHub Pages

`.github/workflows/pages.yml` builds on every push to `main` and publishes the result.
There is no `gh-pages` branch and nothing built is committed.

## One-time setup

1. Create the repo on GitHub and push `main`.
2. Settings -> Pages -> Build and deployment -> **Source: GitHub Actions**.

That is all. The first push to `main` deploys to
`https://<owner>.github.io/<repo>/`.

## Why CI builds instead of committing the output

The two runtime assets - 13 MB of Pyodide and the sigrok decoder tree - are gitignored
(see `.gitignore`) and staged by `npm run vendor`. Publishing from a `gh-pages` branch
would mean committing those third-party binaries into this repository's history, which is
exactly what the vendor script exists to avoid. The Actions path builds them fresh and
uploads the tree directly.

It also means the published site can never drift from `main`: there is no second branch
to forget to update.

## The base path

A project page is served from a subdirectory, `https://<owner>.github.io/<repo>/`, not
from the domain root. Anything the app resolves as an absolute URL at run time has to
carry that prefix - see the `BASE_URL` comment in `src/decode/worker.ts`, which is there
because `/pyodide/` and `/decoders/decoders.zip` were once hardcoded and 404'd under any
subdirectory while the rest of the app looked healthy.

The workflow computes the prefix from the repo name and passes it as `vite build --base`.
A user/org page (a repo literally named `<owner>.github.io`) is served at the domain root
and gets a plain `/`, which is also the default when you build locally.

To reproduce a project-page build by hand:

```
npm run build -- --base=/logicweb/
```

## The decoder pin

`LIBSIGROKDECODE_REF` in the workflow is a commit, not `master`. `npm run vendor`
regenerates `src/decode/decoders/manifest.ts`, and that file **is** committed, so tracking
a moving branch would let the bundled decoder set drift away from the manifest the UI
reads with nothing to signal it. The workflow runs `git diff --exit-code` on the manifest
straight after vendoring, so drift fails the build rather than shipping a decoder list
that does not match the zip.

Bumping it is deliberate: change the ref, run `npm run vendor -- <libsigrokdecode/decoders>`,
and commit the regenerated manifest in the same change.

## What was verified, and the one thing that will break it

Measured against a build served from a `/logicweb/` subdirectory in headless Brave:

| | |
|---|---|
| App boots, decode worker warms | yes |
| `pyodide.asm.wasm`, `python_stdlib.zip`, `decoders.zip` fetched under the prefix | yes |
| 404s | none |
| `isSecureContext` | true - WebUSB needs this, and Pages is HTTPS |
| `crossOriginIsolated` / `SharedArrayBuffer` | **false** |

The 404 that used to be in that table was `/favicon.ico`, and it was worth more than it
looked: a page that declares no icon makes the browser probe `/favicon.ico` at the
**domain** root, not under the base path. For a project page that root belongs to
`<owner>.github.io`, not to this site, so it can never be satisfied from this repository.
`index.html` now declares `public/favicon.svg`, which stops the probe happening at all.

**The wasm MIME type is a hard dependency, not a nicety.** Serving `pyodide.asm.wasm` as
`application/octet-stream` does not degrade to a slower path - Pyodide fails to
instantiate and the decode worker never warms up at all:

```
wasm instantiation failed!
TypeError: Failed to execute 'compile' on 'WebAssembly':
  Incorrect response MIME type. Expected 'application/wasm'.
```

GitHub Pages gets this right (verified: `content-type: application/wasm`). Any other host
must be checked before assuming it does, because the symptom is "decoding silently never
becomes ready", not a 404.

`.nojekyll` is copied into the build from `public/`. The Actions deployment publishes the
artifact as-is and never runs Jekyll, so it only matters if the repo is switched back to
deploying from a branch - at which point Jekyll would drop any file whose name starts with
an underscore.

## `crossOriginIsolated` is false, and stays false

GitHub Pages cannot set the COOP/COEP response headers that
`crossOriginIsolated` requires, so `SharedArrayBuffer` is unavailable and the decode
worker's interrupt buffer is null. This is **not** a regression introduced by hosting:
the same is true under `vite dev` and `vite preview`, so the no-SAB path is the only one
this app has ever taken. The consequence is the one already documented in
`src/decode/NOTES.md` - cancelling a decode terminates the worker rather than
interrupting it, and the client counts that as a hard cancel.

## Browser support is unchanged

WebUSB is Chromium-only. Chrome, Edge, Brave and Opera can drive the device; Firefox and
Safari can still open `.sr` and `.lwcap` files and decode them. HTTPS from Pages satisfies
the secure-context requirement, so capture works on a deployed site exactly as it does on
`http://127.0.0.1`.
