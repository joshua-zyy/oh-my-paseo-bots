import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const outputDirectory = resolve(projectRoot, 'dist');
if (dirname(outputDirectory) !== resolve(projectRoot) || basename(outputDirectory) !== 'dist') {
  throw new Error('Refusing to remove an output directory outside the project');
}
await rm(outputDirectory, { recursive: true, force: true });
execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))], { cwd: projectRoot, stdio: 'inherit' });

// Match the entry boundaries: host modules are supplied by Paseo at load time.
const shared = { bundle: true, format: 'esm', target: 'es2022', external: ['@getpaseo/*', '@modelcontextprotocol/sdk/client/stdio.js', 'react', 'react/*', 'react-native', 'zod', 'nodemailer', 'mailparser'], logLevel: 'info' };
await build({ ...shared, absWorkingDir: projectRoot, entryPoints: ['index.server.ts'], outfile: 'dist/plugin/index.server.js', platform: 'node' });
await build({ ...shared, absWorkingDir: projectRoot, entryPoints: ['index.client.tsx'], outfile: 'dist/plugin/index.client.js', platform: 'browser' });
