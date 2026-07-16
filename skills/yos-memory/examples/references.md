# References

## Configuration Sources
- Environment: ~/yos/.env (TZ, DOMAIN, PROXY, API keys)
- Installed components: ~/yos/.yos/components.json

## Key Paths
- Memory: ~/yos/memory/
- Skills: ~/yos/.claude/skills/
- C4 Database: ~/yos/comm-bridge/c4.db

## Services
- Scheduler: PM2-managed, see ~/yos/pm2/ecosystem.config.cjs
- HTTP proxy: see .env PROXY

## Active IDs
- Telegram chat with Howard: 12345678
- Lark group "Dev Team": og_abcdef123

## Notes
- For TZ, domain, proxy: see .env
- This file is a pointer/index. Do NOT duplicate config values here.
