import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Achievement definitions
const ACHIEVEMENT_DEFINITIONS = [
  // Token Milestones
  {
    key: 'tokens_100k',
    name: 'Token Novice',
    description: 'Used 100,000 tokens total',
    category: 'TOKENS',
    iconName: 'Coins',
    tier: 'BRONZE',
    threshold: BigInt(100_000),
  },
  {
    key: 'tokens_1m',
    name: 'Token Apprentice',
    description: 'Used 1,000,000 tokens total',
    category: 'TOKENS',
    iconName: 'Coins',
    tier: 'SILVER',
    threshold: BigInt(1_000_000),
  },
  {
    key: 'tokens_10m',
    name: 'Token Master',
    description: 'Used 10,000,000 tokens total',
    category: 'TOKENS',
    iconName: 'Coins',
    tier: 'GOLD',
    threshold: BigInt(10_000_000),
  },
  {
    key: 'tokens_100m',
    name: 'Token Legend',
    description: 'Used 100,000,000 tokens total',
    category: 'TOKENS',
    iconName: 'Crown',
    tier: 'PLATINUM',
    threshold: BigInt(100_000_000),
  },
  // Session Milestones
  {
    key: 'sessions_10',
    name: 'Getting Started',
    description: 'Completed 10 sessions',
    category: 'SESSIONS',
    iconName: 'MessageSquare',
    tier: 'BRONZE',
    threshold: BigInt(10),
  },
  {
    key: 'sessions_100',
    name: 'Power User',
    description: 'Completed 100 sessions',
    category: 'SESSIONS',
    iconName: 'MessageSquare',
    tier: 'SILVER',
    threshold: BigInt(100),
  },
  {
    key: 'sessions_500',
    name: 'Session Master',
    description: 'Completed 500 sessions',
    category: 'SESSIONS',
    iconName: 'MessageSquare',
    tier: 'GOLD',
    threshold: BigInt(500),
  },
  // Engagement Milestones
  {
    key: 'days_active_7',
    name: 'Week Warrior',
    description: 'Active for 7 days',
    category: 'ENGAGEMENT',
    iconName: 'Calendar',
    tier: 'BRONZE',
    threshold: BigInt(7),
  },
  {
    key: 'days_active_30',
    name: 'Monthly Maven',
    description: 'Active for 30 days',
    category: 'ENGAGEMENT',
    iconName: 'Calendar',
    tier: 'SILVER',
    threshold: BigInt(30),
  },
  {
    key: 'streak_7',
    name: 'Hot Streak',
    description: '7-day activity streak',
    category: 'ENGAGEMENT',
    iconName: 'Flame',
    tier: 'SILVER',
    threshold: BigInt(7),
  },
  // Additional Creative Achievements
  {
    key: 'tokens_500m',
    name: 'Token Titan',
    description: 'Used 500,000,000 tokens - You are unstoppable!',
    category: 'TOKENS',
    iconName: 'Crown',
    tier: 'DIAMOND',
    threshold: BigInt(500_000_000),
  },
  {
    key: 'tokens_1b',
    name: 'Billion Token Club',
    description: 'Reached 1 billion tokens - Welcome to the elite',
    category: 'TOKENS',
    iconName: 'Trophy',
    tier: 'DIAMOND',
    threshold: BigInt(1_000_000_000),
  },
  {
    key: 'sessions_1000',
    name: 'Session Sage',
    description: 'Completed 1,000 sessions - A true Claude connoisseur',
    category: 'SESSIONS',
    iconName: 'Award',
    tier: 'PLATINUM',
    threshold: BigInt(1000),
  },
  {
    key: 'streak_30',
    name: 'Inferno',
    description: '30-day streak - Your dedication is on fire!',
    category: 'ENGAGEMENT',
    iconName: 'Flame',
    tier: 'GOLD',
    threshold: BigInt(30),
  },
  {
    key: 'streak_100',
    name: 'Eternal Flame',
    description: '100-day streak - Legendary commitment',
    category: 'ENGAGEMENT',
    iconName: 'Flame',
    tier: 'PLATINUM',
    threshold: BigInt(100),
  },
  {
    key: 'days_active_100',
    name: 'Century Coder',
    description: 'Active for 100 days total',
    category: 'ENGAGEMENT',
    iconName: 'Calendar',
    tier: 'GOLD',
    threshold: BigInt(100),
  },
  {
    key: 'days_active_365',
    name: 'Year of Claude',
    description: 'Active for 365 days - A full year of AI partnership',
    category: 'ENGAGEMENT',
    iconName: 'Star',
    tier: 'PLATINUM',
    threshold: BigInt(365),
  },
  {
    key: 'early_bird',
    name: 'Early Adopter',
    description: 'Joined ForkOff in 2026',
    category: 'SPECIAL',
    iconName: 'Award',
    tier: 'GOLD',
    threshold: BigInt(1),
  },
  {
    key: 'night_owl',
    name: 'Night Owl',
    description: 'Used Claude between midnight and 4 AM',
    category: 'SPECIAL',
    iconName: 'Star',
    tier: 'BRONZE',
    threshold: BigInt(1),
  },
  {
    key: 'speed_demon',
    name: 'Speed Demon',
    description: 'Sent 50 messages in a single session',
    category: 'SPECIAL',
    iconName: 'Award',
    tier: 'SILVER',
    threshold: BigInt(50),
  },
];

async function main() {
  console.log('Seeding achievements...');

  for (const def of ACHIEVEMENT_DEFINITIONS) {
    await prisma.achievement.upsert({
      where: { key: def.key },
      update: {
        name: def.name,
        description: def.description,
        category: def.category,
        iconName: def.iconName,
        tier: def.tier,
        threshold: def.threshold,
      },
      create: def,
    });
    console.log(`  - ${def.name} (${def.key})`);
  }

  console.log(`\nSeeded ${ACHIEVEMENT_DEFINITIONS.length} achievements successfully!`);

  // Seed subscription limits into app_config
  console.log('\nSeeding subscription limits...');
  await prisma.appConfig.upsert({
    where: { key: 'subscription-limits' },
    update: {},  // Don't overwrite if already exists (admin may have customized)
    create: {
      key: 'subscription-limits',
      value: {
        free: {
          messagesPerDay: 10,
          sessionsPerMonth: 10,
          maxProjects: 2,
          maxDevices: 1,
          repairsPerMonth: 3,
          historyRetentionDays: 7,
        },
        pro: {
          messagesPerDay: -1,
          sessionsPerMonth: -1,
          maxProjects: -1,
          maxDevices: -1,
          repairsPerMonth: -1,
          historyRetentionDays: -1,
          maxPhoneSessions: 1,
        },
      },
      description: 'Subscription tier limits (-1 = unlimited)',
    },
  });
  console.log('  - subscription-limits seeded');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
