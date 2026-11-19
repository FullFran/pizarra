import { MODEL_ID } from './protocol.js';
import { AgentAllowlist } from './allowlist.js';

export interface AgentConfig {
  users: AgentAllowlist;
  /** AES-256-GCM key of the credential vault. */
  key: Buffer;
  /** Operator's model allowlist; unset: every model of the person's account. */
  models?: string[];
  maxProcesses: number;
  /** Where the vault lives (`<dataDir>/agent/credentials`). */
  dataDir: string;
}

type Env = Record<string, string | undefined>;

/** Reads the 32-byte vault key (base64 or base64url). */
export function parseAgentKey(value: string | undefined): Buffer {
  const text = value?.trim() ?? '';
  const key = /^[A-Za-z0-9+/_-]+={0,2}$/.test(text) ? Buffer.from(text, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) throw new Error('PIZARRA_AGENT_KEY must be 32 random bytes, base64 encoded (for example `openssl rand -base64 32`)');
  return key;
}

/**
 * The agent's settings from the environment. `PIZARRA_AGENT` unset, empty, `0` or `false`: off,
 * nothing else is read. `1` or `true`: on, and every required variable must be valid or this
 * throws naming it. Anything else is refused rather than guessed.
 */
export function resolveAgentConfig(env: Env, base: { dataDir?: string | undefined }): AgentConfig | undefined {
  const flag = env.PIZARRA_AGENT?.trim().toLowerCase() ?? '';
  if (flag === '' || flag === '0' || flag === 'false') return undefined;
  if (flag !== '1' && flag !== 'true') throw new Error(`PIZARRA_AGENT must be 1 or 0, got ${JSON.stringify(env.PIZARRA_AGENT)}`);
  if (!base.dataDir) throw new Error('PIZARRA_AGENT=1 needs EXCALIDRAW_DATA_DIR: the encrypted credentials are kept there');
  const users = AgentAllowlist.parse(env.PIZARRA_AGENT_USERS);
  const key = parseAgentKey(env.PIZARRA_AGENT_KEY);
  const modelsRaw = env.PIZARRA_AGENT_MODELS?.trim();
  let models: string[] | undefined;
  if (modelsRaw) {
    models = [...new Set(modelsRaw.split(',').map(model => model.trim()).filter(Boolean))];
    const bad = models.find(model => !MODEL_ID.test(model));
    if (bad !== undefined || models.length === 0) throw new Error(`PIZARRA_AGENT_MODELS must list model ids separated by commas, got ${JSON.stringify(bad ?? modelsRaw)}`);
  }
  const processesRaw = env.PIZARRA_AGENT_MAX_PROCESSES?.trim();
  let maxProcesses = 2;
  if (processesRaw) {
    if (!/^\d+$/.test(processesRaw) || Number(processesRaw) < 1 || Number(processesRaw) > 16) {
      throw new Error(`PIZARRA_AGENT_MAX_PROCESSES must be a whole number from 1 to 16, got ${JSON.stringify(processesRaw)}`);
    }
    maxProcesses = Number(processesRaw);
  }
  return { users, key, ...(models ? { models } : {}), maxProcesses, dataDir: base.dataDir };
}
