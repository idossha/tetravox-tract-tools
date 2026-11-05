// One ESM file with no imports: nothing resolves a bare specifier over tetravox://module, so the SDK
// shim is inlined and scripts/check-bundle.mjs re-asserts the property on the emitted bytes.

import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

export default {
  input: 'src/index.ts',
  output: { file: 'dist/index.js', format: 'es', sourcemap: false },
  external: [],
  plugins: [
    nodeResolve({ extensions: ['.ts', '.tsx', '.js', '.mjs'] }),
    typescript({
      tsconfig: './tsconfig.json',
      noEmit: false,
      declaration: false,
      declarationMap: false,
      sourceMap: false,
    }),
  ],
  // An unresolved specifier would become an `import` in the output: fail where it happens.
  onwarn(warning) {
    throw new Error(`${warning.code ?? 'WARN'}: ${warning.message}`);
  },
};
