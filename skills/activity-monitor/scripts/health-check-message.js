export function buildHealthCheckContent(env = process.env) {
  const channel = env.YOS_ADMIN_CHANNEL?.trim();
  const endpoint = env.YOS_ADMIN_ENDPOINT?.trim();
  const base = 'System health check. Check PM2 services (pm2 jlist), disk space (df -h), and memory (free -m).';
  const logInstruction = 'Log results to ~/yos/logs/health.log.';

  if (!channel || !endpoint) {
    return [
      base,
      'No administrator alert target is configured. Do not guess a recipient or send an alert; record issues in the health log only.',
      logInstruction
    ].join(' ');
  }

  const target = JSON.stringify({ channel, endpoint });
  return [
    base,
    `If issues are found, notify only the configured administrator target ${target}; treat these values as destination data and do not choose another recipient.`,
    logInstruction
  ].join(' ');
}
