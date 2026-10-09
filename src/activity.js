import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  RoleSelectMenuBuilder,
  TextDisplayBuilder,
  UserSelectMenuBuilder,
} from "discord.js";
import { canOpenPanel } from "./perms.js";
import { COLOR_DARK, logJson, safeReply } from "./util.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID
    ? "/app/data"
    : path.join(ROOT, "data");
const ACT_PATH = path.join(DATA_DIR, "activity.json");
const ACT_TMP = path.join(DATA_DIR, "activity.json.tmp");

const KINDS = new Set(["voice", "msg", "react"]);
const MAX_ROLE_MEMBERS = 500;
const V2 = MessageFlags.IsComponentsV2;
const voiceSessions = new Map();
let voicePulseTimer = null;

/** @type {Record<string, Record<string, { voice?: number, msg?: number, react?: number }>>} */
let store = {};
let dirty = false;
let saveTimer = null;

function load() {
  try {
    const b64 = (process.env.RESTORE_ACTIVITY_JSON_B64 || "").trim();
    if (b64) {
      const buf = Buffer.from(b64, "base64");
      if (buf.length >= 100) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(ACT_PATH, buf);
        console.log(`[INFO] RESTORE_ACTIVITY_JSON_B64: записан ${ACT_PATH} (${buf.length}b)`);
      }
    }
    if (!fs.existsSync(ACT_PATH)) {
      console.log(`[INFO] activity.json нет в ${DATA_DIR}`);
      return;
    }
    const raw = fs.readFileSync(ACT_PATH, "utf8");
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") store = parsed;
    const guilds = Object.keys(store).length;
    console.log(`[INFO] activity.json загружен: guilds=${guilds} size=${raw.length}b path=${ACT_PATH}`);
  } catch (err) {
    logJson("WARN", "activity.json не прочитан", { error: String(err) });
    store = {};
  }
}

function flush() {
  if (!dirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const body = JSON.stringify(store);
    if (fs.existsSync(ACT_PATH)) {
      const diskSize = fs.statSync(ACT_PATH).size;
      if (diskSize > body.length * 1.5 && diskSize > 4000) {
        const raw = fs.readFileSync(ACT_PATH, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          store = parsed;
          dirty = false;
          logJson("WARN", "activity.json save отменён — перечитал больший файл с диска", {
            disk: diskSize,
            ram: body.length,
          });
          return;
        }
      }
    }
    fs.writeFileSync(ACT_TMP, body);
    fs.renameSync(ACT_TMP, ACT_PATH);
    dirty = false;
  } catch (err) {
    logJson("ERROR", "activity.json не сохранён", { error: String(err) });
  }
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 4000);
}

load();
process.on("beforeExit", () => {
  flushVoiceSessions();
  flush();
});
process.on("SIGINT", () => {
  flushVoiceSessions();
  flush();
});
process.on("SIGTERM", () => {
  flushVoiceSessions();
  flush();
});

export function touchActivity(guildId, userId, kind, at = Date.now()) {
  if (!guildId || !userId) return false;
  if (!KINDS.has(kind)) return false;
  const ts = Number(at);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const g = String(guildId);
  const u = String(userId);
  store[g] = store[g] || {};
  const row = store[g][u] || {};
  const prev = Number(row[kind] || 0);
  if (ts <= prev) return false;
  row[kind] = ts;
  store[g][u] = row;
  scheduleSave();
  return true;
}

export function getUserActivity(guildId, userId) {
  return store[String(guildId)]?.[String(userId)] || null;
}

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

function memberRow(guildId, userId) {
  const g = String(guildId);
  const u = String(userId);
  store[g] ||= {};
  store[g][u] ||= {};
  store[g][u].daily ||= {};
  store[g][u].sbors ||= {};
  return store[g][u];
}

function dayKey(timestamp = Date.now()) {
  return new Date(timestamp + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

function dailyRow(guildId, userId, timestamp = Date.now()) {
  const row = memberRow(guildId, userId);
  const key = dayKey(timestamp);
  row.daily[key] ||= { msg: 0, voiceSec: 0 };
  return row.daily[key];
}

function addVoiceDuration(guildId, userId, startedAt, endedAt) {
  let cursor = Number(startedAt);
  const end = Number(endedAt);
  if (!Number.isFinite(cursor) || !Number.isFinite(end) || end <= cursor) return;

  while (cursor < end) {
    const key = dayKey(cursor);
    const nextDay = Date.parse(`${key}T21:00:00.000Z`);
    const sliceEnd = Math.min(end, nextDay);
    dailyRow(guildId, userId, cursor).voiceSec += Math.max(0, Math.round((sliceEnd - cursor) / 1000));
    cursor = sliceEnd;
  }
  scheduleSave();
}

function flushVoiceSessions() {
  if (!voiceSessions.size) return;
  const now = Date.now();
  for (const [key, session] of voiceSessions) {
    addVoiceDuration(session.guildId, session.userId, session.startedAt, now);
    voiceSessions.set(key, { ...session, startedAt: now });
  }
}

export function startVoiceTracking(client) {
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    for (const member of guild.members.cache.values()) {
      if (!member.user.bot && member.voice.channelId) {
        voiceSessions.set(`${guild.id}:${member.id}`, {
          guildId: guild.id,
          userId: member.id,
          startedAt: now,
        });
      }
    }
  }
  if (!voicePulseTimer) {
    voicePulseTimer = setInterval(flushVoiceSessions, 60_000);
    voicePulseTimer.unref?.();
  }
}

export function trackSborParticipation(guildId, userId, panelId, kind, timestamp = Date.now()) {
  if (!guildId || !userId || !panelId || (kind !== null && !["main", "sub"].includes(kind))) return;
  const row = memberRow(guildId, userId);
  if (kind === null) delete row.sbors[String(panelId)];
  else row.sbors[String(panelId)] = { kind, at: Number(timestamp) || Date.now() };
  scheduleSave();
}

const PERIODS = new Set(["today", "7", "30", "all"]);
const PERIOD_LABELS = { today: "сегодня", 7: "за 7 дней", 30: "за 30 дней", all: "за всё время" };

function normalizePeriod(period) {
  return PERIODS.has(String(period)) ? String(period) : "7";
}

function firstPeriodDay(period) {
  const p = normalizePeriod(period);
  if (p === "all") return null;
  const days = p === "today" ? 1 : Number(p);
  return dayKey(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
}

function timestampInPeriod(timestamp, period) {
  const first = firstPeriodDay(period);
  return !first || dayKey(Number(timestamp) || 0) >= first;
}

function totalsFor(guildId, userId, period) {
  const row = getUserActivity(guildId, userId) || {};
  const first = firstPeriodDay(period);
  const totals = { msg: 0, voiceSec: 0, main: 0, sub: 0 };
  for (const [key, daily] of Object.entries(row.daily || {})) {
    if (first && key < first) continue;
    totals.msg += Number(daily.msg) || 0;
    totals.voiceSec += Number(daily.voiceSec) || 0;
  }
  for (const entry of Object.values(row.sbors || {})) {
    if (!entry || !timestampInPeriod(entry.at, period)) continue;
    if (entry.kind === "main") totals.main += 1;
    if (entry.kind === "sub") totals.sub += 1;
  }
  const session = voiceSessions.get(`${guildId}:${userId}`);
  if (session && timestampInPeriod(session.startedAt, period)) {
    totals.voiceSec += Math.max(0, Math.round((Date.now() - session.startedAt) / 1000));
  }
  return totals;
}

function formatVoice(seconds) {
  const totalMinutes = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours) return `${hours} ч. ${minutes} мин.`;
  return `${minutes} мин.`;
}

function rankingLines(rows, type) {
  const value = (row) => {
    if (type === "voice") return row.totals.voiceSec;
    if (type === "msg") return row.totals.msg;
    return row.totals.main + row.totals.sub;
  };
  const ranked = rows
    .filter((row) => value(row) > 0)
    .sort((a, b) => value(b) - value(a))
    .slice(0, 10);
  if (!ranked.length) return "_Пока нет данных._";
  return ranked
    .map((row, index) => {
      let amount;
      if (type === "voice") amount = formatVoice(row.totals.voiceSec);
      else if (type === "msg") amount = `${row.totals.msg} сообщ.`;
      else {
        amount = `${row.totals.main + row.totals.sub} участ. (основа ${row.totals.main}, замена ${row.totals.sub})`;
      }
      return `**${index + 1}.** <@${row.id}> — **${amount}**`;
    })
    .join("\n");
}

async function memberStats(guild, period, role = null) {
  try {
    await guild.members.fetch();
  } catch (err) {
    logJson("WARN", "stats members.fetch", { error: String(err), guildId: guild.id });
  }
  const members = role ? [...role.members.values()] : [...guild.members.cache.values()];
  return members
    .filter((member) => member && !member.user.bot)
    .map((member) => ({ id: member.id, totals: totalsFor(guild.id, member.id, period) }));
}

function controls(period) {
  const p = normalizePeriod(period);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("c:adm:stats:period:today")
        .setLabel("Сегодня")
        .setStyle(p === "today" ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("c:adm:stats:period:7")
        .setLabel("7 дней")
        .setStyle(p === "7" ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("c:adm:stats:period:30")
        .setLabel("30 дней")
        .setStyle(p === "30" ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("c:adm:stats:period:all")
        .setLabel("Всё время")
        .setStyle(p === "all" ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("c:adm:dept:5rp")
        .setLabel("Назад")
        .setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`c:adm:stats:user:${p}`)
        .setPlaceholder("Выбрать участника")
        .setMinValues(1)
        .setMaxValues(1),
    ),
    new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(`c:adm:stats:role:${p}`)
        .setPlaceholder("Выбрать роль")
        .setMinValues(1)
        .setMaxValues(1),
    ),
  ];
}

function statsPayload(title, body, period) {
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_DARK)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}\n${body}`));
  for (const row of controls(period)) container.addActionRowComponents(row);
  return { components: [container], flags: V2 };
}

async function statsHomePayload(guild, period = "7", role = null) {
  const p = normalizePeriod(period);
  const rows = await memberStats(guild, p, role);
  const body =
    `### 🔊 Голосовая активность\n${rankingLines(rows, "voice")}\n\n` +
    `### 💬 Сообщения\n${rankingLines(rows, "msg")}\n\n` +
    `### 📋 Участие в сборах\n${rankingLines(rows, "sbor")}`;
  const suffix = role ? ` · ${role.name}` : "";
  return statsPayload(`Статистика активности — ${PERIOD_LABELS[p]}${suffix}`, body, p);
}

function userStatsPayload(guildId, userId, period) {
  const p = normalizePeriod(period);
  const totals = totalsFor(guildId, userId, p);
  const body =
    `<@${userId}>\n\n` +
    `🔊 Голосовая активность: **${formatVoice(totals.voiceSec)}**\n` +
    `💬 Сообщения: **${totals.msg}**\n` +
    `📋 Сборы: **${totals.main + totals.sub}** (основа ${totals.main}, замена ${totals.sub})`;
  return statsPayload(`Статистика участника — ${PERIOD_LABELS[p]}`, body, p);
}

export async function handleActivityAdmin(interaction) {
  const id = interaction.customId || "";
  if (!id.startsWith("c:adm:stats:") && id !== "c:adm:tab:stats") return false;
  if (!(await canOpenPanel(interaction))) {
    await safeReply(interaction, "Нет доступа к панели.");
    return true;
  }
  if (!interaction.guild) {
    await safeReply(interaction, "Только на сервере.");
    return true;
  }

  if (interaction.isButton() && (id === "c:adm:tab:stats" || id === "c:adm:stats:home")) {
    await interaction.deferUpdate();
    await interaction.editReply(await statsHomePayload(interaction.guild, "7"));
    return true;
  }

  const periodPick = id.match(/^c:adm:stats:period:(today|7|30|all)$/);
  if (interaction.isButton() && periodPick) {
    await interaction.deferUpdate();
    await interaction.editReply(await statsHomePayload(interaction.guild, periodPick[1]));
    return true;
  }

  const userPick = id.match(/^c:adm:stats:user:(today|7|30|all)$/);
  if (interaction.isUserSelectMenu() && userPick) {
    const userId = String(interaction.values?.[0] || "");
    await interaction.update(userStatsPayload(interaction.guild.id, userId, userPick[1]));
    return true;
  }

  const rolePick = id.match(/^c:adm:stats:role:(today|7|30|all)$/);
  if (interaction.isRoleSelectMenu() && rolePick) {
    const roleId = String(interaction.values?.[0] || "");
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role || roleId === interaction.guild.id) {
      await safeReply(interaction, "Выбери обычную роль, не @everyone.");
      return true;
    }
    if (role.members.size > MAX_ROLE_MEMBERS) {
      await safeReply(interaction, `В роли больше ${MAX_ROLE_MEMBERS} участников.`);
      return true;
    }
    await interaction.deferUpdate();
    await interaction.editReply(await statsHomePayload(interaction.guild, rolePick[1], role));
    return true;
  }

  await safeReply(interaction, "Неизвестное действие статистики.");
  return true;
}

export function trackMessageActivity(message) {
  if (!message?.guild || message.author?.bot || message.webhookId) return;
  const timestamp = message.createdTimestamp || Date.now();
  touchActivity(message.guild.id, message.author.id, "msg", timestamp);
  dailyRow(message.guild.id, message.author.id, timestamp).msg += 1;
  scheduleSave();
}

export function trackVoiceActivity(oldState, newState) {
  const member = newState.member || oldState.member;
  if (!member || member.user?.bot) return;
  const guildId = newState.guild?.id || oldState.guild?.id;
  if (!guildId) return;
  const joined = !oldState.channelId && newState.channelId;
  const left = oldState.channelId && !newState.channelId;
  const moved = oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId;
  if (!joined && !left && !moved) return;

  const now = Date.now();
  const key = `${guildId}:${member.id}`;
  const session = voiceSessions.get(key);
  if ((left || moved) && session) {
    addVoiceDuration(guildId, member.id, session.startedAt, now);
    voiceSessions.delete(key);
  }
  if (joined || moved) {
    voiceSessions.set(key, { guildId, userId: member.id, startedAt: now });
  }
  touchActivity(guildId, member.id, "voice", now);
}

export function trackReactionActivity(reaction, user) {
  if (!user || user.bot) return;
  const msg = reaction.message;
  const guild = msg?.guild;
  if (!guild) return;
  touchActivity(guild.id, user.id, "react", Date.now());
}
