// Subscription tier limits

export const FREE_LIMITS = {
  messagesPerDay: 10,
  sessionsPerMonth: 10,
  maxProjects: 2,
  maxDevices: 1,
  repairsPerMonth: 3,
  historyRetentionDays: 7,
};

export const PRO_LIMITS = {
  messagesPerDay: Infinity,
  sessionsPerMonth: Infinity,
  maxProjects: Infinity,
  maxDevices: Infinity,
  repairsPerMonth: Infinity,
  historyRetentionDays: Infinity,
  maxPhoneSessions: 1,
};

export const TEAM_LIMITS = {
  ...PRO_LIMITS,
};

export type SubscriptionTier = 'free' | 'pro' | 'team';

export type LimitType =
  | 'messages_daily'
  | 'sessions_monthly'
  | 'projects_max'
  | 'devices_max'
  | 'repairs_monthly'
  | 'phone_session';

export interface SubscriptionLimits {
  messagesPerDay: number;
  sessionsPerMonth: number;
  maxProjects: number;
  maxDevices: number;
  repairsPerMonth: number;
  historyRetentionDays: number;
  maxPhoneSessions?: number;
}

export function getLimitsForTier(tier: SubscriptionTier): SubscriptionLimits {
  switch (tier) {
    case 'pro':
      return PRO_LIMITS;
    case 'team':
      return TEAM_LIMITS;
    default:
      return FREE_LIMITS;
  }
}
