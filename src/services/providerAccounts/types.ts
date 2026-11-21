/** Shared account metadata, independent of chat sessions and provider execution. */
export interface ProviderIdentity {
  key: string | null;
  email: string | null;
  workspaceId: string | null;
  plan: string | null;
}

export interface UsageWindow {
  id: string;
  windowMinutes: number;
  usedPercent: number | null;
  /** Provider-reported Unix time in milliseconds; never inferred from the clock. */
  resetsAt: number | null;
}

export interface AccountUsage {
  windows: UsageWindow[];
  /** Authoritative available count, not the length of a possibly truncated detail list. */
  resetTokens: number | null;
  /** Sanitized inventory only: no redemption IDs or provider-supplied text. */
  resetCredits?: {
    availableCount: number;
    credits: Array<{
      kind: 'session' | 'weekly' | 'fable' | 'full' | 'unknown';
      count: number;
      expiresAt: number | null;
      /** Explicit null expiry means no expiry; missing/invalid expiry remains unknown. */
      expiryKnown: boolean;
    }>;
    detailsComplete: boolean;
    observedAt: number;
  } | null;
  resetCreditsError?: 'unavailable' | 'surface' | null;
  /** Native grant polling deadline; shared by the page, tray and reopened app. */
  resetCreditsNextCheckAt?: number | null;
  /** Grok's provider-reported allowance; not a Codex window or reset credit. */
  billing?: {
    usedPercent: number | null;
    period: string | null;
    resetsAt: string | null;
    prepaidBalanceCents: number | null;
  } | null;
}

export type AccountStatus = 'disconnected' | 'configured' | 'connected' | 'authRequired' | 'error' | 'duplicate';

export interface ProviderAccount {
  id: string;
  providerId: string;
  label: string;
  identity: ProviderIdentity | null;
  status: AccountStatus;
  duplicateOf: string | null;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  error: string | null;
  usage: AccountUsage | null;
}

export const CONSUMER_IDS = ['hermes-mother', 'hermes-vps', 'opencode-mother', 'opencode-vps'] as const;
export type ConsumerId = typeof CONSUMER_IDS[number];

/** A stored login is NOT proof that a running chat/request currently uses it. */
export interface ConsumerObservation {
  id: ConsumerId;
  providerId: string | null;
  identity: ProviderIdentity | null;
  evidence: 'runtime' | 'configured' | 'unavailable';
  observedAt: number | null;
  error: string | null;
}

export interface AccountLoginStart {
  accountId: string;
  loginId: string;
  /** Transient OAuth navigation URL, never persisted or written to logs. */
  authUrl: string;
  /** Vendor CLI owns its visible native login window, including fallback prompts. */
  flow?: 'browser' | 'cli';
}

export interface AccountLoginPoll {
  status: 'pending' | 'completed' | 'failed';
  account: ProviderAccount | null;
  error: string | null;
}

export interface ProviderAccountsClient {
  list(): Promise<ProviderAccount[]>;
  refresh(accountId?: string): Promise<ProviderAccount[]>;
  /** Transient owner input; native storage never returns the saved key. */
  connectApiKey(accountId: string, apiKey: string): Promise<ProviderAccount>;
  beginLogin(accountId: string): Promise<AccountLoginStart>;
  openLogin(accountId: string, loginId: string): Promise<void>;
  pollLogin(accountId: string, loginId: string): Promise<AccountLoginPoll>;
  cancelLogin(accountId: string, loginId: string): Promise<void>;
  openUsage(accountId: string): Promise<void>;
  connections(): Promise<ConsumerObservation[]>;
}

export interface ProviderCapabilities {
  id: string;
  name: string;
  accountLogin: boolean;
  usage: boolean;
  usageKind: 'windows' | 'billing' | 'publishedLimits' | 'unavailable';
  authKind?: 'apiKey';
  externalUsage: boolean;
}

/** Adding a monitor does not automatically enable a chat execution/billing route. */
export const ACCOUNT_PROVIDERS: readonly ProviderCapabilities[] = [
  { id: 'openai-codex', name: 'Codex', accountLogin: true, usage: true, usageKind: 'windows', externalUsage: false },
  { id: 'claude', name: 'Claude', accountLogin: true, usage: true, usageKind: 'windows', externalUsage: true },
  { id: 'grok', name: 'Grok', accountLogin: true, usage: true, usageKind: 'billing', externalUsage: false },
  { id: 'commandCode', name: 'CommandCode', accountLogin: true, usage: false, usageKind: 'unavailable', externalUsage: true },
  { id: 'inception', name: 'Inception Labs', accountLogin: false, authKind: 'apiKey', usage: false, usageKind: 'publishedLimits', externalUsage: true },
];
