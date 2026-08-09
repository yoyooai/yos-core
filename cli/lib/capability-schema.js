import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const CAPABILITY_FIELDS = new Set([
  'id',
  'title',
  'operations',
  'keywords',
  'stability',
  'health',
]);
const STABILITIES = new Set(['stable', 'beta', 'experimental']);
const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function invalid(message) {
  const error = new Error(message);
  error.code = 'capability_schema_invalid';
  return error;
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireStringArray(value, field, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw invalid(`${field} must be ${nonEmpty ? 'a non-empty' : 'an'} array`);
  }
  const normalized = value.map((item) => requireString(item, field));
  if (new Set(normalized).size !== normalized.length) {
    throw invalid(`${field} contains duplicate values`);
  }
  return normalized;
}

function validateHealthEntry(health, skillDir, lstat) {
  const normalized = requireString(health, 'health');
  if (path.isAbsolute(normalized) || normalized.split(/[\\/]+/).includes('..')) {
    throw invalid('health must stay inside the provider directory');
  }

  const providerRoot = path.resolve(skillDir);
  const resolved = path.resolve(providerRoot, normalized);
  if (resolved !== providerRoot && !resolved.startsWith(`${providerRoot}${path.sep}`)) {
    throw invalid('health path escapes the provider directory');
  }

  let cursor = providerRoot;
  for (const segment of path.relative(providerRoot, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      if (lstat(cursor).isSymbolicLink()) {
        throw invalid('health path must not contain symbolic links');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
  return normalized;
}

export function validateCapabilityDeclarations(frontmatter, {
  skillDir,
  lstat = fs.lstatSync,
} = {}) {
  if (!frontmatter || !Object.hasOwn(frontmatter, 'capabilities')) {
    return { declarationStatus: 'undeclared', capabilities: [] };
  }
  if (!Array.isArray(frontmatter.capabilities) || frontmatter.capabilities.length === 0) {
    throw invalid('capabilities must be a non-empty array when declared');
  }
  if (!skillDir) throw invalid('skillDir is required to validate capabilities');

  const ids = new Set();
  const capabilities = frontmatter.capabilities.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw invalid(`capabilities[${index}] must be an object`);
    }
    const unknown = Object.keys(entry).filter((key) => !CAPABILITY_FIELDS.has(key));
    if (unknown.length > 0) throw invalid(`unknown capability field: ${unknown.join(', ')}`);

    const id = requireString(entry.id, 'id');
    if (!IDENTIFIER.test(id)) throw invalid(`invalid capability id: ${id}`);
    if (ids.has(id)) throw invalid(`duplicate capability id: ${id}`);
    ids.add(id);

    const operations = requireStringArray(entry.operations, 'operations', { nonEmpty: true });
    for (const operation of operations) {
      if (!IDENTIFIER.test(operation)) throw invalid(`invalid operation: ${operation}`);
    }

    const keywords = entry.keywords === undefined
      ? []
      : requireStringArray(entry.keywords, 'keywords');
    const stability = requireString(entry.stability, 'stability');
    if (!STABILITIES.has(stability)) throw invalid(`invalid stability: ${stability}`);

    const capability = {
      id,
      title: requireString(entry.title, 'title'),
      operations,
      keywords,
      stability,
    };
    if (entry.health !== undefined) {
      capability.health = validateHealthEntry(entry.health, skillDir, lstat);
    }
    return capability;
  });

  return { declarationStatus: 'declared', capabilities };
}

export function parseCapabilitySkill(skillDir, {
  readFile = fs.readFileSync,
  lstat = fs.lstatSync,
} = {}) {
  const skillPath = path.join(skillDir, 'SKILL.md');
  let content;
  try {
    content = readFile(skillPath, 'utf8');
  } catch (error) {
    const wrapped = invalid('SKILL.md could not be read');
    wrapped.cause = error;
    throw wrapped;
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { frontmatter: {}, ...validateCapabilityDeclarations({}, { skillDir, lstat }) };

  let frontmatter;
  try {
    frontmatter = yaml.load(match[1], { schema: yaml.JSON_SCHEMA }) || {};
  } catch (error) {
    const wrapped = invalid('SKILL.md frontmatter is invalid YAML');
    wrapped.cause = error;
    throw wrapped;
  }
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw invalid('SKILL.md frontmatter must be an object');
  }
  return { frontmatter, ...validateCapabilityDeclarations(frontmatter, { skillDir, lstat }) };
}
