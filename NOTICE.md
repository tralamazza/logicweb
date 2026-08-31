# Third-party components

logicweb bundles two third-party runtimes at build time. Neither is committed to this
repository - both are staged into `public/` by `npm run vendor` - but both are shipped in
`dist/`, so their licences travel with any deployment.

## libsigrokdecode protocol decoders

`public/decoders/decoders.zip` contains the stock protocol decoders from
libsigrokdecode (the sigrok project). These are licensed under the **GNU General Public
License, version 3 or later**.

This has a consequence worth stating plainly rather than discovering later: the GPL is a
copyleft licence, and bundling GPL-licensed decoders into a distributed application
constrains how that application as a whole may be licensed and distributed. If logicweb
is ever published, that question needs a real answer - either honour the GPL for the
combined work, or load the decoders as a separate, user-supplied component rather than
shipping them.

Nothing here is legal advice; it is a flag that the question exists and has not been
answered.

Source: https://sigrok.org/wiki/Libsigrokdecode

## Pyodide

`public/pyodide/` is the Pyodide distribution - CPython and its standard library compiled
to WebAssembly - used to run the decoders in the browser. Pyodide is licensed under the
**Mozilla Public License 2.0**. It embeds CPython, which carries the **Python Software
Foundation License**.

Source: https://pyodide.org

## Everything else

All other code in this repository is original work. It contains no third-party sample
data, screenshots, or proprietary file-format material.
