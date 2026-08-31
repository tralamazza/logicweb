// Vite's `?raw` suffix inlines a file as a string. Declared locally because
// the shared tsconfig pins `types` to ["w3c-web-usb"], so vite/client's
// ambient declarations are not in scope.
declare module '*.py?raw' {
  const src: string;
  export default src;
}
