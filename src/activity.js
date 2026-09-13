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
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
} from "discord.js";
import { canOpenPanel } from "./perms.js";
import { COLOR_DARK, formatDateTimeRu, logJson, MSK, safeReply, withLock } from "./util.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID
    ? "/app/data"
    : path.join(ROOT, "data");
const ACT_PATH = path.join(DATA_DIR, "activity.json");
const ACT_TMP = path.join(DATA_DIR, "activity.json.tmp");

const KINDS = new Set(["voice", "msg", "react"]);
const KIND_LABEL = { voice: "Войс", msg: "Сообщения", react: "Реакции" };
const PAGE_SIZE = 20;
const MAX_ROLE_MEMBERS = 500;
const V2_EPH = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

/** @type {Record<string, Record<string, { voice?: number, msg?: number, react?: number }>>} */
let store = {};
let dirty = false;
let saveTimer = null;

function load() {
  try {
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
process.on("beforeExit", () => flush());
process.on("SIGINT", () => {
  flush();
});
process.on("SIGTERM", () => {
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

function assertKind(kind) {
  const k = String(kind || "");
  if (!KINDS.has(k)) return null;
  return k;
}

function fmtWhen(ts) {
  if (!ts || !Number.isFinite(Number(ts))) return "нет данных";
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return "нет данных";
  return `${formatDateTimeRu(d, MSK)} МСК`;
}

function chunkLines(lines, maxLen = 3500) {
  const pages = [];
  let buf = [];
  let used = 0;
  for (const line of lines) {
    const add = (buf.length ? 1 : 0) + line.length;
    if (used + add > maxLen && buf.length) {
      pages.push(buf.join("\n"));
      buf = [line];
      used = line.length;
    } else {
      buf.push(line);
      used += add;
    }
  }
  if (buf.length) pages.push(buf.join("\n"));
  return pages.length ? pages : ["Нет участников с этой ролью."];
}

export function statsKindRows() {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("c:adm:stats:kind")
        .setPlaceholder("Какая активность?")
        .addOptions(
          new StringSelectMenuOptionBuilder()
            .setLabel("Войс")
            .setValue("voice")
            .setEmoji("🔊")
            .setDescription("Последний заход/активность в войсе"),
          new StringSelectMenuOptionBuilder()
            .setLabel("Сообщения")
            .setValue("msg")
            .setEmoji("💬")
            .setDescription("Последнее сообщение на сервере"),
          new StringSelectMenuOptionBuilder()
            .setLabel("Реакции")
            .setValue("react")
            .setEmoji("👍")
            .setDescription("Последняя поставленная реакция"),
        ),
    ),
  ];
}

export function statsRoleRow(kind) {
  const k = assertKind(kind);
  if (!k) return null;
  return new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId(`c:adm:stats:role:${k}`)
      .setPlaceholder("Выбери роль для проверки")
      .setMinValues(1)
      .setMaxValues(1),
  );
}

function statsPayload(title, body, rows) {
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_DARK)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}\n${body}`));
  for (const row of rows) container.addActionRowComponents(row);
  return { components: [container], flags: V2_EPH };
}

async function buildMemberRows(guild, role, kind) {
  try {
    await guild.members.fetch();
  } catch (err) {
    logJson("WARN", "stats members.fetch", { error: String(err), guildId: guild.id });
  }

  const members = [...role.members.values()].filter((m) => m && !m.user.bot);
  if (members.length > MAX_ROLE_MEMBERS) {
    return {
      error: `Слишком много людей с этой ролью (**${members.length}**). Максимум для отчёта: **${MAX_ROLE_MEMBERS}**.`,
    };
  }

  const rows = members.map((m) => {
    const act = getUserActivity(guild.id, m.id);
    const ts = act?.[kind] ? Number(act[kind]) : 0;
    return {
      id: m.id,
      name: m.displayName || m.user.username || m.id,
      ts: Number.isFinite(ts) ? ts : 0,
    };
  });

  rows.sort((a, b) => {
    if (a.ts === b.ts) return a.name.localeCompare(b.name, "ru");
    if (!a.ts) return 1;
    if (!b.ts) return -1;
    return b.ts - a.ts;
  });

  const lines = rows.map((r, i) => {
    const when = r.ts ? `<t:${Math.floor(r.ts / 1000)}:R> · ${fmtWhen(r.ts)}` : "**нет данных**";
    return `**${i + 1}.** <@${r.id}> — ${when}`;
  });

  return { lines, total: rows.length, withData: rows.filter((r) => r.ts > 0).length };
}

export async function renderStatsReport(guild, kind, roleId, page = 0) {
  const k = assertKind(kind);
  if (!k) return { error: "Неизвестный тип активности." };
  if (!guild) return { error: "Сервер не найден." };
  const rid = String(roleId || "");
  if (!/^\d{5,32}$/.test(rid)) return { error: "Некорректный ID роли." };
  if (rid === guild.id) return { error: "Нельзя выбрать @everyone." };

  const role = guild.roles.cache.get(rid);
  if (!role) return { error: "Роль не найдена на сервере." };

  const built = await buildMemberRows(guild, role, k);
  if (built.error) return { error: built.error };

  const pages = chunkLines(built.lines);
  const p = Math.max(0, Math.min(page, pages.length - 1));
  const title = `Статистика · ${KIND_LABEL[k]}`;
  const body =
    `Роль: ${role}\n` +
    `Участников (без ботов): **${built.total}**\n` +
    `С данными: **${built.withData}** · без данных: **${built.total - built.withData}**\n` +
    `Страница **${p + 1}/${pages.length}**\n\n` +
    pages[p];

  const rows = [];
  if (pages.length > 1) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`c:adm:stats:page:${k}:${rid}:${p - 1}`)
          .setLabel("← Назад")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(p <= 0),
        new ButtonBuilder()
          .setCustomId(`c:adm:stats:page:${k}:${rid}:${p + 1}`)
          .setLabel("Далее →")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(p >= pages.length - 1),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("c:adm:stats:home")
        .setLabel("← К выбору активности")
        .setStyle(ButtonStyle.Primary),
    ),
  );

  return { payload: statsPayload(title, body.slice(0, 3900), rows) };
}

export function statsHomePayload() {
  return statsPayload(
    "Статистика активности",
    "1) Выбери тип: **войс / сообщения / реакции**\n2) Выбери роль\n3) Получишь список людей с этой ролью и когда они были активны.\n\nДанные копятся с момента запуска бота (и пока бот онлайн).",
    statsKindRows(),
  );
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
    const payload = statsHomePayload();
    if (id === "c:adm:stats:home" && interaction.message) {
      await interaction.update(payload);
      return true;
    }
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
    else await interaction.reply(payload);
    return true;
  }

  if (interaction.isStringSelectMenu() && id === "c:adm:stats:kind") {
    const kind = assertKind(interaction.values[0]);
    if (!kind) {
      await safeReply(interaction, "Некорректный тип активности.");
      return true;
    }
    const row = statsRoleRow(kind);
    await interaction.update(
      statsPayload(
        `Статистика · ${KIND_LABEL[kind]}`,
        "Теперь выбери роль. Покажу всех с этой ролью и время последней активности.",
        [row],
      ),
    );
    return true;
  }

  const rolePick = id.match(/^c:adm:stats:role:(voice|msg|react)$/);
  if (interaction.isRoleSelectMenu() && rolePick) {
    const kind = rolePick[1];
    const roleId = String(interaction.values?.[0] || "");
    if (!/^\d{5,32}$/.test(roleId)) {
      await safeReply(interaction, "Некорректная роль.");
      return true;
    }
    if (roleId === interaction.guild.id) {
      await safeReply(interaction, "Нельзя выбрать @everyone.");
      return true;
    }
    await interaction.deferUpdate();
    const result = await withLock(`stats:${interaction.guildId}:${kind}:${roleId}`, async () =>
      renderStatsReport(interaction.guild, kind, roleId, 0),
    );
    if (result.error) {
      await interaction.editReply(
        statsPayload("Статистика · ошибка", result.error, [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("c:adm:stats:home")
              .setLabel("← К выбору активности")
              .setStyle(ButtonStyle.Primary),
          ),
        ]),
      );
      return true;
    }
    await interaction.editReply(result.payload);
    return true;
  }

  const pagePick = id.match(/^c:adm:stats:page:(voice|msg|react):(\d+):(-?\d+)$/);
  if (interaction.isButton() && pagePick) {
    const kind = pagePick[1];
    const roleId = pagePick[2];
    const page = Number(pagePick[3]);
    if (!Number.isInteger(page) || page < 0 || page > 1000) {
      await safeReply(interaction, "Некорректная страница.");
      return true;
    }
    if (!/^\d{5,32}$/.test(roleId) || roleId === interaction.guild.id) {
      await safeReply(interaction, "Некорректная роль.");
      return true;
    }
    await interaction.deferUpdate();
    const result = await withLock(`stats:${interaction.guildId}:${kind}:${roleId}`, async () =>
      renderStatsReport(interaction.guild, kind, roleId, page),
    );
    if (result.error) {
      await interaction.editReply(
        statsPayload("Статистика · ошибка", result.error, [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("c:adm:stats:home")
              .setLabel("← К выбору активности")
              .setStyle(ButtonStyle.Primary),
          ),
        ]),
      );
      return true;
    }
    await interaction.editReply(result.payload);
    return true;
  }

  await safeReply(interaction, "Неизвестное действие статистики.");
  return true;
}

export function trackMessageActivity(message) {
  if (!message?.guild || message.author?.bot || message.webhookId) return;
  touchActivity(message.guild.id, message.author.id, "msg", message.createdTimestamp || Date.now());
}

export function trackVoiceActivity(oldState, newState) {
  const member = newState.member || oldState.member;
  if (!member || member.user?.bot) return;
  const guildId = newState.guild?.id || oldState.guild?.id;
  if (!guildId) return;
  const joined = !oldState.channelId && newState.channelId;
  const left = oldState.channelId && !newState.channelId;
  const moved = oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId;
  if (joined || left || moved) touchActivity(guildId, member.id, "voice", Date.now());
}

export function trackReactionActivity(reaction, user) {
  if (!user || user.bot) return;
  const msg = reaction.message;
  const guild = msg?.guild;
  if (!guild) return;
  touchActivity(guild.id, user.id, "react", Date.now());
}
