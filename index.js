// index.js
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, REST, Routes, PermissionsBitField } = require('discord.js');
const Database = require('better-sqlite3');
const path = require('path');
const cron = require('cron');

// ---- Config ----
const DEFAULT_INACTIVITY_DAYS = 90;
const DEFAULT_MIN_VC_MINUTES = 0;
const MAX_SCAN_LIST = 100;

// ---- DB Setup ----
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'activity.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS user_activity (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    last_message_at INTEGER,
    last_vc_at INTEGER,
    vc_seconds_total INTEGER DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  )
`);

const upsertMessage = db.prepare(`
  INSERT INTO user_activity (guild_id, user_id, last_message_at)
  VALUES (@guild_id, @user_id, @ts)
  ON CONFLICT(guild_id, user_id)
  DO UPDATE SET last_message_at = excluded.last_message_at
`);

const upsertVcJoin = db.prepare(`
  INSERT INTO user_activity (guild_id, user_id, last_vc_at)
  VALUES (@guild_id, @user_id, @ts)
  ON CONFLICT(guild_id, user_id)
  DO UPDATE SET last_vc_at = excluded.last_vc_at
`);

const addVcSeconds = db.prepare(`
  INSERT INTO user_activity (guild_id, user_id, vc_seconds_total, last_vc_at)
  VALUES (@guild_id, @user_id, @delta, @ts)
  ON CONFLICT(guild_id, user_id)
  DO UPDATE SET
    vc_seconds_total = COALESCE(user_activity.vc_seconds_total, 0) + excluded.vc_seconds_total,
    last_vc_at = MAX(COALESCE(user_activity.last_vc_at, 0), excluded.last_vc_at)
`);

function nowMs() { return Date.now(); }

// ---- Track active VC sessions in memory ----
const activeVcSessions = new Map(); // key: `${guildId}:${userId}` -> joinTimestampMs

// ---- Client ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel, Partials.GuildMember, Partials.User],
});

// ---- Slash Commands ----
const commands = [
  {
    name: 'inactive-scan',
    description: 'List members who have been inactive (no messages & no VC) for N days.',
    options: [
      { name: 'days', description: 'Number of days (default 90).', type: 4, required: false },
      { name: 'min_vc_minutes', description: 'Count as active if VC minutes >= this (default 0).', type: 4, required: false },
      { name: 'exclude_role', description: 'Exclude anyone with this role.', type: 8, required: false }
    ]
  },
  {
    name: 'inactive-kick',
    description: 'Kick members who have been inactive for N days (requires confirm).',
    options: [
      { name: 'confirm', description: 'Type TRUE to actually kick.', type: 3, required: true },
      { name: 'days', description: 'Number of days (default 90).', type: 4, required: false },
      { name: 'min_vc_minutes', description: 'Count as active if VC minutes >= this (default 0).', type: 4, required: false },
      { name: 'exclude_role', description: 'Exclude anyone with this role.', type: 8, required: false }
    ]
  }
{
  name: 'hydrate-history',
  description: 'One-time backfill: scan recent messages and update last_message_at.',
  options: [
    { name: 'days', description: 'How many days back (default 90).', type: 4, required: false },
    { name: 'per_channel_limit', description: 'Max messages per channel to scan (default 500).', type: 4, required: false }
  ]
}
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  console.log('✓ Slash commands registered');
}

// ---- Helpers ----
function msFromDays(days) { return days * 24 * 60 * 60 * 1000; }

function memberIsProtected(member) {
  if (!member) return true;
  if (member.user.bot) return true;
  if (member.id === member.guild.ownerId) return true;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  return false;
}

async function fetchAllMembers(guild) {
  await guild.members.fetch();
  return guild.members.cache;
}

function getActivityRow(guildId, userId) {
  return db.prepare(`
    SELECT last_message_at, last_vc_at, vc_seconds_total
    FROM user_activity
    WHERE guild_id = ? AND user_id = ?
  `).get(guildId, userId) || { last_message_at: null, last_vc_at: null, vc_seconds_total: 0 };
}

function isInactiveByThreshold(row, cutoffMs, minVcSeconds) {
  const lm = row.last_message_at ?? 0;
  const lv = row.last_vc_at ?? 0;
  const hasRecentMessage = lm >= cutoffMs;
  const hasRecentVC = lv >= cutoffMs;
  const vcEnough = (minVcSeconds > 0) && ((row.vc_seconds_total || 0) >= minVcSeconds);
  return !hasRecentMessage && !hasRecentVC && !vcEnough;
}

async function scanInactive(guild, days = DEFAULT_INACTIVITY_DAYS, minVcMinutes = DEFAULT_MIN_VC_MINUTES, excludeRoleId = null) {
  const cutoff = nowMs() - msFromDays(days);
  const minVcSeconds = Math.max(0, minVcMinutes) * 60;

  const members = await fetchAllMembers(guild);
  const result = [];

  for (const [, member] of members) {
    if (memberIsProtected(member)) continue;
    if (excludeRoleId && member.roles.cache.has(excludeRoleId)) continue;

    const row = getActivityRow(guild.id, member.id);
    if (isInactiveByThreshold(row, cutoff, minVcSeconds)) {
      result.push({ id: member.id, tag: `${member.user.username}#${member.user.discriminator}` });
    }
  }
  return result;
}

async function kickMembers(guild, userIds) {
  const kicked = [];
  for (const userId of userIds) {
    const m = await guild.members.fetch(userId).catch(() => null);
    if (!m || memberIsProtected(m)) continue;
    try {
      await m.kick('Inactive (no messages & no VC in threshold)');
      kicked.push(userId);
    } catch (e) {
      console.warn(`Failed to kick ${userId}:`, e.message);
    }
  }
  return kicked;
}

// ---- Events ----
client.on('messageCreate', (msg) => {
  if (!msg.guild || msg.author.bot) return;
  try {
    upsertMessage.run({ guild_id: msg.guild.id, user_id: msg.author.id, ts: nowMs() });
  } catch (e) {
    console.error('messageCreate DB error:', e);
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  const guildId = (newState.guild || oldState.guild).id;
  const userId = newState.id;
  const key = `${guildId}:${userId}`;
  const now = nowMs();

  const wasIn = !!oldState.channelId;
  const isIn = !!newState.channelId;

  try {
    if (!wasIn && isIn) {
      activeVcSessions.set(key, now);
      upsertVcJoin.run({ guild_id: guildId, user_id: userId, ts: now });
    } else if (wasIn && !isIn) {
      const start = activeVcSessions.get(key);
      if (start) {
        const delta = Math.max(0, Math.floor((now - start) / 1000));
        addVcSeconds.run({ guild_id: guildId, user_id: userId, delta, ts: now });
        activeVcSessions.delete(key);
      }
    } else if (wasIn && isIn && oldState.channelId !== newState.channelId) {
      const start = activeVcSessions.get(key);
      if (start) {
        const delta = Math.max(0, Math.floor((now - start) / 1000));
        addVcSeconds.run({ guild_id: guildId, user_id: userId, delta, ts: now });
      }
      activeVcSessions.set(key, now);
      upsertVcJoin.run({ guild_id: guildId, user_id: userId, ts: now });
    }
  } catch (e) {
    console.error('voiceStateUpdate DB error:', e);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: 'Use this in a server.', ephemeral: true });

    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.KickMembers)) {
      return interaction.reply({ content: 'You need **Kick Members** permission to use this.', ephemeral: true });
    }

    if (interaction.commandName === 'inactive-scan') {
      const days = interaction.options.getInteger('days') ?? DEFAULT_INACTIVITY_DAYS;
      const minVcMinutes = interaction.options.getInteger('min_vc_minutes') ?? DEFAULT_MIN_VC_MINUTES;
      const excludeRole = interaction.options.getRole('exclude_role');

      await interaction.deferReply({ ephemeral: true });

      const list = await scanInactive(guild, days, minVcMinutes, excludeRole?.id ?? null);
      let preview = list.slice(0, 50).map(u => `<@${u.id}>`).join(', ');
let more = list.length > 50 ? ` + ${list.length - 50} more` : '';

await interaction.editReply(
  `Inactive users: ${list.length} total.\n` +
  `Sample: ${preview}${more}\n\n` +
  `Run /inactive-kick confirm:true to kick them.`
);

    }

    if (interaction.commandName === 'inactive-kick') {
      const days = interaction.options.getInteger('days') ?? DEFAULT_INACTIVITY_DAYS;
      const minVcMinutes = interaction.options.getInteger('min_vc_minutes') ?? DEFAULT_MIN_VC_MINUTES;
      const excludeRole = interaction.options.getRole('exclude_role');
      const confirm = (interaction.options.getString('confirm') || '').toLowerCase().trim();

      if (confirm !== 'true') {
        return interaction.reply({ content: 'Type `true` in the `confirm` option to proceed.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      const list = await scanInactive(guild, days, minVcMinutes, excludeRole?.id ?? null);
      const ids = list.map(u => u.id);
      const kicked = await kickMembers(guild, ids);

      await interaction.editReply(`**Kicked ${kicked.length} / ${ids.length}** inactive members (no messages & no VC in **${days}** days, VC threshold **${minVcMinutes}** mins).`);
    }
  } catch (e) {
    console.error('interactionCreate error:', e);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply('Something went wrong. Check bot permissions and try again.');
    } else {
      await interaction.reply({ content: 'Something went wrong. Check bot permissions and try again.', ephemeral: true });
    }
  }
if (interaction.commandName === 'hydrate-history') {
  // Only trusted users should run this once
  if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
    return interaction.reply({ content: 'You need **Manage Server** to run this.', ephemeral: true });
  }

  const days = interaction.options.getInteger('days') ?? 90;
  const perChannelLimitRaw = interaction.options.getInteger('per_channel_limit');
  // clamp between 50 and 2000 to be safe with rate limits
  const perChannelLimit = Math.min(Math.max(perChannelLimitRaw ?? 500, 50), 2000);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  await interaction.reply({ content: `Starting hydrate (≤${days} days, up to ${perChannelLimit} msgs/channel)…`, ephemeral: true });

  let channelsScanned = 0;
  let messagesScanned = 0;
  let usersTouched = 0;

  // Get all text-based channels the bot can read
  const textChannels = interaction.guild.channels.cache.filter((c) => {
    try {
      return c?.isTextBased?.() && c.viewable; // viewable respects permissions
    } catch {
      return false;
    }
  });

  for (const [, channel] of textChannels) {
    channelsScanned++;
    let scannedHere = 0;
    let beforeId = undefined;

    try {
      while (scannedHere < perChannelLimit) {
        const left = perChannelLimit - scannedHere;
        const batch = await channel.messages.fetch({ limit: Math.min(100, left), before: beforeId }).catch(() => null);
        if (!batch || batch.size === 0) break;

        for (const [, m] of batch) {
          scannedHere++;
          messagesScanned++;
          if (!m.author?.bot && m.createdTimestamp >= cutoff) {
            // Update last_message_at for this author
            upsertMessage.run({
              guild_id: interaction.guild.id,
              user_id: m.author.id,
              ts: m.createdTimestamp
            });
            usersTouched++;
          }
        }

        const last = batch.last();
        beforeId = last?.id;

        // If the oldest message in this batch is older than our window, stop this channel
        const oldestTs = batch.last()?.createdTimestamp ?? 0;
        if (oldestTs < cutoff) break;
      }
    } catch {
      // Ignore channels we cannot read
    }
  }

  await interaction.followUp({
    content:
      `Hydrate complete.\n` +
      `• Channels scanned: ${channelsScanned}\n` +
      `• Messages scanned: ${messagesScanned}\n` +
      `• Users updated: ~${usersTouched}`,
    ephemeral: true
  });
}
});

// Use clientReady (v14 supports it; avoids deprecation warning ahead of v15)
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error('Command registration failed:', e);
  }
});

client.login(process.env.DISCORD_TOKEN);
