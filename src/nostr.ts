/**
 * Nostr utilities — event creation, signing, publishing
 */

import { finalizeEvent, getPublicKey, generateSecretKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';
import { mkdirSync, writeFileSync } from 'fs';

const DEFAULT_RELAYS = ['wss://nos.lol', 'wss://relay.damus.io'];

export interface PortfolioItem {
  url: string;
  name?: string;
  description?: string;
}

export interface AgentProfile {
  name?: string;
  description?: string;
  capabilities?: string[];
  framework?: string;
  model?: string;
  ownerType?: string;
  ownerX?: string;
  status?: string;
  parent?: string;
  messagingPolicy?: string;
  messagingMinTrust?: number;
  messagingFee?: number;
  portfolio?: PortfolioItem[];
  skills?: string[];
  experience?: string[];
}

/**
 * Generate a new Nostr keypair and save to a JSON file.
 * Returns the secret key as Uint8Array.
 */
export function generateAndSaveKeypair(outputPath: string): { sk: Uint8Array; npub: string; path: string } {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const nsec = nip19.nsecEncode(sk);
  const npub = nip19.npubEncode(pk);
  const skHex = Buffer.from(sk).toString('hex');

  const data = JSON.stringify({ nsec, npub, sk_hex: skHex, pk_hex: pk }, null, 2);

  // Ensure directory exists
  const dir = outputPath.substring(0, outputPath.lastIndexOf('/'));
  if (dir) mkdirSync(dir, { recursive: true });

  writeFileSync(outputPath, data, { mode: 0o600 });
  return { sk, npub, path: outputPath };
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
 * Build and sign a kind 31339 agent profile event
 */
export function createProfileEvent(sk: Uint8Array, profile: AgentProfile) {
  const tags: string[][] = [
    ['d', 'agentdex-profile'],
  ];

  // Kind 31339 is agent-specific metadata ONLY
  // Basic profile (name, avatar, website, nip05, lud16) lives exclusively in kind 0
  if (profile.description) tags.push(['description', profile.description]);
  if (profile.capabilities) {
    for (const cap of profile.capabilities) {
      tags.push(['capability', cap]);
    }
  }
  if (profile.framework) tags.push(['framework', profile.framework]);
  if (profile.model) tags.push(['model', profile.model]);
  if (profile.ownerType) tags.push(['owner_type', profile.ownerType]);
  if (profile.ownerX) tags.push(['owner_x', profile.ownerX]);
  if (profile.parent) tags.push(['parent', profile.parent]);
  if (profile.status) tags.push(['status', profile.status || 'active']);
  if (profile.messagingPolicy) tags.push(['messaging_policy', profile.messagingPolicy]);
  if (profile.messagingMinTrust) tags.push(['messaging_min_trust', String(profile.messagingMinTrust)]);
  if (profile.messagingFee) tags.push(['messaging_fee', String(profile.messagingFee)]);
  if (profile.portfolio) {
    for (const item of profile.portfolio) {
      const tag = ['portfolio', item.url];
      if (item.name) tag.push(item.name);
      if (item.description) tag.push(item.description);
      tags.push(tag);
    }
  }
  if (profile.skills) {
    for (const skill of profile.skills) {
      tags.push(['skill', skill]);
    }
  }
  if (profile.experience) {
    for (const exp of profile.experience) {
      tags.push(['experience', exp]);
    }
  }

  const event = finalizeEvent({
    kind: 31339,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }, sk);

  return event;
}

/**
 * Publish an event to Nostr relays
 */
export async function publishToRelays(event: object, relays: string[] = DEFAULT_RELAYS, timeoutMs = 10000): Promise<string[]> {
  const pool = new SimplePool();
  const published: string[] = [];

  try {
    const results = await Promise.allSettled(
      relays.map(async (relay) => {
        await Promise.race([
          pool.publish([relay], event as any),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
        ]);
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
 * Fetch existing kind 0, merge new fields, and republish.
 * Used to set lud16 (lightning address) during registration.
 */
export async function updateKind0(sk: Uint8Array, updates: { lud16?: string }, relays: string[] = DEFAULT_RELAYS): Promise<string[]> {
  const pool = new SimplePool();
  const pubkey = getPublicKey(sk);

  try {
    // Fetch existing kind 0
    let existing: Record<string, unknown> = {};
    try {
      const events = await Promise.race([
        pool.querySync(relays, { kinds: [0], authors: [pubkey] }),
        new Promise<any[]>((resolve) => setTimeout(() => resolve([]), 5000)),
      ]);
      if (events.length > 0) {
        existing = JSON.parse(events[0].content);
      }
    } catch {}

    // Merge updates
    if (updates.lud16) existing.lud16 = updates.lud16;

    const event = finalizeEvent({
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify(existing),
    }, sk);

    const published = await publishToRelays(event, relays);
    return published;
  } finally {
    pool.close(relays);
  }
}

/**
 * Build and sign a kind 0 profile metadata event (for NIP-05 verification).
 * After claiming a NIP-05 name, publish this to relays so Nostr clients
 * (njump, Damus, Primal) can verify the identity.
 */
export function createKind0Event(sk: Uint8Array, profile: { name: string; about?: string; nip05?: string; picture?: string; lud16?: string; ownerPubkeyHex?: string; bot?: boolean }) {
  const tags: string[][] = [];
  if (profile.bot) tags.push(["bot"]);
  if (profile.ownerPubkeyHex) {
    tags.push(["p", profile.ownerPubkeyHex, "", "owner"]);
  }
  return finalizeEvent({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: JSON.stringify({
      name: profile.name,
      ...(profile.about && { about: profile.about }),
      ...(profile.nip05 && { nip05: profile.nip05 }),
      ...(profile.picture && { picture: profile.picture }),
      ...(profile.lud16 && { lud16: profile.lud16 }),
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
