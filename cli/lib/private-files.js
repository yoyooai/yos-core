import fs from 'node:fs';
import path from 'node:path';

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Write a file that may contain credentials, tightening permissive existing
 * modes as well as setting safe modes for newly created files.
 */
export function writePrivateFileSync(filePath, data, { privateParent = false } = {}) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, {
    recursive: true,
    ...(privateParent ? { mode: PRIVATE_DIRECTORY_MODE } : {}),
  });
  if (privateParent) fs.chmodSync(parent, PRIVATE_DIRECTORY_MODE);
  fs.writeFileSync(filePath, data, { mode: PRIVATE_FILE_MODE });
  fs.chmodSync(filePath, PRIVATE_FILE_MODE);
}

/** Tighten an existing private file without changing its contents. */
export function securePrivateFileSync(filePath, { privateParent = false } = {}) {
  const parent = path.dirname(filePath);
  if (privateParent && fs.existsSync(parent)) fs.chmodSync(parent, PRIVATE_DIRECTORY_MODE);
  if (fs.existsSync(filePath)) fs.chmodSync(filePath, PRIVATE_FILE_MODE);
}
