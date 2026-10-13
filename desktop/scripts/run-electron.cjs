const { spawn } = require('node:child_process');
const electron = require('electron');

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', ...process.argv.slice(2)], { env: environment, stdio: 'inherit', windowsHide: false });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { console.error('Could not launch Electron:', error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exit(code ?? 1); });
