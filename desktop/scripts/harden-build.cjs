const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const roots = ['accounts','providers','security'].map(domain => `dist/main/${domain}`);
for (const relativeRoot of roots) {
  const root = path.resolve(relativeRoot);
  if (!fs.existsSync(root)) continue;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && target.endsWith('.js')) {
        const source = fs.readFileSync(target, 'utf8');
        const result = esbuild.transformSync(source, { loader: 'js', minify: true, sourcemap: false, target: 'node24' });
        fs.writeFileSync(target, result.code, 'utf8');
      }
    }
  }
}
