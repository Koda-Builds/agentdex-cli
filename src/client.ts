/**
 * AgentdexClient — SDK for interacting with the agentdex API
 */

export interface AgentdexConfig {
  baseUrl?: string;
  apiKey?: string;
}

export interface RegisterOptions {
  name: string;
  description?: string;
  capabilities?: string[];
  framework?: string;
  model?: string;
  website?: string;
  avatar?: string;
  lightning?: string;
  human?: string;
  status?: string;
  messagingPolicy?: string;
  messagingMinTrust?: number;
  messagingFee?: number;
}

export interface VerifyResult {
  registered: boolean;
  hasNostr: boolean;
  hasAgentdex: boolean;
  trustScore: number;
  name: string | null;
  npub: string | null;
  capabilities: string[];
  messagingPolicy: string | null;
}

export interface ClaimResult {
  // Free/successful claim
  claimed?: boolean;
  nip05?: string;
  agent?: { id: string; name: string; description?: string; avatarUrl?: string; nip05Name: string; tier: string };
  next_steps?: Record<string, unknown>;
  // Paid claim (402)
  status?: string;
  invoice?: string;
  payment_hash?: string;
  amount_sats?: number;
  expires_at?: string;
}

export interface ClaimStatus {
  paid: boolean;
  name?: string;
  nip05?: string;
}

export interface SearchOptions {
  q?: string;
  capability?: string;
  framework?: string;
  status?: string;
  sourceFilter?: string;
  sort?: string;
  limit?: number;
}

export class AgentdexClient {
  private baseUrl: string;
  private apiKey?: string;

  constructor(config: AgentdexConfig = {}) {
    this.baseUrl = (config.baseUrl || process.env.AGENTDEX_URL || 'https://agentdex.id').replace(/\/$/, '');
    this.apiKey = config.apiKey || process.env.AGENTDEX_API_KEY;
  }

  private async fetch(path: string, options: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return fetch(`${this.baseUrl}${path}`, { ...options, headers });
  }

  async verify(pubkeyOrNpub: string): Promise<VerifyResult> {
    const param = pubkeyOrNpub.startsWith('npub') ? 'npub' : 'pubkey';
    const res = await this.fetch(`/api/v1/agents/verify?${param}=${encodeURIComponent(pubkeyOrNpub)}`);
    return res.json();
  }

  async register(event: object): Promise<any> {
    const res = await this.fetch('/api/v1/agents/register', {
      method: 'POST',
      body: JSON.stringify({ event }),
    });
    if (!res.ok && res.status !== 402) {
      const err = await res.json();
      throw new Error(err.error || 'Registration failed');
    }
    return res.json();
  }

  async registerStatus(paymentHash: string): Promise<{ paid: boolean; status?: string; agent?: object }> {
    const res = await this.fetch(`/api/v1/agents/register/status?payment_hash=${encodeURIComponent(paymentHash)}`);
    const data = await res.json();
    // API returns { status: "paid" | "completed" | "pending" | "expired" }
    // Normalize to { paid: true/false } for CLI consumption
    data.paid = data.status === 'paid' || data.status === 'completed';
    return data;
  }

  async claim(name: string, event: object): Promise<ClaimResult> {
    const res = await this.fetch('/api/v1/agents/claim', {
      method: 'POST',
      body: JSON.stringify({ name, event }),
    });
    if (!res.ok && res.status !== 402) {
      const err = await res.json();
      throw new Error(err.error || 'Claim failed');
    }
    return res.json();
  }

  async claimStatus(paymentHash: string): Promise<ClaimStatus> {
    const res = await this.fetch(`/api/v1/agents/claim/status?payment_hash=${encodeURIComponent(paymentHash)}`);
    const data = await res.json();
    // API returns { status: "paid" | "completed" | "pending" | "expired" }
    // Normalize to { paid: true/false } for CLI consumption
    data.paid = data.status === 'paid' || data.status === 'completed';
    return data;
  }

  async search(options: SearchOptions = {}): Promise<object[]> {
    const params = new URLSearchParams();
    if (options.q) params.set('q', options.q);
    if (options.capability) params.set('capability', options.capability);
    if (options.framework) params.set('framework', options.framework);
    if (options.status) params.set('status', options.status);
    if (options.sourceFilter) params.set('source_filter', options.sourceFilter);
    if (options.sort) params.set('sort', options.sort);
    if (options.limit) params.set('limit', String(options.limit));
    const res = await this.fetch(`/api/v1/agents?${params}`);
    return res.json();
  }
}
