import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, setConfig } from "./config.js";
import { applicationPanel, buildApplicationEmbed, guildAcceptance, setGuildAcceptance } from "./tickets.js";
import { buildMapsEmbed, mapsPanel } from "./maps.js";
import {
  buildKontraktPanelEmbed,
  kontraktAllowedInChannel,
  kontraktChannelRestrictionMessage,
  kontraktPanelRows,
} from "./kontrakt.js";
import { buildAutoparkEmbed, autoparkPanelRows, registerPanel } from "./autopark.js";
import { tempVoicePanelPayload } from "./tempVoice.js";
import { createChannelBackup, getChannelBackupMeta, restoreChannelBackup } from "./channelBackup.js";
import { canEditSettings, canModerate, canOpenPanel, canPostKontrakt, canSpam } from "./perms.js";
import { logAdminChange } from "./schedulers.js";
import {
  COLOR_DARK,
  isGuildManager,
  mentionChannels,
  mentionRoles,
  resolveMember,
  safeReply,
  statusLine,
} from "./util.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panelUi = new Map();
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const V2 = MessageFlags.IsComponentsV2;
const V2_EPH = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

function bannerPath() {
  for (const name of ["panel.png", "banner.png", "ticket_banner.png"]) {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) return p;
  }
  const fromEnv = (process.env.BANNER_IMAGE_PATH || process.env.APPLICATION_EMBED_IMAGE_PATH || "").trim();
  if (fromEnv) {
    const abs = path.isAbsolute(fromEnv) ? fromEnv : path.join(ROOT, fromEnv);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function fmtCh(id) {
  return id ? `<#${id}>` : "не задан";
}

function mark(ok) {
  return ok ? "✅" : "❌";
}

function uiKey(interaction) {
  return `${interaction.guildId}:${interaction.user.id}`;
}

function uiGet(interaction) {
  return panelUi.get(uiKey(interaction)) || { tab: "mods", sborKind: null };
}

function uiSet(interaction, patch) {
  const next = { ...uiGet(interaction), ...patch };
  panelUi.set(uiKey(interaction), next);
  return next;
}

function existingIds(cache, ids) {
  return (ids || []).map(String).filter((id) => cache.has(id));
}

function roleSelect(guild, customId, placeholder, ids, max = 25) {
  const present = existingIds(guild.roles.cache, ids).slice(0, max);
  const builder = new RoleSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(0)
    .setMaxValues(max);
  if (present.length) builder.setDefaultRoles(present);
  return new ActionRowBuilder().addComponents(builder);
}

function channelSelect(guild, customId, placeholder, types, ids, max = 1) {
  const present = existingIds(guild.channels.cache, ids).slice(0, max);
  const builder = new ChannelSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(0)
    .setMaxValues(max)
    .setChannelTypes(...types);
  if (present.length) builder.setDefaultChannels(present);
  return new ActionRowBuilder().addComponents(builder);
}

function userSelect(customId, placeholder, ids, max = 25) {
  const present = (ids || []).map(String).slice(0, max);
  const builder = new UserSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(0)
    .setMaxValues(max);
  if (present.length) builder.setDefaultUsers(present);
  return new ActionRowBuilder().addComponents(builder);
}

function btn(id, label, emoji, style = ButtonStyle.Secondary) {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
}

function v2Message(title, body, rows, { ephemeral = false } = {}) {
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_DARK)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}\n${body}`));
  for (const row of rows) container.addActionRowComponents(row);
  return {
    components: [container],
    flags: ephemeral ? V2_EPH : V2,
  };
}

function panelLine(cfg, key, label) {
  const id = cfg.panelChannels?.[key];
  return `${label} → ${id ? `<#${id}>` : "ещё не публиковали"}`;
}

function hubPayload(guild) {
  const cfg = getConfig(guild.id);
  const body =
    `Выбери раздел — у каждого своя настройка.\n\n` +
    `${mark(cfg.ticketCategoryId)} Заявки · ${mark(cfg.autoparkManagerRoleIds?.length)} машины\n` +
    `${mark(cfg.kontraktChannelId)} Контракты · ${mark(cfg.tempVoiceCreateChannelId)} комнаты\n` +
    `${mark(cfg.botActionLogChannelId || cfg.modLogChannelId || cfg.leaveLogChannelId)} Логи\n\n` +
    `Сборы: команда **/сбор**`;

  return v2Message("Админка Consume", body, [
    new ActionRowBuilder().addComponents(
      btn("c:adm:tab:panels", "Панели", "📤", ButtonStyle.Primary),
      btn("c:adm:tab:apps", "Заявки", "🎫"),
      btn("c:adm:tab:cars", "Машины", "🚗"),
      btn("c:adm:tab:kontr", "Контракты", "📜"),
      btn("c:adm:tab:spam", "Спам", "📣", ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      btn("c:adm:tab:logs", "Логи", "📋"),
      btn("c:adm:tab:mods", "Модераторы", "🛡️"),
      btn("c:adm:tab:rooms", "Комнаты", "🔊"),
      btn("c:adm:tab:protect", "Защита", "🚨", ButtonStyle.Danger),
      btn("c:adm:tab:summary", "Сводка", "📊"),
    ),
    new ActionRowBuilder().addComponents(
      btn("c:adm:tab:stats", "Статистика", "📈", ButtonStyle.Primary),
    ),
  ]);
}

function topicStatus(guild, tab, ui) {
  const cfg = getConfig(guild.id);
  const acc = guildAcceptance(guild.id);

  if (tab === "panels") {
    return {
      title: "Панели",
      body:
        `${panelLine(cfg, "apps", "Заявки")}\n` +
        `${panelLine(cfg, "maps", "Карты")}\n` +
        `${panelLine(cfg, "kontrakt", "Контракты")}\n` +
        `${panelLine(cfg, "autopark", "Машины")}\n` +
        `${panelLine(cfg, "voice", "Комнаты")}\n` +
        `${panelLine(cfg, "control", "Админка")}\n\n` +
        "Сначала панель — потом канал только для неё.",
      options: [
        { label: "Панель заявок", value: "pub:apps", emoji: "🎫", description: "Куда отправить" },
        { label: "Панель карт VZP", value: "pub:maps", emoji: "🗺️", description: "Куда отправить" },
        { label: "Панель контрактов", value: "pub:kontr", emoji: "📜", description: "Куда отправить" },
        { label: "Панель автопарка", value: "pub:ap", emoji: "🚗", description: "Куда отправить" },
        { label: "Панель комнат", value: "pub:voice", emoji: "🔊", description: "Управление войсами" },
        { label: "Эту админку", value: "pub:control", emoji: "📋", description: "Куда отправить" },
      ],
      placeholder: "Какую панель отправить?",
    };
  }
  if (tab === "apps") {
    return {
      title: "Заявки",
      body:
        `${mark(cfg.ticketCategoryId)} Категория: ${fmtCh(cfg.ticketCategoryId)}\n` +
        `${mark(cfg.ticketStaffRoleIds?.length)} Стафф: ${mentionRoles(cfg.ticketStaffRoleIds)}\n` +
        `${mark(cfg.ticketPingRoleIds?.length)} Пинг: ${mentionRoles(cfg.ticketPingRoleIds)}\n` +
        `Академия: ${mentionRoles(cfg.acceptRoleIdsAcademy)}\n` +
        `Основа: ${mentionRoles(cfg.acceptRoleIdsMain)}\n` +
        `РП: ${statusLine(acc.rp)} · VZP: ${statusLine(acc.vzp)}\n\n` +
        "Тикеты, роли принятия и вкл/выкл приёма.",
      options: [
        { label: "Категория тикетов", value: "c:tcat", emoji: "📁", description: "Где создавать тикеты" },
        { label: "Стафф тикетов", value: "r:staff", emoji: "🛡️", description: "Кто видит тикет" },
        { label: "Пинг новой заявки", value: "r:tping", emoji: "📣", description: "Кого пинговать" },
        { label: "Роли академии", value: "r:acad", emoji: "🎓", description: "Выдать при принятии" },
        { label: "Роли основы", value: "r:main", emoji: "✅", description: "Выдать при принятии" },
        { label: "Вкл/выкл приём РП", value: "t:rpacc", emoji: "📝", description: "Открыть или закрыть РП" },
        { label: "Вкл/выкл приём VZP", value: "t:vzpacc", emoji: "📋", description: "Открыть или закрыть VZP" },
      ],
      placeholder: "Что настроить в заявках?",
    };
  }
  if (tab === "cars") {
    return {
      title: "Машины",
      body:
        `Менеджеры: ${mentionRoles(cfg.autoparkManagerRoleIds)}\n` +
        `Бронь: **${cfg.autoparkReserveMinutes || 60}** мин\n` +
        `${panelLine(cfg, "autopark", "Панель")}\n\n` +
        "Всё, что связано с машинами.",
      options: [
        { label: "Кто правит машины", value: "r:apmgr", emoji: "🛡️", description: "Менеджеры списка" },
        { label: "Минуты брони машины", value: "t:ap", emoji: "⏱️", description: "Сколько держать бронь" },
      ],
      placeholder: "Что настроить в машинах?",
    };
  }
  if (tab === "kontr") {
    return {
      title: "Контракты",
      body:
        `Канал: ${fmtCh(cfg.kontraktChannelId)}\n` +
        `Публикация: ${mentionRoles(cfg.kontraktPostRoleIds) || "модераторы"}\n` +
        `Пикнул/Отказ: ${mentionRoles(cfg.kontraktManagerRoleIds) || "модераторы"}\n` +
        `Пинг нового: ${mentionRoles(cfg.kontraktNewContractPingRoleIds)}\n\n` +
        "Канал, роли и правила контрактов.",
      options: [
        { label: "Канал контрактов", value: "c:kontr", emoji: "📁", description: "Только этот канал" },
        { label: "Кто публикует панель", value: "r:kpost", emoji: "📤", description: "Роли" },
        { label: "Пикнул / Отказ", value: "r:kmgr", emoji: "🛡️", description: "Роли модерации" },
        { label: "Пинг нового контракта", value: "r:kping", emoji: "📣", description: "Кого пинговать" },
        { label: "Текст правил", value: "t:rules", emoji: "✏️", description: "Открыть форму" },
      ],
      placeholder: "Что настроить в контрактах?",
    };
  }
  if (tab === "spam") {
    return {
      title: "Спам",
      body:
        `Кто может: ${mentionRoles(cfg.spamCommandRoleIds) || "только Manage Server / админы"}\n\n` +
        "ЛС по роли — медленно, с паузами, чтобы Discord не резал API.",
      options: [
        { label: "Кто может спамить", value: "r:spam", emoji: "🛡️", description: "Роли доступа" },
        { label: "Запустить спам", value: "spam:to", emoji: "📣", description: "Выбрать роль получателей" },
      ],
      placeholder: "Что сделать со спамом?",
    };
  }
  if (tab === "logs") {
    return {
      title: "Логи",
      body:
        `Действия бота: ${fmtCh(cfg.botActionLogChannelId)}\n` +
        `Баны / кики: ${fmtCh(cfg.modLogChannelId)}\n` +
        `Выход с сервера: ${fmtCh(cfg.leaveLogChannelId)}\n` +
        `Пинг при выходе: ${cfg.leaveLogPingRoleId ? `<@&${cfg.leaveLogPingRoleId}>` : "—"}\n\n` +
        "Каналы логов по типу событий.",
      options: [
        { label: "Лог действий бота", value: "c:log", emoji: "📋", description: "Админка / команды" },
        { label: "Лог банов и киков", value: "c:modlog", emoji: "🔨", description: "Модерация" },
        { label: "Лог выхода", value: "c:leavelog", emoji: "👋", description: "Кто вышел + роли" },
        { label: "Пинг при выходе", value: "r:leaveping", emoji: "📣", description: "Опционально" },
      ],
      placeholder: "Какой лог настроить?",
    };
  }
  if (tab === "rooms") {
    return {
      title: "Комнаты",
      body:
        `Роли семьи: ${mentionRoles(cfg.familyRoleIds) || "—"}\n` +
        `Войс «создать»: ${fmtCh(cfg.tempVoiceCreateChannelId)}\n` +
        `Категория комнат: ${fmtCh(cfg.tempVoiceCategoryId)}\n` +
        `${panelLine(cfg, "voice", "Панель управления")}\n\n` +
        "Временные войсы для семьи Consume.",
      options: [
        { label: "Роли семьи", value: "r:family", emoji: "🏠", description: "Кто может создавать комнаты" },
        { label: "Войс «создать комнату»", value: "c:tvcreate", emoji: "🔊", description: "Куда заходить" },
        { label: "Категория комнат", value: "c:tvcat", emoji: "📁", description: "Где создавать войсы" },
      ],
      placeholder: "Что настроить в комнатах?",
    };
  }
  if (tab === "mods") {
    return {
      title: "Модераторы бота",
      body:
        `Сейчас: ${mentionRoles(cfg.moderatorRoleIds) || "не заданы"}\n\n` +
        "Кто может открывать админку и **/сбор** (кроме владельца и Manage Server).",
      options: [{ label: "Роли модераторов", value: "r:mod", emoji: "🛡️", description: "Доступ к панели" }],
      placeholder: "Кто модератор бота?",
    };
  }
  if (tab === "protect") {
    const on = cfg.antinukeEnabled !== false;
    const users = (cfg.antinukeWhitelistUserIds || []).map((id) => `<@${id}>`).join(" ") || "—";
    const bak = getChannelBackupMeta(guild.id);
    const bakLine = bak?.savedAt
      ? `есть · ${new Date(bak.savedAt).toLocaleString("ru-RU")} · ${bak.count} каналов`
      : "нет";
    return {
      title: "Защита (антислив)",
      body:
        `Статус: **${on ? "ВКЛ" : "ВЫКЛ"}**\n` +
        `Баны: **${cfg.antinukeBanLimit || 10}** / **${cfg.antinukeBanWindowSec || 60}** сек → снять роли\n` +
        `Удаление каналов: **${cfg.antinukeChannelDeleteLimit || 8}** / **${cfg.antinukeChannelDeleteWindowSec || 60}** сек → снять роли\n` +
        `Whitelist роли: ${mentionRoles(cfg.antinukeWhitelistRoleIds) || "—"}\n` +
        `Whitelist люди: ${users}\n` +
        `Бэкап каналов: **${bakLine}**\n\n` +
        "Владелец сервера всегда в исключении. Бот должен быть выше ролей виновника.",
      options: [
        {
          label: on ? "Выключить защиту" : "Включить защиту",
          value: "t:antinuke",
          emoji: on ? "🛑" : "✅",
          description: on ? "Отключить антислив" : "Включить антислив",
        },
        { label: "Whitelist роли", value: "r:anrole", emoji: "🛡️", description: "Кому можно без лимита" },
        { label: "Whitelist люди", value: "u:anuser", emoji: "👤", description: "Конкретные люди" },
        { label: "Создать бэкап каналов", value: "t:chbak", emoji: "💾", description: "Сохранить структуру" },
        { label: "Восстановить каналы", value: "t:chrestore", emoji: "♻️", description: "Вернуть из бэкапа" },
      ],
      placeholder: "Что настроить в защите?",
    };
  }
  if (tab === "summary" || tab === "home") {
    const roleOrEmpty = (ids) => (ids?.length ? mentionRoles(ids) : "—");
    return {
      title: "Сводка привязок",
      body:
        `**Модераторы**\n` +
        `Модераторы бота: ${roleOrEmpty(cfg.moderatorRoleIds)}\n\n` +
        `**Заявки**\n` +
        `Категория: ${fmtCh(cfg.ticketCategoryId)}\n` +
        `Стафф: ${roleOrEmpty(cfg.ticketStaffRoleIds)}\n` +
        `Пинг заявки: ${roleOrEmpty(cfg.ticketPingRoleIds)}\n` +
        `Академия: ${roleOrEmpty(cfg.acceptRoleIdsAcademy)}\n` +
        `Основа: ${roleOrEmpty(cfg.acceptRoleIdsMain)}\n` +
        `Приём РП: ${statusLine(acc.rp)} · VZP: ${statusLine(acc.vzp)}\n\n` +
        `**Машины**\n` +
        `Менеджеры: ${roleOrEmpty(cfg.autoparkManagerRoleIds)}\n` +
        `Бронь: ${cfg.autoparkReserveMinutes || 60} мин\n\n` +
        `**Контракты**\n` +
        `Канал: ${fmtCh(cfg.kontraktChannelId)}\n` +
        `Публикация: ${roleOrEmpty(cfg.kontraktPostRoleIds) || "модераторы"}\n` +
        `Пикнул/Отказ: ${roleOrEmpty(cfg.kontraktManagerRoleIds) || "модераторы"}\n` +
        `Пинг нового: ${roleOrEmpty(cfg.kontraktNewContractPingRoleIds)}\n\n` +
        `**Спам**\n` +
        `Кто может: ${roleOrEmpty(cfg.spamCommandRoleIds) || "Manage Server"}\n\n` +
        `**Логи**\n` +
        `Действия бота: ${fmtCh(cfg.botActionLogChannelId)}\n` +
        `Баны/кики: ${fmtCh(cfg.modLogChannelId)}\n` +
        `Выход: ${fmtCh(cfg.leaveLogChannelId)}\n` +
        `Пинг выхода: ${cfg.leaveLogPingRoleId ? `<@&${cfg.leaveLogPingRoleId}>` : "—"}\n\n` +
        `**Комнаты**\n` +
        `Роли семьи: ${roleOrEmpty(cfg.familyRoleIds)}\n` +
        `Создать комнату: ${fmtCh(cfg.tempVoiceCreateChannelId)}\n` +
        `Категория: ${fmtCh(cfg.tempVoiceCategoryId)}\n\n` +
        `**Защита**\n` +
        `Статус: ${cfg.antinukeEnabled === false ? "ВЫКЛ" : "ВКЛ"}\n` +
        `Баны: ${cfg.antinukeBanLimit || 10} / ${cfg.antinukeBanWindowSec || 60} сек\n` +
        `Удал. каналов: ${cfg.antinukeChannelDeleteLimit || 8} / ${cfg.antinukeChannelDeleteWindowSec || 60} сек\n` +
        `WL роли: ${roleOrEmpty(cfg.antinukeWhitelistRoleIds)}\n` +
        `WL люди: ${(cfg.antinukeWhitelistUserIds || []).map((id) => `<@${id}>`).join(" ") || "—"}\n\n` +
        `**Панели (куда слали)**\n` +
        `${panelLine(cfg, "apps", "Заявки")}\n` +
        `${panelLine(cfg, "maps", "Карты")}\n` +
        `${panelLine(cfg, "kontrakt", "Контракты")}\n` +
        `${panelLine(cfg, "autopark", "Машины")}\n` +
        `${panelLine(cfg, "voice", "Комнаты")}\n` +
        `${panelLine(cfg, "control", "Админка")}`,
      options: [{ label: "Обновить сводку", value: "t:refresh", emoji: "🔄", description: "Перечитать привязки" }],
      placeholder: "Обновить сводку",
    };
  }
  return { title: "Админка", body: "Выбери раздел на главной.", options: [], placeholder: "…" };
}

function topicPayload(guild, tab, ui) {
  const t = topicStatus(guild, tab, ui);
  const rows = [];
  if (t.options?.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`c:adm:cfg:${tab}`)
      .setPlaceholder(t.placeholder)
      .addOptions(
        t.options.map((o) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(o.label)
            .setValue(o.value)
            .setDescription(o.description)
            .setEmoji(o.emoji),
        ),
      );
    rows.push(new ActionRowBuilder().addComponents(select));
  }
  return v2Message(t.title, t.body, rows, { ephemeral: true });
}

const PICK_META = {
  "r:mod": { kind: "role", selectId: "c:cfg:r:mod", title: "Модераторы бота", max: 25, key: "moderatorRoleIds" },
  "r:staff": { kind: "role", selectId: "c:cfg:r:staff", title: "Стафф тикетов", max: 25, key: "ticketStaffRoleIds" },
  "r:tping": { kind: "role", selectId: "c:cfg:r:tping", title: "Пинг новой заявки", max: 25, key: "ticketPingRoleIds" },
  "r:acad": { kind: "role", selectId: "c:cfg:r:acad", title: "Роли академии", max: 25, key: "acceptRoleIdsAcademy" },
  "r:main": { kind: "role", selectId: "c:cfg:r:main", title: "Роли основы", max: 25, key: "acceptRoleIdsMain" },
  "r:apmgr": { kind: "role", selectId: "c:cfg:r:apmgr", title: "Автопарк", max: 25, key: "autoparkManagerRoleIds" },
  "r:spam": { kind: "role", selectId: "c:cfg:r:spam", title: "Кто может спамить", max: 25, key: "spamCommandRoleIds" },
  "r:kpost": { kind: "role", selectId: "c:cfg:r:kpost", title: "Кто публикует контракты", max: 25, key: "kontraktPostRoleIds" },
  "r:kmgr": { kind: "role", selectId: "c:cfg:r:kmgr", title: "Пикнул / Отказ", max: 25, key: "kontraktManagerRoleIds" },
  "r:kping": { kind: "role", selectId: "c:cfg:r:kping", title: "Пинг нового контракта", max: 25, key: "kontraktNewContractPingRoleIds" },
  "r:family": { kind: "role", selectId: "c:cfg:r:family", title: "Роли семьи Consume", max: 25, key: "familyRoleIds" },
  "r:leaveping": { kind: "role", selectId: "c:cfg:r:leaveping", title: "Пинг при выходе", max: 1, key: "leaveLogPingRoleId", single: true },
  "r:anrole": { kind: "role", selectId: "c:cfg:r:anrole", title: "Whitelist роли (антислив)", max: 25, key: "antinukeWhitelistRoleIds" },
  "u:anuser": { kind: "user", selectId: "c:cfg:u:anuser", title: "Whitelist люди (антислив)", max: 25, key: "antinukeWhitelistUserIds" },
  "c:tcat": { kind: "channel", selectId: "c:cfg:c:tcat", title: "Категория тикетов", types: [ChannelType.GuildCategory], max: 1, key: "ticketCategoryId", single: true },
  "c:log": { kind: "channel", selectId: "c:cfg:c:log", title: "Канал логов бота", types: TEXT_TYPES, max: 1, key: "botActionLogChannelId", single: true },
  "c:modlog": { kind: "channel", selectId: "c:cfg:c:modlog", title: "Лог банов/киков", types: TEXT_TYPES, max: 1, key: "modLogChannelId", single: true },
  "c:leavelog": { kind: "channel", selectId: "c:cfg:c:leavelog", title: "Лог выхода", types: TEXT_TYPES, max: 1, key: "leaveLogChannelId", single: true },
  "c:tvcreate": {
    kind: "channel",
    selectId: "c:cfg:c:tvcreate",
    title: "Войс «создать комнату»",
    types: [ChannelType.GuildVoice],
    max: 1,
    key: "tempVoiceCreateChannelId",
    single: true,
  },
  "c:tvcat": {
    kind: "channel",
    selectId: "c:cfg:c:tvcat",
    title: "Категория временных комнат",
    types: [ChannelType.GuildCategory],
    max: 1,
    key: "tempVoiceCategoryId",
    single: true,
  },
  "c:kontr": { kind: "channel", selectId: "c:cfg:c:kontr", title: "Канал контрактов", types: [ChannelType.GuildText], max: 1, key: "kontraktChannelId", single: true },
};

const PANEL_LABELS = {
  apps: "Заявки",
  maps: "Карты VZP",
  kontr: "Контракты",
  ap: "Автопарк",
  voice: "Комнаты",
  control: "Админка",
};

function dropPickPayload(guild, tab, value) {
  const cfg = getConfig(guild.id);
  const back = new ActionRowBuilder().addComponents(btn(`c:adm:back:${tab}`, "← Назад", null, ButtonStyle.Secondary));

  if (value.startsWith("pub:")) {
    const kind = value.slice(4);
    const label = PANEL_LABELS[kind] || kind;
    const lastId = cfg.panelChannels?.[kind === "kontr" ? "kontrakt" : kind === "ap" ? "autopark" : kind];
    const lastHint = lastId ? `\nПоследний раз: <#${lastId}>` : "";
    return v2Message(
      `Куда отправить: ${label}`,
      `Выбери канал — можно снова тот же.${lastHint}`,
      [
        new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId(`c:adm:send:${kind}`)
            .setPlaceholder("Выбрать канал")
            .setMinValues(1)
            .setMaxValues(1)
            .setChannelTypes(...TEXT_TYPES),
        ),
        back,
      ],
      { ephemeral: true },
    );
  }
  if (value === "spam:to") {
    return v2Message(
      "Кому отправить спам",
      "Выбери роль получателей. Сообщения уйдут в ЛС медленно, с паузами.",
      [
        new ActionRowBuilder().addComponents(
          new RoleSelectMenuBuilder().setCustomId("c:spam:role").setPlaceholder("Роль получателей").setMinValues(1).setMaxValues(1),
        ),
        back,
      ],
      { ephemeral: true },
    );
  }
  if (value.startsWith("t:")) return null;

  const meta = PICK_META[value];
  if (!meta) return null;
  const ids = meta.single
    ? cfg[meta.key]
      ? [cfg[meta.key]]
      : []
    : cfg[meta.key] || [];
  const row =
    meta.kind === "role"
      ? roleSelect(guild, meta.selectId, meta.title, ids, meta.max)
      : meta.kind === "user"
        ? userSelect(meta.selectId, meta.title, ids, meta.max)
        : channelSelect(guild, meta.selectId, meta.title, meta.types, ids, meta.max);
  return v2Message(meta.title, "Выбери ниже. Пустой выбор = сброс.", [row, back], { ephemeral: true });
}

async function editHub(interaction) {
  const cfg = getConfig(interaction.guildId);
  const chId = cfg.panelChannels?.control;
  const msgId = cfg.controlMessageId;
  if (!chId || !msgId || !interaction.guild) return;
  const ch = interaction.guild.channels.cache.get(String(chId));
  if (!ch?.isTextBased?.()) return;
  try {
    const msg = await ch.messages.fetch(String(msgId));
    await msg.edit(hubPayload(interaction.guild));
  } catch {
    /* ignore */
  }
}

async function openTopic(interaction, tab) {
  const ui = uiSet(interaction, { tab });
  const payload = topicPayload(interaction.guild, tab, ui);
  if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

async function refreshTopic(interaction, tab) {
  const ui = uiSet(interaction, { tab });
  const payload = topicPayload(interaction.guild, tab, ui);
  try {
    if (interaction.isModalSubmit?.()) {
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } else {
      await interaction.update(payload);
    }
  } catch {
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch {
      /* ignore */
    }
  }
  editHub(interaction).catch(() => null);
}

function maybeValue(builder, value) {
  const max = Number(builder.data?.max_length) || 4000;
  const v = String(value || "").slice(0, max);
  if (v) builder.setValue(v);
  return builder;
}

function rulesModal(cfg) {
  return new ModalBuilder()
    .setCustomId("c:cfg:m:rules")
    .setTitle("Правила контрактов")
    .addComponents(
      new ActionRowBuilder().addComponents(
        maybeValue(
          new TextInputBuilder()
            .setCustomId("text")
            .setLabel("Текст правил")
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(4000)
            .setRequired(true),
          cfg.kontraktRulesText,
        ),
      ),
    );
}

function apMinutesModal(cfg) {
  return new ModalBuilder()
    .setCustomId("c:cfg:m:ap")
    .setTitle("Бронь машины")
    .addComponents(
      new ActionRowBuilder().addComponents(
        maybeValue(
          new TextInputBuilder()
            .setCustomId("mins")
            .setLabel("Сколько минут держать бронь")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(4)
            .setRequired(true),
          String(cfg.autoparkReserveMinutes || 60),
        ),
      ),
    );
}

function rememberHub(guildId, channelId, messageId) {
  const cfg = getConfig(guildId);
  setConfig(guildId, {
    controlMessageId: String(messageId),
    panelChannels: { ...(cfg.panelChannels || {}), control: String(channelId) },
  });
}

function rememberPanelChannel(guildId, key, channelId) {
  const cfg = getConfig(guildId);
  setConfig(guildId, {
    panelChannels: { ...(cfg.panelChannels || {}), [key]: channelId },
  });
}

export async function handlePanelCommand(interaction) {
  if (!interaction.guild) {
    await safeReply(interaction, "Команда только на сервере.");
    return;
  }
  if (!(await canOpenPanel(interaction))) {
    await safeReply(
      interaction,
      "Нужно право **Управлять сервером**, владелец сервера или роль модератора из настроек панели.",
    );
    return;
  }
  const payload = hubPayload(interaction.guild);
  const msg = await interaction.reply({ ...payload, fetchReply: true });
  rememberHub(interaction.guild.id, interaction.channelId, msg.id);
}

const ROLE_PATCH = {
  "c:cfg:r:staff": (v) => ({ ticketStaffRoleIds: v }),
  "c:cfg:r:tping": (v) => ({ ticketPingRoleIds: v }),
  "c:cfg:r:acad": (v) => ({ acceptRoleIdsAcademy: v }),
  "c:cfg:r:main": (v) => ({ acceptRoleIdsMain: v }),
  "c:cfg:r:mod": (v) => ({ moderatorRoleIds: v }),
  "c:cfg:r:spam": (v) => ({ spamCommandRoleIds: v }),
  "c:cfg:r:apmgr": (v) => ({ autoparkManagerRoleIds: v }),
  "c:cfg:r:kpost": (v) => ({ kontraktPostRoleIds: v }),
  "c:cfg:r:kmgr": (v) => ({ kontraktManagerRoleIds: v }),
  "c:cfg:r:kping": (v) => ({ kontraktNewContractPingRoleIds: v }),
  "c:cfg:r:family": (v) => ({ familyRoleIds: v }),
  "c:cfg:r:leaveping": (v) => ({ leaveLogPingRoleId: v[0] || null }),
  "c:cfg:r:anrole": (v) => ({ antinukeWhitelistRoleIds: v }),
};

const USER_PATCH = {
  "c:cfg:u:anuser": (v) => ({ antinukeWhitelistUserIds: v }),
};

const CHANNEL_PATCH = {
  "c:cfg:c:tcat": (v) => ({ ticketCategoryId: v[0] || null }),
  "c:cfg:c:log": (v) => ({ botActionLogChannelId: v[0] || null }),
  "c:cfg:c:modlog": (v) => ({ modLogChannelId: v[0] || null }),
  "c:cfg:c:leavelog": (v) => ({ leaveLogChannelId: v[0] || null }),
  "c:cfg:c:tvcreate": (v) => ({ tempVoiceCreateChannelId: v[0] || null }),
  "c:cfg:c:tvcat": (v) => ({ tempVoiceCategoryId: v[0] || null }),
  "c:cfg:c:kontr": (v) => ({ kontraktChannelId: v[0] || null }),
};

const CFG_LABELS = {
  "c:cfg:r:staff": "Стафф тикетов",
  "c:cfg:r:tping": "Пинг новой заявки",
  "c:cfg:r:acad": "Роли академии",
  "c:cfg:r:main": "Роли основы",
  "c:cfg:r:mod": "Модераторы бота",
  "c:cfg:r:spam": "Кто может спамить",
  "c:cfg:r:apmgr": "Менеджеры автопарка",
  "c:cfg:r:kpost": "Публикация контрактов",
  "c:cfg:r:kmgr": "Пикнул / Отказ",
  "c:cfg:r:kping": "Пинг нового контракта",
  "c:cfg:r:family": "Роли семьи Consume",
  "c:cfg:r:leaveping": "Пинг при выходе",
  "c:cfg:r:anrole": "Whitelist роли антислив",
  "c:cfg:u:anuser": "Whitelist люди антислив",
  "c:cfg:c:tcat": "Категория тикетов",
  "c:cfg:c:log": "Канал логов",
  "c:cfg:c:modlog": "Лог банов/киков",
  "c:cfg:c:leavelog": "Лог выхода",
  "c:cfg:c:tvcreate": "Войс создать комнату",
  "c:cfg:c:tvcat": "Категория комнат",
  "c:cfg:c:kontr": "Канал контрактов",
};

const MENU_LABELS = {
  "c:tcat": "Категория тикетов",
  "r:staff": "Стафф тикетов",
  "r:tping": "Пинг новой заявки",
  "r:acad": "Роли академии",
  "r:main": "Роли основы",
  "r:apmgr": "Кто правит автопарк",
  "t:ap": "Минуты брони машины",
  "c:kontr": "Канал контрактов",
  "r:kpost": "Кто публикует панель",
  "r:kmgr": "Пикнул / Отказ",
  "r:kping": "Пинг нового контракта",
  "t:rules": "Текст правил контрактов",
  "r:spam": "Кто может спамить",
  "spam:to": "Запустить спам",
  "c:log": "Канал логов",
  "r:mod": "Роли модераторов",
  "t:rpacc": "Вкл/выкл приём РП",
  "t:vzpacc": "Вкл/выкл приём VZP",
  "r:family": "Роли семьи",
  "c:tvcreate": "Войс создать комнату",
  "c:tvcat": "Категория комнат",
  "c:modlog": "Лог банов/киков",
  "c:leavelog": "Лог выхода",
  "r:leaveping": "Пинг при выходе",
  "t:antinuke": "Вкл/выкл защиту",
  "t:chbak": "Создать бэкап каналов",
  "t:chrestore": "Восстановить каналы",
  "r:anrole": "Whitelist роли",
  "u:anuser": "Whitelist люди",
  "pub:apps": "Отправить панель заявок",
  "pub:maps": "Отправить панель карт",
  "pub:kontr": "Отправить панель контрактов",
  "pub:ap": "Отправить панель автопарка",
  "pub:voice": "Отправить панель комнат",
  "pub:control": "Отправить админку",
};

const TAB_LABELS = {
  panels: "Панели",
  apps: "Заявки",
  cars: "Машины",
  kontr: "Контракты",
  spam: "Спам",
  logs: "Логи",
  mods: "Модераторы",
  rooms: "Комнаты",
  protect: "Защита",
  summary: "Сводка",
  home: "Сводка",
  stats: "Статистика",
};

async function publishTo(interaction, kind, channel) {
  const ch = channel;
  if (!ch) {
    await safeReply(interaction, "Канал не выбран.");
    return false;
  }
  try {
    if (kind === "apps") {
      const emb = buildApplicationEmbed(interaction.client.user);
      const files = [];
      const banner = bannerPath();
      if (banner) {
        files.push(new AttachmentBuilder(banner, { name: "panel.png" }));
        emb.setThumbnail("attachment://panel.png");
      }
      await ch.send({ embeds: [emb], components: [applicationPanel()], files });
      rememberPanelChannel(interaction.guild.id, "apps", ch.id);
    } else if (kind === "maps") {
      await ch.send({ embeds: [buildMapsEmbed()], components: [mapsPanel()] });
      rememberPanelChannel(interaction.guild.id, "maps", ch.id);
    } else if (kind === "kontr") {
      const fake = { guildId: interaction.guildId, channelId: ch.id };
      if (!kontraktAllowedInChannel(fake)) {
        await safeReply(interaction, kontraktChannelRestrictionMessage(interaction.guildId));
        return false;
      }
      if (!(await canPostKontrakt(interaction))) {
        await safeReply(interaction, "Нет прав публиковать панель контрактов.");
        return false;
      }
      await ch.send({
        embeds: [buildKontraktPanelEmbed(interaction.guildId)],
        components: kontraktPanelRows(),
      });
      rememberPanelChannel(interaction.guild.id, "kontrakt", ch.id);
    } else if (kind === "ap") {
      const member = await resolveMember(interaction);
      if (!member || !(isGuildManager(member) || (await canOpenPanel(interaction)))) {
        await safeReply(interaction, "Нет прав.");
        return false;
      }
      const msg = await ch.send({
        embeds: [buildAutoparkEmbed(interaction.guild)],
        components: autoparkPanelRows(),
      });
      registerPanel(interaction.guild.id, ch.id, msg.id);
      rememberPanelChannel(interaction.guild.id, "autopark", ch.id);
    } else if (kind === "voice") {
      await ch.send(tempVoicePanelPayload());
      rememberPanelChannel(interaction.guild.id, "voice", ch.id);
    } else if (kind === "control") {
      const payload = hubPayload(interaction.guild);
      const msg = await ch.send(payload);
      rememberHub(interaction.guild.id, ch.id, msg.id);
    } else {
      await safeReply(interaction, "Неизвестная панель.");
      return false;
    }
  } catch {
    await safeReply(interaction, `Не удалось отправить в ${ch}. Проверьте права бота.`);
    return false;
  }
  return true;
}

export async function handleAdminInteraction(interaction) {
  const id = interaction.customId || "";
  if (!(id.startsWith("c:adm:") || id.startsWith("c:cfg:"))) return false;

  if (!(await canOpenPanel(interaction))) {
    await safeReply(interaction, "Нет доступа к панели.");
    return true;
  }

  const tabOpen = id.match(/^c:adm:tab:(.+)$/);
  if (interaction.isButton() && tabOpen) {
    if (tabOpen[1] === "stats") return false;
    const tab =
      {
        home: "summary",
        roles: "apps",
        accept: "apps",
        channels: "logs",
        texts: "summary",
        sbor: "mods",
        daily: "summary",
        dm: "summary",
        family: "rooms",
      }[tabOpen[1]] || tabOpen[1];
    if (["cars", "logs", "kontr", "mods", "rooms", "protect"].includes(tab) && !(await canEditSettings(interaction))) {
      await safeReply(interaction, "Привязки может менять только владелец или участник с правом «Управлять сервером».");
      return true;
    }
    if (tab === "spam" && !(await canSpam(interaction)) && !(await canEditSettings(interaction))) {
      await safeReply(interaction, "Нет прав на спам.");
      return true;
    }
    await openTopic(interaction, tab);
    logAdminChange(interaction, "Админка: открыл раздел", [`Раздел: **${TAB_LABELS[tab] || tab}**`]).catch(() => null);
    return true;
  }

  const back = id.match(/^c:adm:back:(.+)$/);
  if (interaction.isButton() && back) {
    await refreshTopic(interaction, back[1]);
    return true;
  }

  const sendPanel = id.match(/^c:adm:send:(.+)$/);
  if (interaction.isChannelSelectMenu() && sendPanel) {
    const kind = sendPanel[1];
    const channelId = interaction.values[0];
    const ch = interaction.guild.channels.cache.get(channelId);
    if (!ch || (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement)) {
      await safeReply(interaction, "Нужен текстовый канал.");
      return true;
    }
    const ok = await publishTo(interaction, kind, ch);
    if (ok) {
      logAdminChange(interaction, "Админка: отправил панель", [
        `Панель: **${PANEL_LABELS[kind] || kind}**`,
        `Канал: ${ch}`,
      ]).catch(() => null);
      const title = PANEL_LABELS[kind] || kind;
      const cfg = getConfig(interaction.guildId);
      const lastId = cfg.panelChannels?.[kind === "kontr" ? "kontrakt" : kind === "ap" ? "autopark" : kind];
      const lastHint = lastId ? `\nПоследний раз: <#${lastId}>` : "";
      const payload = v2Message(
        `Куда отправить: ${title}`,
        `Отправлено в ${ch}. Можно выбрать канал снова.${lastHint}`,
        [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId(`c:adm:send:${kind}`)
              .setPlaceholder("Выбрать канал")
              .setMinValues(1)
              .setMaxValues(1)
              .setChannelTypes(...TEXT_TYPES),
          ),
          new ActionRowBuilder().addComponents(btn("c:adm:back:panels", "← Назад", null, ButtonStyle.Secondary)),
        ],
        { ephemeral: true },
      );
      try {
        await interaction.update(payload);
      } catch {
        await refreshTopic(interaction, "panels");
      }
      editHub(interaction).catch(() => null);
    }
    return true;
  }

  const cfgSelect = id.match(/^c:adm:cfg:(.+)$/);
  if (interaction.isStringSelectMenu() && cfgSelect) {
    const tab = cfgSelect[1];
    const value = interaction.values[0];
    uiSet(interaction, { tab });

    if (value.startsWith("pub:")) {
      logAdminChange(interaction, "Админка: выбрал пункт", [
        `Раздел: **${TAB_LABELS[tab] || tab}**`,
        `Пункт: **${MENU_LABELS[value] || value}**`,
      ]).catch(() => null);
      const payload = dropPickPayload(interaction.guild, "panels", value);
      try {
        await interaction.update(payload);
      } catch {
        await interaction.followUp(payload).catch(() => null);
      }
      return true;
    }
    if (value === "t:refresh") {
      await refreshTopic(interaction, tab);
      return true;
    }
    if (value === "t:rpacc" || value === "t:vzpacc") {
      if (!(await canModerate(interaction))) {
        await safeReply(interaction, "Нет прав переключать приём заявок.");
        return true;
      }
      const acc = guildAcceptance(interaction.guildId);
      if (value === "t:rpacc") setGuildAcceptance(interaction.guildId, { rp: !acc.rp });
      else setGuildAcceptance(interaction.guildId, { vzp: !acc.vzp });
      const next = guildAcceptance(interaction.guildId);
      logAdminChange(interaction, "Админка: изменил приём заявок", [
        value === "t:rpacc"
          ? `РП: **${acc.rp ? "открыт" : "закрыт"}** → **${next.rp ? "открыт" : "закрыт"}**`
          : `VZP: **${acc.vzp ? "открыт" : "закрыт"}** → **${next.vzp ? "открыт" : "закрыт"}**`,
      ]).catch(() => null);
      await refreshTopic(interaction, "apps");
      return true;
    }
    if (value === "t:rules") {
      logAdminChange(interaction, "Админка: выбрал пункт", [
        `Раздел: **${TAB_LABELS[tab] || tab}**`,
        `Пункт: **${MENU_LABELS[value]}**`,
      ]).catch(() => null);
      await interaction.showModal(rulesModal(getConfig(interaction.guildId)));
      return true;
    }
    if (value === "t:antinuke") {
      if (!(await canEditSettings(interaction))) {
        await safeReply(interaction, "Защиту может менять только владелец или Manage Server.");
        return true;
      }
      const before = getConfig(interaction.guildId);
      const next = before.antinukeEnabled === false;
      setConfig(interaction.guildId, { antinukeEnabled: next });
      logAdminChange(interaction, "Админка: защита антислив", [
        `Статус: **${before.antinukeEnabled === false ? "ВЫКЛ" : "ВКЛ"}** → **${next ? "ВКЛ" : "ВЫКЛ"}**`,
      ]).catch(() => null);
      await refreshTopic(interaction, "protect");
      return true;
    }
    if (value === "t:chbak" || value === "t:chrestore") {
      if (!(await canEditSettings(interaction))) {
        await safeReply(interaction, "Бэкап каналов может делать только владелец или Manage Server.");
        return true;
      }
      await interaction.deferUpdate();
      try {
        if (value === "t:chbak") {
          const r = await createChannelBackup(interaction.guild);
          logAdminChange(interaction, "Админка: бэкап каналов", [
            `Сохранено каналов: **${r.count}**`,
          ]).catch(() => null);
          await interaction.followUp({
            content: `Бэкап создан: **${r.count}** каналов/категорий.`,
            ephemeral: true,
          });
        } else {
          const r = await restoreChannelBackup(interaction.guild);
          if (!r.ok) {
            await interaction.followUp({ content: r.error || "Ошибка восстановления.", ephemeral: true });
          } else {
            logAdminChange(interaction, "Админка: восстановление каналов", [
              `Создано: **${r.created}** · пропущено: **${r.skipped}** · всего в бэкапе: **${r.total}**`,
            ]).catch(() => null);
            const errHint = r.errors?.length ? `\nОшибки: ${r.errors.join("; ")}` : "";
            await interaction.followUp({
              content: `Восстановление: создано **${r.created}**, уже было **${r.skipped}**.${errHint}`,
              ephemeral: true,
            });
          }
        }
      } catch (err) {
        await interaction.followUp({ content: `Ошибка: ${String(err).slice(0, 200)}`, ephemeral: true }).catch(() => null);
      }
      const payload = topicPayload(interaction.guild, "protect", uiSet(interaction, { tab: "protect" }));
      await interaction.editReply(payload).catch(() => null);
      return true;
    }
    if (value === "t:ap") {
      logAdminChange(interaction, "Админка: выбрал пункт", [
        `Раздел: **${TAB_LABELS[tab] || tab}**`,
        `Пункт: **${MENU_LABELS[value]}**`,
      ]).catch(() => null);
      await interaction.showModal(apMinutesModal(getConfig(interaction.guildId)));
      return true;
    }
    if (value.startsWith("r:") || value.startsWith("c:") || value.startsWith("u:") || value === "spam:to") {
      if (value !== "spam:to" && !(await canEditSettings(interaction))) {
        await safeReply(interaction, "Привязки может менять только владелец или участник с правом «Управлять сервером».");
        return true;
      }
      if (value === "spam:to" && !(await canSpam(interaction))) {
        await safeReply(interaction, "Нет прав на спам.");
        return true;
      }
      logAdminChange(interaction, "Админка: выбрал пункт", [
        `Раздел: **${TAB_LABELS[tab] || tab}**`,
        `Пункт: **${MENU_LABELS[value] || value}**`,
      ]).catch(() => null);
      const payload = dropPickPayload(interaction.guild, tab, value);
      if (!payload) {
        await safeReply(interaction, "Неизвестный пункт.");
        return true;
      }
      try {
        await interaction.update(payload);
      } catch {
        await interaction.followUp(payload).catch(() => null);
      }
      return true;
    }
    return true;
  }

  if (id.startsWith("c:cfg:") && !(await canEditSettings(interaction))) {
    if (!id.startsWith("c:cfg:m:")) {
      await safeReply(interaction, "Привязки может менять только владелец или участник с правом «Управлять сервером».");
      return true;
    }
  }

  if (interaction.isRoleSelectMenu() && ROLE_PATCH[id]) {
    const label = CFG_LABELS[id] || id;
    const before = getConfig(interaction.guildId);
    const patch = ROLE_PATCH[id](interaction.values);
    setConfig(interaction.guildId, patch);
    const key = Object.keys(patch)[0];
    const oldVal = before[key];
    const newVal = patch[key];
    const fmt = (v) =>
      Array.isArray(v)
        ? v.length
          ? mentionRoles(v)
          : "пусто"
        : v
          ? `<@&${v}>`
          : "пусто";
    logAdminChange(interaction, "Админка: изменил роли", [
      `Параметр: **${label}**`,
      `Было: ${fmt(oldVal)}`,
      `Стало: ${fmt(newVal)}`,
    ]).catch(() => null);
    await refreshTopic(interaction, uiGet(interaction).tab || "mods");
    return true;
  }

  if (interaction.isUserSelectMenu() && USER_PATCH[id]) {
    const label = CFG_LABELS[id] || id;
    const before = getConfig(interaction.guildId);
    const patch = USER_PATCH[id](interaction.values);
    setConfig(interaction.guildId, patch);
    const key = Object.keys(patch)[0];
    const oldVal = before[key] || [];
    const newVal = patch[key] || [];
    const fmt = (v) => (Array.isArray(v) && v.length ? v.map((x) => `<@${x}>`).join(" ") : "пусто");
    logAdminChange(interaction, "Админка: изменил whitelist людей", [
      `Параметр: **${label}**`,
      `Было: ${fmt(oldVal)}`,
      `Стало: ${fmt(newVal)}`,
    ]).catch(() => null);
    await refreshTopic(interaction, uiGet(interaction).tab || "protect");
    return true;
  }

  if (interaction.isChannelSelectMenu() && CHANNEL_PATCH[id]) {
    const label = CFG_LABELS[id] || id;
    const before = getConfig(interaction.guildId);
    const patch = CHANNEL_PATCH[id](interaction.values);
    setConfig(interaction.guildId, patch);
    const key = Object.keys(patch)[0];
    const oldVal = before[key];
    const newVal = patch[key];
    const fmt = (v) =>
      Array.isArray(v)
        ? v.length
          ? mentionChannels(v)
          : "пусто"
        : v
          ? `<#${v}>`
          : "пусто";
    logAdminChange(interaction, "Админка: изменил каналы", [
      `Параметр: **${label}**`,
      `Было: ${fmt(oldVal)}`,
      `Стало: ${fmt(newVal)}`,
    ]).catch(() => null);
    await refreshTopic(interaction, uiGet(interaction).tab || "mods");
    return true;
  }

  if (interaction.isModalSubmit() && id === "c:cfg:m:rules") {
    const text = interaction.fields.getTextInputValue("text").trim();
    setConfig(interaction.guildId, { kontraktRulesText: text });
    logAdminChange(interaction, "Админка: изменил правила контрактов", [
      `Длина текста: **${text.length}** символов`,
      `Превью: ${text.slice(0, 120) || "пусто"}${text.length > 120 ? "…" : ""}`,
    ]).catch(() => null);
    await refreshTopic(interaction, "kontr");
    return true;
  }
  if (interaction.isModalSubmit() && id === "c:cfg:m:ap") {
    const mins = Math.max(1, Number(interaction.fields.getTextInputValue("mins")) || 60);
    const before = getConfig(interaction.guildId).autoparkReserveMinutes;
    setConfig(interaction.guildId, { autoparkReserveMinutes: mins });
    logAdminChange(interaction, "Админка: изменил автопарк", [
      `Минуты брони: **${before}** → **${mins}**`,
    ]).catch(() => null);
    await refreshTopic(interaction, "cars");
    return true;
  }

  return true;
}
