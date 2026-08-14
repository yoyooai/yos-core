import fs from 'node:fs';
import path from 'node:path';

import { YOS_DIR } from './config.js';

/** Identify an install without trusting the directory name alone. */
export function inspectYosDirectory(yosDir = YOS_DIR, fsApi = fs) {
  if (!fsApi.existsSync(yosDir)) return { state: 'missing', markers: [] };

  const markers = [
    path.join(yosDir, '.yos'),
    path.join(yosDir, '.claude', 'skills'),
    path.join(yosDir, '.yos', 'components.json'),
  ];
  const present = markers.filter((marker) => fsApi.existsSync(marker));
  if (present.length === markers.length) return { state: 'complete', markers: present };
  if (present.length > 0) return { state: 'incomplete', markers: present };
  return { state: 'unrelated', markers: [] };
}

/**
 * Refuse normal commands when YOS_DIR points at somebody else's directory.
 * `yos init` owns fresh installation recovery and is intentionally exempt.
 * A partial marker set is also allowed: existing workflows support adding a
 * component while init is still creating the install, and the individual
 * command remains responsible for the files it needs.
 */
export function assertCommandDirectory(command, { yosDir = YOS_DIR, fsApi = fs } = {}) {
  if (command === 'init') return;
  const inspection = inspectYosDirectory(yosDir, fsApi);
  if (inspection.state === 'unrelated') {
    const error = new Error(
      'YOS_DIR points to an existing directory that is not a YOS installation. ' +
      'Repair: unset YOS_DIR to use ~/yos, or choose another directory and run yos init.'
    );
    error.code = 'YOS_DIR_NOT_INSTALLATION';
    throw error;
  }
}
