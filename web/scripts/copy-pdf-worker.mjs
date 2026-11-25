// The phone reads PDF résumés itself with pdf.js. Its worker file must be served from this site and must be exactly the
// version of the installed library, so it is copied from node_modules before every build and dev start.
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url));
const directory = fileURLToPath(new URL('../public/live/', import.meta.url));
mkdirSync(directory, { recursive: true });
copyFileSync(from, `${directory}pdf.worker.min.mjs`);
