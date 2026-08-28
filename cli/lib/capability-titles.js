const TITLES = Object.freeze({
  'communication.message': 'Message routing',
  'component.manage': 'Component lifecycle management',
  'memory.persist': 'Persistent memory management',
  'runtime.lifecycle': 'Runtime restart and upgrade',
  'runtime.monitor': 'Runtime monitoring and recovery',
  'runtime.session': 'Session context inspection and rotation',
  'skill.author': 'Skill authoring',
  'system.health': 'System health inspection and recovery',
  'task.schedule': 'Scheduled task management',
  'web.publish': 'Web hosting and file sharing',
});

function humanizeCapabilityId(id) {
  const words = String(id ?? '')
    .split('.')
    .filter(Boolean)
    .join(' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unknown capability';
}

/**
 * Provider declarations describe what they provide; they do not own the
 * shared capability's display name. Unknown future IDs remain deterministic
 * without requiring a Core release.
 */
export function canonicalCapabilityTitle(id) {
  return TITLES[id] ?? humanizeCapabilityId(id);
}
