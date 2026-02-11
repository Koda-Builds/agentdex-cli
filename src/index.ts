/**
 * agentdex — SDK and CLI for the agentdex AI agent directory
 * 
 * @example
 * ```typescript
 * import { AgentdexClient } from 'agentdex';
 * 
 * const client = new AgentdexClient({ apiKey: 'adx_...' });
 * const result = await client.verify('npub1...');
 * ```
 */

export { AgentdexClient } from './client.js';
export type {
  AgentdexConfig,
  RegisterOptions,
  VerifyResult,
  ClaimResult,
  ClaimStatus,
  SearchOptions,
} from './client.js';

export {
  parseSecretKey,
  getNpub,
  getPubkeyHex,
  createProfileEvent,
  createKind0Event,
  publishToRelays,
  createNote,
} from './nostr.js';
export type { AgentProfile } from './nostr.js';
