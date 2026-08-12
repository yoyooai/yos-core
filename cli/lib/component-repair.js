import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseSkillMd } from './skill.js';

export const COMPONENT_REPAIR_TIMEOUT_MS = 10 * 60 * 1000;

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function resolveRepairHook(skillDir, hookRef) {
  if (typeof hookRef !== 'string' || hookRef.trim() === '') return null;
  const root = fs.realpathSync(skillDir);
  const candidate = path.resolve(root, hookRef);
  if (!isInside(root, candidate) || !fs.existsSync(candidate)) return null;
  const realCandidate = fs.realpathSync(candidate);
  if (!isInside(root, realCandidate) || !fs.statSync(realCandidate).isFile()) return null;
  return realCandidate;
}

function readStructuredFailure(stderr) {
  const match = String(stderr ?? '').match(/^\[([a-z0-9_]+)] ([^\r\n]+)(?:\r?\n([^\r\n]+))?/m);
  if (!match || !match[1].startsWith('feishu_')) return null;
  return { code: match[1], message: match[2], remediation: match[3] || null };
}

/**
 * Run an explicitly declared, idempotent component repair hook.
 * Components without this contract preserve the historical no-op behavior.
 */
export function runComponentRepair({
  componentName,
  skillDir,
  stdio = 'inherit',
  spawn = spawnSync,
} = {}) {
  const parsed = parseSkillMd(skillDir);
  const hookRef = parsed?.frontmatter?.lifecycle?.hooks?.repair;
  if (typeof hookRef !== 'string' || hookRef.trim() === '') {
    return { declared: false, success: true };
  }

  const hookPath = resolveRepairHook(skillDir, hookRef);
  if (!hookPath) {
    return {
      declared: true,
      success: false,
      code: 'component_repair_invalid',
      message: 'The declared component repair hook is missing or outside the installed component.',
    };
  }

  const child = spawn(process.execPath, [hookPath], {
    cwd: skillDir,
    encoding: 'utf8',
    stdio: ['ignore', stdio, stdio],
    timeout: COMPONENT_REPAIR_TIMEOUT_MS,
    env: {
      ...process.env,
      YOS_COMPONENT: componentName,
      YOS_SKILL_DIR: skillDir,
    },
  });

  if (child.error || child.status !== 0) {
    const structured = readStructuredFailure(child.stderr);
    return {
      declared: true,
      success: false,
      code: structured?.code ?? 'component_repair_failed',
      status: Number.isInteger(child.status) ? child.status : null,
      message: structured?.message ?? 'Component integrity repair did not complete. Fix the reported cause and retry the upgrade.',
      remediation: structured?.remediation ?? null,
    };
  }

  return { declared: true, success: true };
}
