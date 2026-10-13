'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

for (const directory of ['src', 'public', 'scripts']) {
  for (const entry of fs.readdirSync(path.join(root, directory)).sort()) {
    if (/\.(cjs|js)$/.test(entry)) run(['--check', `${directory}/${entry}`]);
  }
}

for (const entry of fs.readdirSync(__dirname).sort()) {
  if (/-test\.cjs$/.test(entry)) run([`scripts/${entry}`]);
}
