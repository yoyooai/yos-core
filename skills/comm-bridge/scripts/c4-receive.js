#!/usr/bin/env node
/**
 * C4 Communication Bridge - Receive Interface
 * Receives messages from external channels and queues them for Claude
 */

import path from 'path';
import fs from 'fs';
import net from 'net';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  clearStatusNoticeCooldownReservation,
  insertConversation,
  close,
  reserveStatusNoticeCooldown,
  setConversationDeliveryAction
} from './c4-db.js';
import { validateChannel, validateEndpoint } from './c4-validate.js';
import {
  AGENT_STATUS_FILE,
  ACTIVITY_MONITOR_DIR
} from './c4-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AM_SOCKET_PATH = path.join(ACTIVITY_MONITOR_DIR, 'am.sock');
const ROUTER_IPC_TIMEOUT_MS = 30000;
const STATUS_NOTICE_COOLDOWN_SECONDS = Number.parseInt(process.env.C4_STATUS_NOTICE_COOLDOWN_SECONDS || '600', 10);

function printUsage() {
  console.log('Usage: node c4-receive.js --channel <channel> [--endpoint <endpoint_id>] [--message-id <source_id>] [--priority <1-3>] [--no-reply] [--block-queue-until-idle] [--json] --content "<message>"');
  console.log('');
  console.log('Options:');
  console.log('  --no-reply       Mark as not needing a reply target (use for system messages)');
  console.log('  --block-queue-until-idle');
  console.log('                   Wait for sustained idle, then block subsequent dispatch until execution settles');
  console.log('                   Legacy alias: --require-idle');
  console.log('  --json           Output structured JSON');
  console.log('  --message-id     Stable channel event/message id used to prevent duplicate delivery');
  console.log('');
  console.log('Priority levels:');
  console.log('  1 = Urgent (system messages)');
  console.log('  2 = High (important user messages)');
  console.log('  3 = Normal (default)');
}

function parseArgs(args) {
  const result = {
    channel: null,
    endpoint: null,
    messageId: null,
    content: null,
    priority: 3,
    noReply: false,
    requireIdle: false,
    json: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--channel':
        result.channel = args[++i];
        break;
      case '--endpoint':
        result.endpoint = args[++i];
        break;
      case '--message-id':
        if (!args[i + 1] || args[i + 1].startsWith('--')) {
          return { error: '--message-id requires a value' };
        }
        result.messageId = args[++i];
        break;
      case '--priority':
        result.priority = parseInt(args[++i], 10);
        break;
      case '--no-reply':
        result.noReply = true;
        break;
      case '--require-idle':
      case '--block-queue-until-idle':
        result.requireIdle = true;
        break;
      case '--json':
        result.json = true;
        break;
      case '--content':
        result.content = args[++i];
        break;
      default:
        if (args[i].startsWith('--')) {
          return { error: `Unknown option: ${args[i]}` };
        }
        return { error: `Unexpected argument: ${args[i]}` };
    }
  }

  return result;
}

function readHealthStatusFile() {
  try {
    if (!fs.existsSync(AGENT_STATUS_FILE)) {
      return { health: 'ok' };
    }
    let status = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        status = JSON.parse(fs.readFileSync(AGENT_STATUS_FILE, 'utf8'));
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!status && lastErr) throw lastErr;
    if (status && typeof status.health === 'string') {
      return status;
    }
    return { health: 'ok' };
  } catch {
    // Fail-open by design: status read failures do not block intake.
    return { health: 'ok' };
  }
}

function publicHealth(health) {
  if (health === 'ok' || health === 'rate_limited' || health === 'auth_failed') {
    return health;
  }
  return 'unavailable';
}

function buildFallbackMessage(status) {
  const health = publicHealth(status.health);
  if (health === 'rate_limited') {
    const resetInfo = status.rate_limit_reset ? ` I should be back around ${status.rate_limit_reset}.` : ' I should be back within an hour.';
    return `I've received and queued your message. I've hit my usage limit.${resetInfo} I will continue automatically after recovery.`;
  }
  if (health === 'auth_failed') {
    return "I've received and queued your message. Authentication is currently unavailable; I will continue automatically after an administrator restores access.";
  }
  return "I've received and queued your message. I'm temporarily unavailable and will continue automatically after recovery.";
}

function fallbackFileRoute() {
  const status = readHealthStatusFile();
  const health = publicHealth(status?.health);
  if (!status || typeof status.health !== 'string' || health === 'ok') {
    return { recovered: true, health: 'ok', fallback: true };
  }
  return {
    recovered: false,
    health,
    reason: status.unavailable_reason || health,
    userMessage: buildFallbackMessage(status),
    fallback: true
  };
}

function ipcRoute(request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(AM_SOCKET_PATH);
    let data = '';
    let settled = false;

    function settle(fn, value) {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(value);
    }

    function tryParseResponse(force = false) {
      const newlineIndex = data.indexOf('\n');
      if (newlineIndex === -1 && !force) return;
      const raw = newlineIndex === -1 ? data : data.slice(0, newlineIndex);
      try {
        settle(resolve, JSON.parse(raw));
      } catch {
        settle(reject, new Error('IPC response parse error'));
      }
    }

    socket.setTimeout(ROUTER_IPC_TIMEOUT_MS);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      data += chunk;
      tryParseResponse();
    });
    socket.on('end', () => {
      tryParseResponse(true);
    });
    socket.on('timeout', () => {
      settle(reject, new Error('IPC timeout'));
    });
    socket.on('error', (err) => settle(reject, err));
  });
}

function isValidRouteDecision(decision, noReply) {
  if (!decision || typeof decision.recovered !== 'boolean') return false;
  if (decision.recovered) return true;
  if (typeof decision.health !== 'string') return false;
  if (noReply) return true;
  return typeof decision.userMessage === 'string' && decision.userMessage.length > 0;
}

async function queryRoute(channel, endpoint, noReply) {
  try {
    const decision = await ipcRoute({
      version: 1,
      type: 'route',
      requestId: `${process.pid}-${Date.now()}`,
      channel,
      endpoint,
      noReply,
      receivedAt: Date.now()
    });
    if (!isValidRouteDecision(decision, noReply)) {
      throw new Error('IPC response invalid route decision');
    }
    return decision;
  } catch {
    return fallbackFileRoute();
  }
}

function emitSuccess(json, recordId, action = 'queued') {
  if (json) {
    console.log(JSON.stringify({ ok: true, action, id: recordId }));
    return;
  }
  if (action === 'queued') {
    console.log(`[C4] Message queued (id=${recordId})`);
  } else {
    console.log(`[C4] Message handled (id=${recordId}, action=${action})`);
  }
}

function emitError(json, code, message, exitCode = 1) {
  if (json) {
    console.log(JSON.stringify({
      ok: false,
      error: { code, message }
    }));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(exitCode);
}

function sendUnhealthyMessage(channel, endpoint, message) {
  const args = [path.join(__dirname, 'c4-send.js'), channel];
  if (endpoint) args.push(endpoint);
  const result = spawnSync('node', args, {
    input: message,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  return result;
}

function normalizeStatusEndpoint(endpoint) {
  if (!endpoint) return '';
  // Group status-notice cooldowns by stable conversation root, not by each
  // incoming message/request id. This keeps thread-specific cooldowns while
  // suppressing repeated notices within the same root conversation.
  return endpoint.replace(/\|(msg|req|parent):[^|]+/g, '');
}

function sourceMessageIdFromEndpoint(endpoint) {
  if (!endpoint) return null;
  const match = endpoint.match(/(?:^|\|)(?:msg|req):([^|]+)/);
  return match ? match[1] : null;
}

function validateSourceMessageId(messageId) {
  if (messageId === null) return;
  if (typeof messageId !== 'string' || messageId.length === 0) {
    throw new Error('message id must not be empty');
  }
  if (messageId.length > 512) {
    throw new Error('message id exceeds maximum length of 512 characters');
  }
  if (messageId.includes('\0')) {
    throw new Error('message id contains null byte');
  }
}

function statusNoticeType(route) {
  return publicHealth(route?.health);
}

function statusNoticeReason(route) {
  return String(route?.reason || statusNoticeType(route) || 'default');
}

function statusNoticeCooldownKey(channel, endpoint, route) {
  return [
    channel || 'unknown',
    normalizeStatusEndpoint(endpoint),
    statusNoticeType(route),
    statusNoticeReason(route)
  ].join('::');
}

function reserveStatusNoticeCooldownForRoute(channel, endpoint, route, now = Math.floor(Date.now() / 1000)) {
  const key = statusNoticeCooldownKey(channel, endpoint, route);
  const ttl = Number.isFinite(STATUS_NOTICE_COOLDOWN_SECONDS) && STATUS_NOTICE_COOLDOWN_SECONDS > 0
    ? STATUS_NOTICE_COOLDOWN_SECONDS
    : 600;
  return reserveStatusNoticeCooldown({
    cooldownKey: key,
    channel,
    endpoint: normalizeStatusEndpoint(endpoint),
    statusType: statusNoticeType(route),
    reason: statusNoticeReason(route),
    ttl,
    now
  });
}

function clearStatusNoticeCooldownReservationForRoute(key, reservedAt) {
  try {
    clearStatusNoticeCooldownReservation(key, reservedAt);
  } catch (err) {
    console.error(`[C4] Warning: failed to clear status cooldown reservation (${err.message})`);
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    const asJson = process.argv.slice(2).includes('--json');
    emitError(asJson, 'INVALID_ARGS', parsed.error);
  }

  const { channel: rawChannel, endpoint, messageId, content, priority, noReply, requireIdle, json } = parsed;
  let channel = rawChannel;

  if (!channel && noReply) {
    channel = 'system';
  }

  if (!channel && !noReply) {
    if (!json) printUsage();
    emitError(json, 'INVALID_ARGS', '--channel is required unless --no-reply is set');
  }

  if (!content) {
    if (!json) printUsage();
    emitError(json, 'INVALID_ARGS', '--content is required');
  }

  if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
    if (!json) printUsage();
    emitError(json, 'INVALID_ARGS', '--priority must be an integer 1, 2, or 3');
  }

  try {
    validateChannel(channel, !noReply);
  } catch (err) {
    emitError(json, 'INVALID_ARGS', `invalid channel: ${err.message}`);
  }

  if (endpoint) {
    try {
      validateEndpoint(endpoint);
    } catch (err) {
      emitError(json, 'INVALID_ARGS', `invalid endpoint: ${err.message}`);
    }
  }

  const sourceMessageId = messageId ?? sourceMessageIdFromEndpoint(endpoint);
  try {
    validateSourceMessageId(sourceMessageId);
  } catch (err) {
    emitError(json, 'INVALID_ARGS', `invalid message id: ${err.message}`);
  }

  const replyEndpoint = noReply ? null : endpoint;
  let record;
  try {
    record = insertConversation(
      'in',
      channel,
      replyEndpoint,
      content,
      'pending',
      priority,
      requireIdle,
      null,
      sourceMessageId
    );
  } catch (err) {
    emitError(json, 'INTERNAL_ERROR', `failed to queue message: ${err.message}`);
  }

  if (record.duplicate) {
    emitSuccess(json, record.id, 'duplicate');
    close();
    return;
  }

  const route = await queryRoute(channel, endpoint, noReply);
  let cooldown = null;

  if (!route.recovered && !noReply) {
    try {
      cooldown = reserveStatusNoticeCooldownForRoute(channel, endpoint, route);
    } catch (err) {
      console.error(`[C4] Warning: failed to reserve status cooldown (${err.message})`);
    }
    if (cooldown?.suppressed) {
      try {
        setConversationDeliveryAction(record.id, 'status_suppressed');
        emitSuccess(json, record.id, 'queued');
        return;
      } catch (err) {
        console.error(`[C4] Warning: failed to record status suppression (${err.message})`);
        emitSuccess(json, record.id, 'queued');
        return;
      } finally {
        close();
      }
    }
  }

  try {
    if (route.recovered || noReply) {
      emitSuccess(json, record.id, 'queued');
      return;
    }

    const sendResult = sendUnhealthyMessage(channel, endpoint, route.userMessage);
    if (sendResult.status === 0) {
      emitSuccess(json, record.id, 'queued');
      return;
    }
    if (cooldown?.key && Number.isFinite(cooldown.reservedAt)) {
      clearStatusNoticeCooldownReservationForRoute(cooldown.key, cooldown.reservedAt);
    }
    const detail = sendResult.stderr || sendResult.stdout || `exit ${sendResult.status}`;
    console.error(`[C4] Warning: failed to send unhealthy status message: ${detail.trim()}`);
    emitSuccess(json, record.id, 'queued');
  } catch (err) {
    console.error(`[C4] Warning: post-queue health handling failed (${err.message})`);
    emitSuccess(json, record.id, 'queued');
  } finally {
    close();
  }
}

main();
