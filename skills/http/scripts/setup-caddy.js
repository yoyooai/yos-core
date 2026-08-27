#!/usr/bin/env node
/**
 * HTTP Layer - Caddy Setup Script (standalone)
 *
 * This script is kept for backward compatibility. The preferred way to
 * set up Caddy is via `yos init`, which handles download, domain
 * configuration, and PM2 integration automatically.
 *
 * This script reads domain from config.json (falling back to .env),
 * generates the Caddyfile at ~/yos/http/Caddyfile, and starts
 * Caddy via PM2.
 *
 * Usage: node setup-caddy.js
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';

const YOS_DIR = process.env.YOS_DIR || path.join(os.homedir(), 'yos');
const CONFIG_DIR = path.join(YOS_DIR, '.yos');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const HTTP_DIR = path.join(YOS_DIR, 'http');
const CADDYFILE = path.join(HTTP_DIR, 'Caddyfile');
const CADDY_BIN = path.join(YOS_DIR, 'bin', 'caddy');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node setup-caddy.js');
  console.log('');
  console.log('Sets up Caddy with file serving. Use `yos init` instead for full setup.');
  process.exit(0);
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(updates) {
  const config = readConfig();
  Object.assign(config, updates);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

async function main() {
  console.log('Caddy Setup');
  console.log('===========\n');

  // Check Caddy binary
  if (!fs.existsSync(CADDY_BIN)) {
    console.error(`Error: Caddy binary not found at ${CADDY_BIN}`);
    console.error('Run `yos init` to download and configure Caddy.');
    process.exit(1);
  }

  // Read domain from config.json
  const config = readConfig();
  let domain = config.domain || '';

  if (!domain || domain === 'your.domain.com') {
    domain = await prompt('Enter your domain (e.g., yos.example.com): ');
    if (!domain) {
      console.error('Domain is required. Exiting.');
      process.exit(1);
    }
    saveConfig({ domain });
  }

  console.log(`Domain: ${domain}`);

  // Create directories
  const publicDir = path.join(HTTP_DIR, 'public');
  fs.mkdirSync(publicDir, { recursive: true });

  // Generate Caddyfile
  const content = `# YOS Caddyfile — managed by yos-core
# Domain: ${domain}

${domain} {
    header >X-Robots-Tag "noindex, nofollow"

    root * ${publicDir}

    file_server {
        hide .git .env *.db *.json
    }

    @markdown path *.md
    handle @markdown {
        header Content-Type "text/plain; charset=utf-8"
    }

    handle /health {
        respond "OK" 200
    }

    log {
        output file ${HTTP_DIR}/caddy-access.log {
            roll_size 10mb
            roll_keep 3
        }
    }
}
`;

  fs.writeFileSync(CADDYFILE, content);
  console.log(`Caddyfile written to ${CADDYFILE}`);

  // Reload or start Caddy via PM2
  try {
    execSync('pm2 reload caddy', { stdio: 'pipe', timeout: 10000 });
    console.log('Caddy reloaded via PM2');
  } catch {
    console.log('Caddy not running in PM2. Start it with: pm2 start ~/yos/pm2/ecosystem.config.cjs');
  }

  console.log(`\nYour site is live at: https://${domain}/`);
  console.log(`Verify: curl -I https://${domain}/health`);
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
