export type MatOSChatGPTSubscriptionState =
  | 'unavailable'
  | 'not-connected'
  | 'starting-login'
  | 'awaiting-user'
  | 'authorized'
  | 'starting-proxy'
  | 'connected'
  | 'proxy-stopped'
  | 'error';

export interface MatOSChatGPTSubscriptionStatus {
  available: boolean;
  state: MatOSChatGPTSubscriptionState;
  authenticated: boolean;
  pendingAttempt: boolean;
  providerActive: boolean;
  proxyRunning: boolean;
  model?: string;
  verificationUrl?: string;
  userCode?: string;
  message: string;
}
