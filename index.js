// index.js
require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
  MessageFlags
} = require('discord.js');
const Database = require('better-sqlite3');
const cron = require('cron');
const path = require('path');

// ---- Config ----
const DEFAULT_INACTIVITY_DAYS = 90;
const DEFAULT_MIN_VC_MINUTES = 0; // minutes of VC time that count as "active" within window
const MAX_PREVIEW = 50;

// ---- DB Setup (persistent path via DB_PATH or local file) ----
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'activity.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// main activity table
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

// guild settings: include modlog + healthlog (+ chat)
db.exec(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    modlog_channel_id TEXT,
    healthlog_channel_id TEXT,
    chat_channel_id TEXT
  )
`);
try { db.exec(`ALTER TABLE guild_settings ADD COLUMN healthlog_channel_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE guild_settings ADD COLUMN chat_channel_id TEXT`); } catch {}

// activity upserts
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

// guild setting statements
const setModlog = db.prepare(`
  INSERT INTO guild_settings (guild_id, modlog_channel_id)
  VALUES (?, ?)
  ON CONFLICT(guild_id) DO UPDATE SET modlog_channel_id = excluded.modlog_channel_id
`);

const setHealthlog = db.prepare(`
  INSERT INTO guild_settings (guild_id, healthlog_channel_id)
  VALUES (?, ?)
  ON CONFLICT(guild_id) DO UPDATE SET healthlog_channel_id = excluded.healthlog_channel_id
`);

const setChatChannel = db.prepare(`
  INSERT INTO guild_settings (guild_id, chat_channel_id)
  VALUES (?, ?)
  ON CONFLICT(guild_id) DO UPDATE SET chat_channel_id = excluded.chat_channel_id
`);

const getSettings = db.prepare(`
  SELECT modlog_channel_id, healthlog_channel_id, chat_channel_id
  FROM guild_settings WHERE guild_id = ?
`);

// ---- Activity counting for Health Snapshot (DB-driven) ----
const countActiveUnionSince = db.prepare(`
  SELECT COUNT(*) AS n
  FROM user_activity
  WHERE guild_id = ? AND (last_message_at >= ? OR last_vc_at >= ?)
`);

const countTextSendersSince = db.prepare(`
  SELECT COUNT(*) AS n
  FROM user_activity
  WHERE guild_id = ? AND last_message_at >= ?
`);

const countVcJoinsSince = db.prepare(`
  SELECT COUNT(*) AS n
  FROM user_activity
  WHERE guild_id = ? AND last_vc_at >= ?
`);

// ---- Utils ----
function nowMs() { return Date.now(); }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function msFromDays(days) { return days * 24 * 60 * 60 * 1000; }

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
    description: 'Backfill recent messages into last_message_at.',
    options: [
      { name: 'days', description: 'How many days back (default 90).', type: 4, required: false },
      { name: 'per_channel_limit', description: 'Max messages per channel (default 500).', type: 4, required: false },
      {
        name: 'channel',
        description: 'Only scan this channel (supports voice channels with text).',
        type: 7,
        required: false,
        channel_types: [
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.GuildVoice,
          ChannelType.PublicThread,
          ChannelType.PrivateThread,
          ChannelType.AnnouncementThread,
          ChannelType.GuildForum
        ]
      },
      { name: 'include_threads', description: 'Also scan active threads of the channel.', type: 5, required: false }
    ]
  },
  {
    name: 'peek-channel',
    description: 'Show the last few messages in a channel (for debugging).',
    options: [
      { name: 'channel', description: 'Channel to inspect', type: 7, required: true },
      { name: 'limit', description: 'How many messages (default 10, max 25).', type: 4, required: false }
    ]
  },
  {
    name: 'debug-channel',
    description: 'Inspect a channel: type, isTextBased, permissions.',
    options: [{ name: 'channel', description: 'Channel to inspect', type: 7, required: true }]
  },
  {
    name: 'debug-activity',
    description: 'Show stored activity for a user.',
    options: [{ name: 'user', description: 'User to inspect', type: 6, required: true }]
  },
  {
    name: 'modlog-set',
    description: 'Set the channel where daily inactivity reports are posted.',
    options: [{ name: 'channel', description: 'Channel to use for mod logs', type: 7, required: true }]
  },
  {
    name: 'healthlog-set',
    description: 'Set the channel where the daily Server Health Snapshot is posted.',
    options: [{ name: 'channel', description: 'Channel to use for health snapshots', type: 7, required: true }]
  },
  {
    name: 'chat-set',
    description: 'Set the general #chat channel (fallback target).',
    options: [{ name: 'channel', description: 'Channel to set as chat', type: 7, required: true }]
  },
  {
    name: 'health-snapshot',
    description: 'Manually run the Server Health Snapshot now.',
    options: [
      { name: 'channel', description: 'Override channel to post in', type: 7, required: false },
      { name: 'dry_run', description: 'If true, show preview only (no post).', type: 5, required: false }
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
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('✓ Slash commands registered (global)');
  }
}

// ---- Helpers ----
function memberIsProtected(member) {
  if (!member) return true;
  if (member.user.bot) return true;
  if (member.id === member.guild.ownerId) return true;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  return false;
}

async function fetchAllMembers(guild) {
  try {
    await guild.members.fetch({ time: 120000 });
  } catch (e) {
    console.warn(`[${guild.id}] members.fetch timeout/failure; using cache only: ${e?.message || e}`);
  }
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

function getSettingsRow(guild) {
  return getSettings.get(guild.id) || {};
}

async function getTextChannelByName(guild, nameLower) {
  const match = guild.channels.cache.find(ch =>
    ch?.isTextBased?.() && ch?.viewable && ch.name?.toLowerCase() === nameLower
  );
  return match || null;
}

async function getModLogChannel(guild) {
  const s = getSettingsRow(guild);
  const idFromDb = s.modlog_channel_id;
  const idFromEnv = process.env.MOD_LOG_CHANNEL_ID || null;
  const channelId = idFromDb || idFromEnv;
  if (channelId) {
    try {
      const ch = await guild.channels.fetch(channelId);
      if (ch?.isTextBased?.() && ch.viewable) return ch;
    } catch {}
  }
  return null;
}

async function getHealthLogChannel(guild) {
  const s = getSettingsRow(guild);
  const idFromDb = s.healthlog_channel_id || s.chat_channel_id || null;
  const idFromEnv = process.env.HEALTH_LOG_CHANNEL_ID || process.env.CHAT_CHANNEL_ID || null;

  if (idFromDb || idFromEnv) {
    const pick = idFromDb || idFromEnv;
    try {
      const ch = await guild.channels.fetch(pick);
      if (ch?.isTextBased?.() && ch.viewable) return ch;
    } catch {}
  }
  // fallback by name: "chat"
  const byName = await getTextChannelByName(guild, 'chat');
  return byName;
}

// ---- Health Snapshot helpers ----
async function buildHealthSnapshotForGuild(guild) {
  const since = nowMs() - (24 * 60 * 60 * 1000);
  const members = await fetchAllMembers(guild);

  let textSenders = 0;
  let vcJoins = 0;

  for (const [, m] of members) {
    const row = getActivityRow(guild.id, m.id);
    if (row.last_message_at && row.last_message_at >= since) textSenders++;
    if (row.last_vc_at && row.last_vc_at >= since) vcJoins++;
  }

  const activeUsers = textSenders;
  const needsBoost = activeUsers < 15;

  // no embed — just text now
  const message = 
    `ahoy you sea dwelling studiers! let's see who sailed the oceanside seas today 🏴‍☠️\n\n` +
    `Active users last 24h: **${activeUsers}**\n` +
    `Text senders: **${textSenders}**\n` +
    `VC joins: **${vcJoins}**`;

  return { message };
}

async function postHealthSnapshot(guild, channel) {
  const { message } = await buildHealthSnapshotForGuild(guild);
  await channel.send(message);
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
      // joined VC
      activeVcSessions.set(key, now);
      upsertVcJoin.run({ guild_id: guildId, user_id: userId, ts: now });
    } else if (wasIn && !isIn) {
      // left VC
      const start = activeVcSessions.get(key);
      if (start) {
        const delta = Math.max(0, Math.floor((now - start) / 1000));
        addVcSeconds.run({ guild_id: guildId, user_id: userId, delta, ts: now });
        activeVcSessions.delete(key);
      }
    } else if (wasIn && isIn && oldState.channelId !== newState.channelId) {
      // moved VC
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
    if (!guild) {
      return interaction.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
    }

    // gatekeeper: mod perms for these commands
    if ([
      'inactive-scan', 'inactive-kick',
      'hydrate-history', 'debug-activity',
      'modlog-set', 'healthlog-set', 'chat-set',
      'health-snapshot', 'peek-channel', 'debug-channel'
    ].includes(interaction.commandName)) {
      if (!interaction.memberPermissions.has(PermissionsBitField.Flags.KickMembers)) {
        return interaction.reply({ content: 'You need **Kick Members** permission to use this.', flags: MessageFlags.Ephemeral });
      }
    }

    // /inactive-scan
    if (interaction.commandName === 'inactive-scan') {
      const days = interaction.options.getInteger('days') ?? DEFAULT_INACTIVITY_DAYS;
      const minVcMinutes = interaction.options.getInteger('min_vc_minutes') ?? DEFAULT_MIN_VC_MINUTES;
      const excludeRole = interaction.options.getRole('exclude_role');

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const list = await scanInactive(guild, days, minVcMinutes, excludeRole?.id ?? null);
      const sample = list.slice(0, MAX_PREVIEW).map(u => `<@${u.id}>`).join(', ');
      const more = list.length > MAX_PREVIEW ? ` + ${list.length - MAX_PREVIEW} more` : '';

      await interaction.editReply(
        `Inactive users in last **${days}** days (no msgs & no VC${minVcMinutes>0?` & < ${minVcMinutes} VC mins`:''}; exclude role: ${excludeRole ? excludeRole.name : 'none'}).\n` +
        `Total: **${list.length}**\nSample: ${sample || '_None_'}${more}\n\n` +
        `Use **/inactive-kick confirm:true** to remove them.`
      );
      return;
    }

    // /inactive-kick
    if (interaction.commandName === 'inactive-kick') {
      const confirm = (interaction.options.getString('confirm') || '').toLowerCase().trim();
      if (confirm !== 'true') {
        return interaction.reply({ content: 'Type `true` in the `confirm` option to proceed.', flags: MessageFlags.Ephemeral });
      }

      const days = interaction.options.getInteger('days') ?? DEFAULT_INACTIVITY_DAYS;
      const minVcMinutes = interaction.options.getInteger('min_vc_minutes') ?? DEFAULT_MIN_VC_MINUTES;
      const excludeRole = interaction.options.getRole('exclude_role');

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const list = await scanInactive(guild, days, minVcMinutes, excludeRole?.id ?? null);
      const ids = list.map(u => u.id);
      const kicked = await kickMembers(guild, ids);

      await interaction.editReply(`**Kicked ${kicked.length} / ${ids.length}** inactive members.`);
      return;
    }

    // /hydrate-history
    if (interaction.commandName === 'hydrate-history') {
      if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: 'You need **Manage Server** to run this.', flags: MessageFlags.Ephemeral });
      }

      const days = interaction.options.getInteger('days') ?? 90;
      const pclRaw = interaction.options.getInteger('per_channel_limit') ?? 500;
      const perChannelLimit = Math.min(Math.max(pclRaw, 200), 20000);
      const targetChannel = interaction.options.getChannel('channel');
      const includeThreads = interaction.options.getBoolean('include_threads') ?? false;

      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

      await interaction.reply({
        content: `Hydrate starting (≤${days}d, up to ${perChannelLimit} msgs/channel)` +
                 (targetChannel ? ` on ${targetChannel}` : ` on all visible text channels`) +
                 (includeThreads ? ` + threads` : ``) + `…`,
        flags: MessageFlags.Ephemeral
      });

      let channelsScanned = 0, messagesScanned = 0, usersTouched = 0;

      const me = interaction.guild.members.me;
      function canScan(ch) {
        const isEligibleType = ch?.isTextBased?.() || ch?.type === ChannelType.GuildVoice;
        const perms = ch.permissionsFor?.(me);
        const canView = !!perms && perms.has(PermissionsBitField.Flags.ViewChannel);
        const canRead = !!perms && perms.has(PermissionsBitField.Flags.ReadMessageHistory);
        return !!ch && isEligibleType && ch.viewable && canView && canRead;
      }

      const baseChannels = targetChannel
        ? [targetChannel]
        : Array.from(interaction.guild.channels.cache.values()).filter(canScan);

      async function addActiveThreadsOf(channel, arr){
        try {
          const active = await channel.threads?.fetchActive();
          const archived = await channel.threads?.fetchArchived?.();
          if (active?.threads) arr.push(...active.threads.filter(t => t.viewable).map(t => t));
          if (archived?.threads) arr.push(...archived.threads.filter(t => t.viewable).map(t => t));
        } catch {/* ignore */}
      }

      const channelsToScan = [];
      for (const ch of baseChannels) {
        if (ch.isTextBased?.() && ch.viewable) {
          channelsToScan.push(ch);
          if (includeThreads && 'threads' in ch) {
            await addActiveThreadsOf(ch, channelsToScan);
          }
        }
      }

      async function scanChannel(channel){
        channelsScanned++;

        if (!channel || !channel.messages || !channel.messages.fetch) return;

        let scannedHere = 0;
        let beforeId = undefined;

        while (scannedHere < perChannelLimit) {
          const left = perChannelLimit - scannedHere;
          let batch;
          try {
            batch = await channel.messages.fetch({ limit: Math.min(100, left), before: beforeId });
          } catch {
            break;
          }
          if (!batch || batch.size === 0) break;

          for (const [, m] of batch) {
            scannedHere++;
            messagesScanned++;
            if (!m.author?.bot && m.createdTimestamp >= cutoff) {
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

          const oldestTs = batch.last()?.createdTimestamp ?? 0;
          if (oldestTs < cutoff) break;

          await sleep(350);
        }
      }

      for (const ch of channelsToScan) {
        try { await scanChannel(ch); } catch {/* skip problematic channel */ }
      }

      await interaction.followUp({
        content:
          `Hydrate complete.\n` +
          `• Channels scanned: ${channelsScanned}\n` +
          `• Messages scanned: ${messagesScanned}\n` +
          `• Users updated: ~${usersTouched}\n` +
          (targetChannel ? `• Channel: ${targetChannel}` : ''),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // /peek-channel
    if (interaction.commandName === 'peek-channel') {
      const ch = interaction.options.getChannel('channel');
      const lim = Math.min(Math.max(interaction.options.getInteger('limit') ?? 10, 1), 25);

      const me = interaction.guild.members.me;
      const perms = ch.permissionsFor?.(me);
      const canView = !!perms && perms.has(PermissionsBitField.Flags.ViewChannel);
      const canRead = !!perms && perms.has(PermissionsBitField.Flags.ReadMessageHistory);

      if (!canView || !canRead || !ch.messages?.fetch) {
        return interaction.reply({ content: 'I cannot read messages in that channel.', flags: MessageFlags.Ephemeral });
      }

      let batch;
      try {
        batch = await ch.messages.fetch({ limit: lim });
      } catch (e) {
        return interaction.reply({ content: `Fetch failed: ${e.message}`, flags: MessageFlags.Ephemeral });
      }
      if (!batch || batch.size === 0) {
        return interaction.reply({ content: 'No messages returned.', flags: MessageFlags.Ephemeral });
      }

      const lines = [];
      let i = 0;
      for (const [, m] of batch) {
        if (i++ >= lim) break;
        const when = new Date(m.createdTimestamp).toISOString();
        const who = m.author?.bot ? `(bot) ${m.author.tag}` : m.author?.tag;
        const text = (m.content || '[embed/attachment]').slice(0, 60).replace(/\n/g, ' ');
        lines.push(`• ${when} — ${who}: ${text}`);
      }

      await interaction.reply({
        content: `Last ${lines.length} messages in ${ch}:\n` + lines.join('\n'),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // /debug-channel
    if (interaction.commandName === 'debug-channel') {
      const ch = interaction.options.getChannel('channel');
      const me = interaction.guild.members.me;
      const perms = ch.permissionsFor?.(me) ?? new PermissionsBitField(0);
      const canView = perms.has(PermissionsBitField.Flags.ViewChannel);
      const canReadHist = perms.has(PermissionsBitField.Flags.ReadMessageHistory);
      const canSend = perms.has(PermissionsBitField.Flags.SendMessages);
      const isTextBased = ch.isTextBased?.() ? 'yes' : 'no';
      await interaction.reply({
        content:
          `Channel: ${ch} (id: ${ch.id})\n` +
          `type: ${ch.type}\n` +
          `isTextBased(): ${isTextBased}\n` +
          `viewable: ${ch.viewable ? 'yes' : 'no'}\n` +
          `perms(ViewChannel): ${canView}\n` +
          `perms(ReadMessageHistory): ${canReadHist}\n` +
          `perms(SendMessages): ${canSend}`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // /debug-activity
    if (interaction.commandName === 'debug-activity') {
      const u = interaction.options.getUser('user');
      const row = getActivityRow(interaction.guild.id, u.id);
      const toDate = ts => ts ? new Date(ts).toISOString() : 'none';
      await interaction.reply({
        content:
          `User: <@${u.id}>\n` +
          `last_message_at: ${toDate(row.last_message_at)}\n` +
          `last_vc_at:     ${toDate(row.last_vc_at)}\n` +
          `vc_seconds_total: ${row.vc_seconds_total || 0}`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // /modlog-set
    if (interaction.commandName === 'modlog-set') {
      if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: 'You need **Manage Server** to run this.', flags: MessageFlags.Ephemeral });
      }
      const channel = interaction.options.getChannel('channel');
      if (!channel?.isTextBased?.() || !channel.viewable) {
        return interaction.reply({ content: 'Please choose a text channel I can see.', flags: MessageFlags.Ephemeral });
      }
      try {
        setModlog.run(interaction.guild.id, channel.id);
        await interaction.reply({ content: `Mod-log channel set to ${channel}.`, flags: MessageFlags.Ephemeral });
      } catch (e) {
        await interaction.reply({ content: `Failed to save: ${e.message}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    // /healthlog-set
    if (interaction.commandName === 'healthlog-set') {
      if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: 'You need **Manage Server** to run this.', flags: MessageFlags.Ephemeral });
      }
      const channel = interaction.options.getChannel('channel');
      if (!channel?.isTextBased?.() || !channel.viewable) {
        return interaction.reply({ content: 'Please choose a text channel I can see.', flags: MessageFlags.Ephemeral });
      }
      try {
        setHealthlog.run(interaction.guild.id, channel.id);
        await interaction.reply({ content: `Health-log channel set to ${channel}.`, flags: MessageFlags.Ephemeral });
      } catch (e) {
        await interaction.reply({ content: `Failed to save: ${e.message}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    // /chat-set
    if (interaction.commandName === 'chat-set') {
      if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: 'You need **Manage Server** to run this.', flags: MessageFlags.Ephemeral });
      }
      const channel = interaction.options.getChannel('channel');
      if (!channel?.isTextBased?.() || !channel.viewable) {
        return interaction.reply({ content: 'Please choose a text channel I can see.', flags: MessageFlags.Ephemeral });
      }
      try {
        setChatChannel.run(interaction.guild.id, channel.id);
        await interaction.reply({ content: `Chat channel set to ${channel}.`, flags: MessageFlags.Ephemeral });
      } catch (e) {
        await interaction.reply({ content: `Failed to save: ${e.message}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    // /health-snapshot (manual)
    if (interaction.commandName === 'health-snapshot') {
      const overrideChannel = interaction.options.getChannel('channel');
      const dryRun = interaction.options.getBoolean('dry_run') ?? false;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      let target = overrideChannel;
      if (!target) target = await getHealthLogChannel(interaction.guild);
      if (!target) {
        return interaction.editReply('No health-log channel set. Use **/healthlog-set** or pass a **channel** override.');
      }
      if (!target.isTextBased?.() || !target.viewable) {
        return interaction.editReply('I cannot post in that channel (not text-based or not viewable).');
      }

      const snap = await buildHealthSnapshotForGuild(interaction.guild);

      if (dryRun) {
        return interaction.editReply(
          [
            '🧪 **Health Snapshot (dry run)**',
            `Active users (proxy): **${snap.activeUsers}**`,
            `Text senders: **${snap.textSenders}**`,
            `VC joins: **${snap.vcJoins}**`,
            `Needs boost (<15): **${snap.needsBoost ? 'Yes' : 'No'}**`,
            `Target channel: ${target}`
          ].join('\n')
        );
      }

      await postHealthSnapshot(interaction.guild, target);
      return interaction.editReply(`✅ Posted health snapshot to ${target}.`);
    }

  } catch (e) {
    console.error('interactionCreate error:', e);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('Something went wrong. Check permissions and try again.');
      } else {
        await interaction.reply({ content: 'Something went wrong. Check permissions and try again.', flags: MessageFlags.Ephemeral });
      }
    } catch {}
  }
});

// --- Scheduled: Daily 04:00 PT inactive report to mod-log AND health/chat channel ---
new cron.CronJob('0 4 * * *', async () => {
  for (const [, guild] of client.guilds.cache) {
    try {
      const days = DEFAULT_INACTIVITY_DAYS;
      const list = await scanInactive(guild, days, DEFAULT_MIN_VC_MINUTES, null);
      const total = list.length;
      const sample = list.slice(0, 20).map(u => `<@${u.id}>`).join(', ');
      const more = total > 20 ? `, +${total - 20} more` : '';

      const line =
        `⏰ Daily inactive scan (last **${days}** days)\n` +
        `• Candidates: **${total}**\n` +
        `• Sample: ${sample || '_None_'}${more}\n` +
        `• Note: criteria = no messages & no VC join in window` +
        (DEFAULT_MIN_VC_MINUTES > 0 ? ` & < ${DEFAULT_MIN_VC_MINUTES} VC mins` : ``);

      const modCh = await getModLogChannel(guild);
      const healthCh = await getHealthLogChannel(guild);

      if (modCh) await modCh.send({ content: line });
      if (healthCh && (!modCh || healthCh.id !== modCh.id)) await healthCh.send({ content: line });
      if (!modCh && !healthCh) console.log(`[${guild.name}] ${line.replace(/\n/g, ' ')}`);
    } catch (e) {
      console.warn(`[${guild.id}] daily inactive report failed:`, e.message);
    }
  }
}, null, true, 'America/Los_Angeles');

// --- Scheduled: Daily 12:30 PT Server Health Snapshot to health/chat channel ---
new cron.CronJob('30 12 * * *', async () => {
  for (const [, guild] of client.guilds.cache) {
    try {
      const target = await getHealthLogChannel(guild);
      if (!target) {
        console.log(`[${guild.name}] No health/chat channel found for health snapshot.`);
        continue;
      }
      await postHealthSnapshot(guild, target);
    } catch (e) {
      console.warn(`[${guild.id}] health snapshot failed:`, e.message);
    }
  }
}, null, true, 'America/Los_Angeles');

// Use clientReady (future-proof the ready event name)
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error('Command registration failed:', e);
  }
});

client.login(process.env.DISCORD_TOKEN);