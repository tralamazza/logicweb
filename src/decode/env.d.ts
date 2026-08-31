// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
// Vite's `?raw` suffix inlines a file as a string. Declared locally because
// the shared tsconfig pins `types` to ["w3c-web-usb"], so vite/client's
// ambient declarations are not in scope.
declare module '*.py?raw' {
  const src: string;
  export default src;
}
