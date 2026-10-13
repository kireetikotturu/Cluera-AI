import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
await build({entryPoints:[fileURLToPath(new URL('./main.ts',import.meta.url))],outfile:fileURLToPath(new URL('./dist/main.js',import.meta.url)),platform:'node',target:'node24',format:'esm',bundle:true,packages:'external',nodePaths:[fileURLToPath(new URL('./node_modules',import.meta.url))],sourcemap:false});
