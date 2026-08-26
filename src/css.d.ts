/** Bundle-time CSS loader: esbuild `--loader:.css=text` turns imports into strings. */
declare module '*.css' {
  const content: string
  export default content
}
