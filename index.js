// index.js
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, REST, Routes, PermissionsBitField } = require('discord.js');
const Database = require('better-sqlite3');
const cron = require('cron');
const path = require('path');

// ---- Config ----
const DEFAULT_INACTIVITY_DAYS = 90;
const DEFAULT_MIN_VC_MINUTES = 0;
const MAX_PREVIEW = 50;

// ---- DB Setup (persistent path via DB_PATH or local file) ----
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
  },
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

  // 1) Clear GLOBAL commands to remove duplicates everywhere
  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    { body: [] }
  );
  console.log('✓ Cleared global commands');

  // 2) Register GUILD commands (instant in your server)
  if (process.env.GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log(`✓ Slash commands registered (guild: ${process.env.GUILD_ID})`);
  } else {
    // (fallback) If no GUILD_ID set, you can register globally instead
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('✓ Slash commands registered (global)');
  }
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

    // Permissions gate for admin actions
    if (['inactive-scan','inactive-kick','hydrate-history'].includes(interaction.commandName)) {
      if (!interaction.memberPermissions.has(PermissionsBitField.Flags.KickMembers)) {
        return interaction.reply({ content: 'You need **Kick Members** permission to use this.', ephemeral: true });
      }
    }

    if (interaction.commandName === 'inactive-scan') {
      const days = interaction.options.getInteger('days') ?? DEFAULT_INACTIVITY_DAYS;
      const minVcMinutes = interaction.options.getInteger('min_vc_minutes') ?? DEFAULT_MIN_VC_MINUTES;
      const excludeRole = interaction.options.getRole('exclude_role');

      await interaction.deferReply({ ephemeral: true });

      const list = await scanInactive(guild, days, minVcMinutes, excludeRole?.id ?? null);
      const sample = list.slice(0, MAX_PREVIEW).map(u => `<@${u.id}>`).join(', ');
      const more = list.length > MAX_PREVIEW ? ` + ${list.length - MAX_PREVIEW} more` : '';

      await interaction.editReply(
        `Inactive users in last **${days}** days (no msgs & no VC${minVcMinutes>0?` & < ${minVcMinutes} VC mins`:''}; exclude role: ${excludeRole ? excludeRole.name : 'none'}).\n` +
        `Total: **${list.length}**\nSample: ${sample || '_None_'}${more}\n\n` +
        `Use **/inactive-kick confirm:true** to remove them.`
      );
    }

    if (interaction.commandName === 'inactive-kick') {
      const confirm = (interaction.options.getString('confirm') || '').toLowerCase().trim();
      if (confirm !== 'true') {
        return interaction.reply({ content: 'Type `true` in the `confirm` option to proceed.', ephemeral: true });
      }

      const days = interaction.options.getInteger('days') ?? DEFAULT_INACTIVITY_DAYS;
      const minVcMinutes = interaction.options.getInteger('min_vc_minutes') ?? DEFAULT_MIN_VC_MINUTES;
      const excludeRole = interaction.options.getRole('exclude_role');

      await interaction.deferReply({ ephemeral: true });

      const list = await scanInactive(guild, days, minVcMinutes, excludeRole?.id ?? null);
      const ids = list.map(u => u.id);
      const kicked = await kickMembers(guild, ids);

      await interaction.editReply(`**Kicked ${kicked.length} / ${ids.length}** inactive members.`);
    }

    if (interaction.commandName === 'hydrate-history') {
      if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: 'You need **Manage Server** to run this.', ephemeral: true });
      }

      const days = interaction.options.getInteger('days') ?? 90;
      const perChannelLimitRaw = interaction.options.getInteger('per_channel_limit');
      const perChannelLimit = Math.min(Math.max(perChannelLimitRaw ?? 500, 50), 2000);
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

      await interaction.reply({ content: `Starting hydrate (≤${days}d, up to ${perChannelLimit} msgs/channel)…`, ephemeral: true });

      let channelsScanned = 0, messagesScanned = 0, usersTouched = 0;

      const textChannels = interaction.guild.channels.cache.filter((c) => {
        try { return c?.isTextBased?.() && c.viewable; } catch { return false; }
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
              scannedHere++; messagesScanned++;
              if (!m.author?.bot && m.createdTimestamp >= cutoff) {
                upsertMessage.run({ guild_id: interaction.guild.id, user_id: m.author.id, ts: m.createdTimestamp });
                usersTouched++;
              }
            }

            const last = batch.last();
            beforeId = last?.id;

            const oldestTs = batch.last()?.createdTimestamp ?? 0;
            if (oldestTs < cutoff) break;
          }
        } catch { /* skip channels we can’t read */ }
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

  } catch (e) {
    console.error('interactionCreate error:', e);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply('Something went wrong. Check permissions and try again.');
    } else {
      await interaction.reply({ content: 'Something went wrong. Check permissions and try again.', ephemeral: true });
    }
  }
});

// Optional: daily dry-run log at 04:00
new cron.CronJob('0 4 * * *', async () => {
  for (const [, guild] of client.guilds.cache) {
    try {
      const res = await scanInactive(guild, DEFAULT_INACTIVITY_DAYS, DEFAULT_MIN_VC_MINUTES, null);
      console.log(`[${guild.name}] Daily scan: ${res.length} candidates (dry run).`);
    } catch (e) {
      console.warn(`[${guild.id}] daily scan failed:`, e.message);
    }
  }
}, null, true);

// Use clientReady (future-proof for v15)
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error('Command registration failed:', e);
  }
});

client.login(process.env.DISCORD_TOKEN);