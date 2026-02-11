/**
 * Nostr utilities — event creation, signing, publishing
 */

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';

const DEFAULT_RELAYS = ['wss://nos.lol', 'wss://relay.damus.io'];

export interface AgentProfile {
  name: string;
  description?: string;
  capabilities?: string[];
  framework?: string;
  model?: string;
  website?: string;
  avatar?: string;
  lightning?: string;
  human?: string;
  ownerX?: string;
  status?: string;
  messagingPolicy?: string;
  messagingMinTrust?: number;
  messagingFee?: number;
}

/**
 * Parse a secret key from nsec, hex, or key file
 */
export function parseSecretKey(input: string): Uint8Array {
  // If it's an nsec
  if (input.startsWith('nsec')) {
    const decoded = nip19.decode(input);
    if (decoded.type !== 'nsec') throw new Error('Invalid nsec');
    return decoded.data;
  }
  // Hex string
  if (/^[0-9a-f]{64}$/i.test(input)) {
    return Uint8Array.from(Buffer.from(input, 'hex'));
  }
  throw new Error('Invalid key format. Provide nsec or 64-char hex.');
}

/**
 * Get npub from secret key
 */
export function getNpub(sk: Uint8Array): string {
  const pubHex = getPublicKey(sk);
  return nip19.npubEncode(pubHex);
}

/**
 * Get hex pubkey from secret key
 */
export function getPubkeyHex(sk: Uint8Array): string {
  return getPublicKey(sk);
}

/**
 * Build and sign a kind 31337 agent profile event
 */
export function createProfileEvent(sk: Uint8Array, profile: AgentProfile) {
  const tags: string[][] = [
    ['d', 'agentdex-profile'],
    ['name', profile.name],
  ];

  if (profile.description) tags.push(['description', profile.description]);
  if (profile.capabilities) {
    for (const cap of profile.capabilities) {
      tags.push(['capability', cap]);
    }
  }
  if (profile.framework) tags.push(['framework', profile.framework]);
  if (profile.model) tags.push(['model', profile.model]);
  if (profile.website) tags.push(['website', profile.website]);
  if (profile.avatar) tags.push(['avatar', profile.avatar]);
  if (profile.lightning) tags.push(['lightning', profile.lightning]);
  if (profile.human) tags.push(['human', profile.human]);
  if (profile.ownerX) tags.push(['owner_x', profile.ownerX]);
  if (profile.status) tags.push(['status', profile.status || 'active']);
  if (profile.messagingPolicy) tags.push(['messaging_policy', profile.messagingPolicy]);
  if (profile.messagingMinTrust) tags.push(['messaging_min_trust', String(profile.messagingMinTrust)]);
  if (profile.messagingFee) tags.push(['messaging_fee', String(profile.messagingFee)]);

  const event = finalizeEvent({
    kind: 31337,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }, sk);

  return event;
}

/**
 * Publish an event to Nostr relays
 */
export async function publishToRelays(event: object, relays: string[] = DEFAULT_RELAYS): Promise<string[]> {
  const pool = new SimplePool();
  const published: string[] = [];

  try {
    const results = await Promise.allSettled(
      relays.map(async (relay) => {
        await pool.publish([relay], event as any);
        return relay;
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        published.push(result.value);
      }
    }
  } finally {
    pool.close(relays);
  }

  return published;
}

/**
 * Build and sign a kind 0 profile metadata event (for NIP-05 verification).
 * After claiming a NIP-05 name, publish this to relays so Nostr clients
 * (njump, Damus, Primal) can verify the identity.
 */
export function createKind0Event(sk: Uint8Array, profile: { name: string; about?: string; nip05?: string; picture?: string }) {
  return finalizeEvent({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({
      name: profile.name,
      ...(profile.about && { about: profile.about }),
      ...(profile.nip05 && { nip05: profile.nip05 }),
      ...(profile.picture && { picture: profile.picture }),
    }),
  }, sk);
}

/**
 * Create and sign a kind 1 note tagged #agentdex
 */
export function createNote(sk: Uint8Array, content: string) {
  return finalizeEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['t', 'agentdex']],
    content,
  }, sk);
}
