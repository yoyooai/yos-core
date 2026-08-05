// PM2 Ecosystem Configuration for YOS
// This file defines all PM2-managed services with proper environment setup
//
// Usage:
//   pm2 start ~/yos/pm2/ecosystem.config.cjs
//   pm2 save
//   pm2 startup  # Configure boot auto-start

const path = require('path');
const os = require('os');

const fs = require('fs');

const HOME = os.homedir();
const YOS_DIR = path.join(HOME, 'yos');
const YOS_META_DIR = path.join(YOS_DIR, '.yos');
const SKILLS_DIR = path.join(HOME, 'yos', '.claude', 'skills');
const BIN_DIR = path.join(YOS_DIR, 'bin');
const HTTP_DIR = path.join(YOS_DIR, 'http');

// Read a value from .env file (tolerates quotes and spaces around =)
function readEnvValue(key, defaultValue = '') {
  try {
    const content = fs.readFileSync(path.join(YOS_DIR, '.env'), 'utf8');
    const match = content.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm'));
    if (match) return match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  } catch {}
  return defaultValue;
}

// Build PATH: Claude locations + user's full shell PATH + PM2's own PATH
// Deduplicate to prevent PATH bloat across PM2 restarts — each restart
// re-evaluates this file with process.env.PATH already containing the
// previous ENHANCED_PATH, which would otherwise compound indefinitely.
const ENHANCED_PATH = [...new Set([
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, '.claude', 'bin'),
  ...(readEnvValue('SYSTEM_PATH') || '').split(':').filter(Boolean),
  ...(process.env.PATH || '').split(':').filter(Boolean),
])].join(':');

// Whether Claude should run with --dangerously-skip-permissions
const CLAUDE_BYPASS_PERMISSIONS = readEnvValue('CLAUDE_BYPASS_PERMISSIONS', 'true');
// Whether Codex should run with --dangerously-bypass-approvals-and-sandbox
const CODEX_BYPASS_PERMISSIONS = readEnvValue('CODEX_BYPASS_PERMISSIONS', 'true');
const YOS_ADMIN_CHANNEL = readEnvValue('YOS_ADMIN_CHANNEL');
const YOS_ADMIN_ENDPOINT = readEnvValue('YOS_ADMIN_ENDPOINT');

// Resolve the yos package root so deployed skills can import CLI modules.
// activity-monitor.js imports from cli/lib/runtime/, which is part of the
// yos npm package — not the skill's deployed directory.
let YOS_PACKAGE_ROOT = '';
try {
  const { execSync } = require('child_process');
  const yosBin = execSync(
    'command -v yos 2>/dev/null || true',
    { encoding: 'utf8', env: { ...process.env, PATH: ENHANCED_PATH }, stdio: ['pipe', 'pipe', 'pipe'] }
  ).trim();
  if (yosBin) {
    // Follow symlinks: npm installs a wrapper in .bin/ pointing to the package main file
    const realPath = fs.realpathSync(yosBin);
    // Installed path: <prefix>/lib/node_modules/yos/cli/yos.js → package root 2 dirs up
    const candidate = path.dirname(path.dirname(realPath));
    if (fs.existsSync(path.join(candidate, 'cli', 'lib', 'runtime', 'index.js'))) {
      YOS_PACKAGE_ROOT = candidate;
    }
  }
} catch { /* YOS_PACKAGE_ROOT stays empty — activity-monitor uses relative path fallback */ }

// Core service names — components must not collide with these
const CORE_SERVICE_NAMES = new Set([
  'scheduler', 'web-console', 'c4-dispatcher', 'activity-monitor', 'caddy',
]);

// Parse SKILL.md YAML frontmatter service block.
// Returns { name, entry } or null if no service declared.
function parseSkillService(skillMdPath) {
  const content = fs.readFileSync(skillMdPath, 'utf8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const lines = fmMatch[1].split('\n');
  let inService = false;
  let serviceIndent = 0;
  const serviceProps = {};

  for (const line of lines) {
    // Detect "service:" block start
    const serviceStart = line.match(/^(\s*)service:\s*(.*)$/);
    if (serviceStart) {
      const value = serviceStart[2].trim();
      // "service: null" or "service: ~" means no service
      if (value === 'null' || value === '~' || value === 'false') return null;
      // Inline value (not a block) — skip
      if (value && value !== '') return null;
      inService = true;
      serviceIndent = serviceStart[1].length;
      continue;
    }

    if (!inService) continue;

    // Check if we've exited the service block (dedented or new top-level key)
    const lineIndent = line.match(/^(\s*)/)[1].length;
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (lineIndent <= serviceIndent) break;

    // Parse key: value within service block
    const kv = line.match(/^\s+(\w+):\s*(.+)$/);
    if (kv) serviceProps[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }

  if (!serviceProps.name || !serviceProps.entry) return null;
  return { name: serviceProps.name, entry: serviceProps.entry };
}

// Restart policy floor for component services.
//
// Kept in sync with cli/lib/restart-policy.js — the CLI cannot be imported from
// here, because this file is a standalone artifact in the user's home directory
// that PM2 evaluates with only Node builtins available. Parity is asserted by
// cli/lib/__tests__/restart-floor-template.test.js.
//
// `max_restarts` without `min_uptime` is toothless: PM2 only counts a restart
// against the cap when the process died sooner than `min_uptime` (default 1s),
// so anything that takes a second or two to fail restarts forever. Components
// are not trusted to get this pair right — the platform enforces it.
const RESTART_FLOOR = { max_restarts: 10, min_uptime: '10s', min_uptime_ms: 10000 };

function parseUptimeMs(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = (match[2] || 'ms').toLowerCase();
  const scale = { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
  return amount * scale;
}

function applyRestartFloor(app) {
  if (!app || typeof app !== 'object') return app;
  const floored = { ...app };
  if (floored.autorestart === false) return floored;
  const cap = Number(floored.max_restarts);
  if (!Number.isInteger(cap) || cap < 0 || cap > RESTART_FLOOR.max_restarts) {
    floored.max_restarts = RESTART_FLOOR.max_restarts;
  }
  const uptimeMs = parseUptimeMs(floored.min_uptime);
  if (uptimeMs === null || uptimeMs < RESTART_FLOOR.min_uptime_ms) {
    floored.min_uptime = RESTART_FLOOR.min_uptime;
  }
  return floored;
}

// Load PM2 configs for installed components that declare a service.
// Each component can provide its own ecosystem.config.cjs in its skill directory.
// Falls back to generating a config from SKILL.md frontmatter if no ecosystem file exists.
function loadComponentServices() {
  const componentsFile = path.join(YOS_META_DIR, 'components.json');
  try {
    const components = JSON.parse(fs.readFileSync(componentsFile, 'utf8'));
    const apps = [];
    const usedNames = new Set(CORE_SERVICE_NAMES);

    for (const [name, meta] of Object.entries(components)) {
      try {
        // Skip components that haven't finished setup (AI-mode install in progress)
        if (meta && meta.setupComplete === false) continue;

        const skillDir = (meta && meta.skillDir) || path.join(SKILLS_DIR, name);

        // Try loading the component's own ecosystem.config.cjs
        const ecoPath = path.join(skillDir, 'ecosystem.config.cjs');
        if (fs.existsSync(ecoPath)) {
          try {
            const componentConfig = require(ecoPath);
            const componentApps = componentConfig.apps || [];
            for (const app of componentApps) {
              if (usedNames.has(app.name)) {
                console.warn(`[ecosystem] Skipping component "${name}" service "${app.name}": conflicts with existing service`);
                continue;
              }
              // Copy app to avoid mutating the require() cached object
              const safeApp = applyRestartFloor({ ...app, env: { ...app.env, PATH: ENHANCED_PATH } });
              usedNames.add(safeApp.name);
              apps.push(safeApp);
            }
            continue;
          } catch (err) {
            console.warn(`[ecosystem] Failed to load ${ecoPath}: ${err.message}, trying SKILL.md fallback`);
          }
        }

        // Fallback: parse SKILL.md frontmatter for service declaration
        const skillMd = path.join(skillDir, 'SKILL.md');
        if (!fs.existsSync(skillMd)) continue;
        const service = parseSkillService(skillMd);
        if (!service) continue;
        if (usedNames.has(service.name)) {
          console.warn(`[ecosystem] Skipping component "${name}" service "${service.name}": conflicts with existing service`);
          continue;
        }
        const dataDir = (meta && meta.dataDir) || path.join(YOS_DIR, 'components', name);
        usedNames.add(service.name);
        apps.push(applyRestartFloor({
          name: service.name,
          script: service.entry,
          cwd: skillDir,
          env: {
            PATH: ENHANCED_PATH,
            NODE_ENV: 'production',
          },
          autorestart: true,
          error_file: path.join(dataDir, 'logs', 'error.log'),
          out_file: path.join(dataDir, 'logs', 'out.log'),
          log_date_format: 'YYYY-MM-DD HH:mm:ss',
        }));
      } catch (err) {
        console.warn(`[ecosystem] Skipping component "${name}": ${err.message}`);
      }
    }
    return apps;
  } catch {
    // components.json missing or malformed — return empty, core services still start
    return [];
  }
}

module.exports = {
  apps: [
    {
      name: 'scheduler',
      script: path.join(SKILLS_DIR, 'scheduler', 'scripts', 'daemon.js'),
      cwd: YOS_DIR,
      env: {
        PATH: ENHANCED_PATH,
        NODE_ENV: 'production'
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'web-console',
      script: path.join(SKILLS_DIR, 'web-console', 'scripts', 'server.js'),
      cwd: HOME,
      env: {
        PATH: ENHANCED_PATH,
        NODE_ENV: 'production'
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'c4-dispatcher',
      script: path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-dispatcher.js'),
      cwd: path.join(SKILLS_DIR, 'comm-bridge', 'scripts'),
      env: {
        PATH: ENHANCED_PATH,
        NODE_ENV: 'production',
        YOS_ADMIN_CHANNEL,
        YOS_ADMIN_ENDPOINT
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'activity-monitor',
      script: path.join(SKILLS_DIR, 'activity-monitor', 'scripts', 'activity-monitor.js'),
      cwd: HOME,
      env: {
        PATH: ENHANCED_PATH,
        NODE_ENV: 'production',
        CLAUDE_BYPASS_PERMISSIONS,
        CODEX_BYPASS_PERMISSIONS,
        ...(YOS_PACKAGE_ROOT ? { YOS_PACKAGE_ROOT } : {}),
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    // Caddy web server (only if set up via `yos init`)
    ...(fs.existsSync(path.join(BIN_DIR, 'caddy')) && fs.existsSync(path.join(HTTP_DIR, 'Caddyfile'))
      ? [{
          name: 'caddy',
          script: path.join(BIN_DIR, 'caddy'),
          args: `run --config ${path.join(HTTP_DIR, 'Caddyfile')} --adapter caddyfile`,
          cwd: YOS_DIR,
          env: {
            PATH: ENHANCED_PATH,
            HOME: HOME,
          },
          autorestart: true,
          max_restarts: 10,
          min_uptime: '10s',
          kill_timeout: 5000,
        }]
      : []),
    // Component services — dynamically loaded from components.json
    ...loadComponentServices(),
  ]
};
