#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runNpm(args, options = {}) {
  const result = spawnSync(npmCommand(), args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(detail || `npm ${args.join(' ')} exited with status ${result.status}`);
  }
  return String(result.stdout || '').trim();
}

function outputDirectory(args) {
  const index = args.indexOf('--output');
  if (index === -1) return path.join(ROOT, 'publication');
  if (!args[index + 1]) throw new Error('--output requires a directory');
  return path.resolve(args[index + 1]);
}

try {
  const outputDir = outputDirectory(process.argv.slice(2));
  fs.mkdirSync(outputDir, { recursive: true });
  runNpm(['run', 'verify']);
  const archive = runNpm(
    ['pack', '--ignore-scripts', '--pack-destination', outputDir],
    { capture: true },
  );
  console.log(path.join(outputDir, archive.split('\n').at(-1)));
} catch (error) {
  console.error(`Release build failed: ${error.message}`);
  process.exit(1);
}
