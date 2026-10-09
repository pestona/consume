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
  SectionBuilder,
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
import { DEFAULT_NOVA_PANEL_TEXT, DEFAULT_WELCOME_PANEL_TEXT, MAX_NOVA_QUESTIONS, getConfig, setConfig } from "./config.js";
import {
  applicationPanel,
  buildApplicationEmbed,
  guildAcceptance,
  novaApplicationPayload,
  novaQuestions,
  refreshNovaAppPanels,
  registerNovaAppPanel,
  setGuildAcceptance,
} from "./tickets.js";
import {
  refreshWelcomePanels,
  registerWelcomePanel,
  welcomeLinkChannels,
  welcomePanelPayload,
} from "./welcome.js";
import {
  MAX_REACTION_ROLES,
  parseReactionEmoji,
  publishReactionRolePanel,
  reactionRoleItems,
  refreshReactionRolePanels,
} from "./reactionRoles.js";
import { buildMapsEmbed, mapsPanel } from "./maps.js";
import {
  buildKontraktPanelEmbed,
  kontraktAllowedInChannel,
  kontraktChannelRestrictionMessage,
  kontraktPanelRows,
} from "./kontrakt.js";
import { buildAutoparkEmbed, autoparkPanelRows, registerPanel } from "./autopark.js";
import { tempVoicePanelPayload } from "./tempVoice.js";
import { buildArchivePublicPanel } from "./archive.js";
import { afkPanelPayload, registerAfkPanel } from "./afk.js";
import { createChannelBackup, getChannelBackupMeta, restoreChannelBackup } from "./channelBackup.js";
import { canEditSettings, canModerate, canOpenPanel, canPostKontrakt, canSpam } from "./perms.js";
import { logAdminChange } from "./schedulers.js";
import {
  COLOR_BLUE,
  COLOR_DARK,
  COLOR_GREEN,
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
  return panelUi.get(uiKey(interaction)) || { tab: "mods" };
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

function v2Message(title, body, rows) {
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_DARK)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}\n${body}`));
  for (const row of rows) container.addActionRowComponents(row);
  return {
    components: [container],
    flags: V2,
  };
}

async function showPanel(interaction, payload) {
  const data = { ...payload, flags: V2 };
  try {
    if (!interaction.replied && !interaction.deferred) {
      if (interaction.isModalSubmit?.() && !interaction.message) {
        await interaction.reply(data);
        return;
      }
      await interaction.update(data);
      return;
    }
    await interaction.editReply(data);
  } catch {
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp(data);
      else await interaction.reply(data);
    } catch {
      /* ignore */
    }
  }
}

function panelLine(cfg, key, label) {
  const id = cfg.panelChannels?.[key];
  return `${label} → ${id ? `<#${id}>` : "ещё не публиковали"}`;
}

function deptSwitchAccessory(targetDept) {
  const toNova = targetDept === "nova";
  return new ButtonBuilder()
    .setCustomId(toNova ? "c:adm:dept:nova" : "c:adm:dept:5rp")
    .setLabel(toNova ? "Нова" : "5рп")
    .setStyle(ButtonStyle.Primary);
}

function dept5rpPayload(guild) {
  const cfg = getConfig(guild.id);
  const body =
    `Отдел **5рп** — заявки, машины, контракты, комнаты, архив, AFK и остальное.\n\n` +
    `${mark(cfg.ticketCategoryId)} Заявки · ${mark(cfg.autoparkManagerRoleIds?.length)} машины\n` +
    `${mark(cfg.kontraktChannelId)} Контракты · ${mark(cfg.tempVoiceCreateChannelId)} комнаты\n` +
    `${mark(cfg.archiveCategoryId)} Архив · ${mark(cfg.sborAccessRoleIds?.length || cfg.moderatorRoleIds?.length)} сбор\n` +
    `${mark(cfg.botActionLogChannelId || cfg.modLogChannelId || cfg.leaveLogChannelId)} Логи\n\n` +
    `Сборы: команда **/сбор**`;

  const container = new ContainerBuilder()
    .setAccentColor(COLOR_DARK)
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent("## 5рп"))
        .setButtonAccessory(deptSwitchAccessory("nova")),
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
    .addActionRowComponents(
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
        btn("c:adm:tab:archive", "Архив", "📁"),
        btn("c:adm:tab:protect", "Защита", "🚨", ButtonStyle.Danger),
      ),
      new ActionRowBuilder().addComponents(
        btn("c:adm:tab:summary", "Сводка", "📊"),
        btn("c:adm:tab:stats", "Статистика", "📈", ButtonStyle.Primary),
        btn("c:adm:tab:sbor", "Доступ", "🔑"),
        btn("c:adm:tab:afk", "AFK", "😴"),
        btn("c:adm:tab:autoroles", "Автороли", "🎭"),
      ),
    );

  return { components: [container], flags: V2 };
}

function deptNovaPayload(guild) {
  const cfg = getConfig(guild.id);
  const acc = guildAcceptance(guild.id);
  const body =
    `Отдел **Нова в нове** — заявки со своей категорией, ролями и гифкой.\n\n` +
    `${mark(cfg.novaTicketCategoryId)} Категория · ${mark(cfg.novaTicketStaffRoleIds?.length)} рекрутеры\n` +
    `${mark(cfg.novaAcceptRoleId)} роль принятия · ${mark(cfg.novaTicketGifUrl)} гифка\n` +
    `${mark(cfg.welcomeGifUrl || cfg.welcomePanelText)} приветствие\n` +
    `Приём: **${acc.nova ? "открыт" : "закрыт"}**`;

  const container = new ContainerBuilder()
    .setAccentColor(COLOR_DARK)
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent("## Нова в нове"))
        .setButtonAccessory(deptSwitchAccessory("5rp")),
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        btn("c:adm:tab:panels", "Панели", "📤", ButtonStyle.Primary),
        btn("c:adm:tab:apps", "Заявки", "🎫"),
        btn("c:adm:tab:welcome", "Приветствие", "👋"),
      ),
    );

  return { components: [container], flags: V2 };
}

function hubPayload(guild) {
  return dept5rpPayload(guild);
}

function novaTicketsAdminPayload(guild) {
  const cfg = getConfig(guild.id);
  const acc = guildAcceptance(guild.id);
  const gif = String(cfg.novaTicketGifUrl || "").trim();
  const days = Math.max(0, Number(cfg.novaTicketCooldownDays || 0));
  const qs = novaQuestions(cfg);
  const body =
    `Отдел настроек заявок: оформление, набор, роли и категория.\n\n` +
    `**GIF:** ${gif ? "установлен" : "не задан"}\n` +
    `**Рекрутеры:** ${mentionRoles(cfg.novaTicketStaffRoleIds)}\n` +
    `**Тег:** ${mentionRoles(cfg.novaTicketPingRoleIds)}\n` +
    `**Роль после принятия:** ${cfg.novaAcceptRoleId ? `<@&${cfg.novaAcceptRoleId}>` : "—"}\n` +
    `**Категория:** ${fmtCh(cfg.novaTicketCategoryId)}\n` +
    `**Набор:** ${acc.nova ? "открыт" : "закрыт"}\n` +
    `**Повтор после отказа:** ${days} дн.\n` +
    `**Вопросы:** ${qs.map((q) => q.label).join(" · ")}`;

  const container = new ContainerBuilder()
    .setAccentColor(COLOR_GREEN)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Тикеты\n${body}`))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        btn("c:adm:novagif", "GIF по ссылке", null, ButtonStyle.Secondary),
        btn("c:adm:novatext", "Текст панели", null, ButtonStyle.Secondary),
        btn("c:adm:novacd", "Кулдаун", null, ButtonStyle.Secondary),
        btn("c:adm:dept:nova", "Назад", null, ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(
        btn("c:adm:novaq", "Настройка вопросов", null, ButtonStyle.Primary),
        acc.nova
          ? btn("c:adm:novaacc", "Выключить набор", null, ButtonStyle.Danger)
          : btn("c:adm:novaacc", "Включить набор", null, ButtonStyle.Success),
      ),
      roleSelect(
        guild,
        "c:cfg:r:novastaff",
        "Роли рекрутера (кто принимает заявки)",
        cfg.novaTicketStaffRoleIds,
        25,
      ),
      roleSelect(guild, "c:cfg:r:novaping", "Роли тега новой заявки", cfg.novaTicketPingRoleIds, 25),
      roleSelect(
        guild,
        "c:cfg:r:novaok",
        "Роль после принятия",
        cfg.novaAcceptRoleId ? [cfg.novaAcceptRoleId] : [],
        1,
      ),
      channelSelect(
        guild,
        "c:cfg:c:novatcat",
        "Категория тикетов",
        [ChannelType.GuildCategory],
        cfg.novaTicketCategoryId ? [cfg.novaTicketCategoryId] : [],
        1,
      ),
    );

  return { components: [container], flags: V2 };
}

function topicStatus(guild, tab, ui) {
  const cfg = getConfig(guild.id);
  const acc = guildAcceptance(guild.id);

  if (tab === "panels") {
    if (ui?.dept === "nova") {
      return {
        title: "Панели · Нова в нове",
        body:
          `${panelLine(cfg, "novaApps", "Заявки")}\n` +
          `${panelLine(cfg, "welcome", "Приветствие")}\n\n` +
          "Отправка **не удаляет** прошлую панель — в канал уходит новая копия.",
        options: [
          { label: "Панель заявок", value: "pub:novaapps", emoji: "🎫", description: "Куда отправить" },
          { label: "Панель приветствия", value: "pub:welcome", emoji: "👋", description: "Куда отправить" },
        ],
        placeholder: "Какую панель отправить?",
      };
    }
    return {
      title: "Панели · 5рп",
      body:
        `${panelLine(cfg, "apps", "Заявки")}\n` +
        `${panelLine(cfg, "maps", "Карты")}\n` +
        `${panelLine(cfg, "kontrakt", "Контракты")}\n` +
        `${panelLine(cfg, "autopark", "Машины")}\n` +
        `${panelLine(cfg, "voice", "Комнаты")}\n` +
        `${panelLine(cfg, "archive", "Архив")}\n` +
        `${panelLine(cfg, "afk", "AFK / Инактив")}\n` +
        `${panelLine(cfg, "reactionRoles", "Автороли")}\n` +
        `${panelLine(cfg, "control", "Админка")}\n\n` +
        "Отправка **не удаляет** прошлую панель — в канал уходит новая копия.",
      options: [
        { label: "Панель заявок", value: "pub:apps", emoji: "🎫", description: "Куда отправить" },
        { label: "Панель карт VZP", value: "pub:maps", emoji: "🗺️", description: "Куда отправить" },
        { label: "Панель контрактов", value: "pub:kontr", emoji: "📜", description: "Куда отправить" },
        { label: "Панель автопарка", value: "pub:ap", emoji: "🚗", description: "Куда отправить" },
        { label: "Панель комнат", value: "pub:voice", emoji: "🔊", description: "Управление войсами" },
        { label: "Панель архива", value: "pub:archive", emoji: "📁", description: "Создание каналов" },
        { label: "Панель AFK / Инактив", value: "pub:afk", emoji: "😴", description: "Куда отправить" },
        { label: "Панель авторолей", value: "pub:reactionroles", emoji: "🎭", description: "Роли по реакциям" },
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
        `Пинг при выходе: ${cfg.leaveLogPingRoleId ? `<@&${cfg.leaveLogPingRoleId}>` : "—"}\n` +
        `Отслеживаемые роли выхода: ${mentionRoles(cfg.leaveLogTrackRoleIds) || "—"}\n` +
        `Выход без ролей: **${cfg.leaveLogIncludeNoRoles === false ? "нет" : "да"}**\n\n` +
        "Каналы логов по типу событий.",
      options: [
        { label: "Лог действий бота", value: "c:log", emoji: "📋", description: "Админка / команды" },
        { label: "Лог банов и киков", value: "c:modlog", emoji: "🔨", description: "Модерация" },
        { label: "Лог выхода", value: "c:leavelog", emoji: "👋", description: "Кто вышел + роли" },
        { label: "Пинг при выходе", value: "r:leaveping", emoji: "📣", description: "Опционально" },
        { label: "Роли для лога выхода", value: "r:leavetrack", emoji: "👀", description: "Только эти роли" },
        {
          label: cfg.leaveLogIncludeNoRoles === false ? "Вкл: выход без ролей" : "Выкл: выход без ролей",
          value: "t:leavenoroles",
          emoji: "👤",
          description: "Писать лив без ролей",
        },
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
  if (tab === "archive") {
    const modsLabel = cfg.archiveModRoleIds?.length
      ? mentionRoles(cfg.archiveModRoleIds)
      : "как у тикетов";
    return {
      title: "Настройка архива",
      body:
        `Выбери пункт ниже и укажи роль / категорию.\n\n` +
        `**Категория:** ${cfg.archiveCategoryId ? fmtCh(cfg.archiveCategoryId) : "❌ не задана"}\n` +
        `**Модераторы:** ${modsLabel}\n` +
        `**Тир 1:** ${cfg.archiveTier1RoleId ? `<@&${cfg.archiveTier1RoleId}>` : "❌ не задана"}\n` +
        `**Тир 2:** ${cfg.archiveTier2RoleId ? `<@&${cfg.archiveTier2RoleId}>` : "❌ не задана"}\n` +
        `**Тир 3:** ${cfg.archiveTier3RoleId ? `<@&${cfg.archiveTier3RoleId}>` : "❌ не задана"}\n` +
        `**Низкий ранг:** ${cfg.archiveRankLowRoleId ? `<@&${cfg.archiveRankLowRoleId}>` : "❌ не задана"}\n` +
        `**Высокий ранг:** ${cfg.archiveRankHighRoleId ? `<@&${cfg.archiveRankHighRoleId}>` : "❌ не задана"}\n` +
        `**Цепочка рангов:** ${cfg.archiveRankChainRoleIds?.length ? mentionRoles(cfg.archiveRankChainRoleIds) : "❌ не задана"}\n\n` +
        `${panelLine(cfg, "archive", "Панель создания")}`,
      options: [
        { label: "Категория", value: "c:archcat", emoji: "📁", description: "Где создавать каналы" },
        { label: "Модераторы", value: "r:archmod", emoji: "🛡️", description: "Пусто = как у тикетов" },
        { label: "Тир 1", value: "r:archt1", emoji: "🥇", description: "Роль тира 1" },
        { label: "Тир 2", value: "r:archt2", emoji: "🥈", description: "Роль тира 2" },
        { label: "Тир 3", value: "r:archt3", emoji: "🥉", description: "Роль тира 3" },
        { label: "Низкий ранг", value: "r:archlow", emoji: "↘️", description: "Начало цепочки" },
        { label: "Высокий ранг", value: "r:archhigh", emoji: "↗️", description: "Конец цепочки" },
        { label: "Цепочка рангов", value: "r:archchain", emoji: "🔗", description: "Порядок от низкого к высокому" },
      ],
      placeholder: "Выбрать что настроить",
    };
  }
  if (tab === "afk") {
    return {
      title: "AFK / Инактив",
      body:
        `Роль инактива: ${cfg.afkInactiveRoleId ? `<@&${cfg.afkInactiveRoleId}>` : "❌ не задана"}\n` +
        `${panelLine(cfg, "afk", "Панель")}\n\n` +
        "**AFK** — только список, роли и ник не трогаем.\n" +
        "**Инактив** — снимаем роли, выдаём роль инактива, ник → дата окончания.\n" +
        "По выходу / по сроку — роли и ник возвращаются.\n\n" +
        "Панель: **/panel → Панели → AFK / Инактив**.",
      options: [
        { label: "Роль инактива", value: "r:afkinact", emoji: "😴", description: "Единственная роль на время инактива" },
      ],
      placeholder: "Что настроить?",
    };
  }
  if (tab === "mods") {
    return {
      title: "Модераторы бота",
      body:
        `Сейчас: ${mentionRoles(cfg.moderatorRoleIds) || "не заданы"}\n\n` +
        "Кто может открывать админку (кроме владельца и Manage Server).",
      options: [{ label: "Роли модераторов", value: "r:mod", emoji: "🛡️", description: "Доступ к панели" }],
      placeholder: "Кто модератор бота?",
    };
  }
  if (tab === "sbor") {
    const access = cfg.sborAccessRoleIds?.length
      ? mentionRoles(cfg.sborAccessRoleIds)
      : "как у модераторов бота";
    return {
      title: "Доступ к сбору",
      body:
        `Роли **/сбор**: ${access}\n\n` +
        "Кто может создавать сбор, жать кнопки и ставить ✅/🔥.\n" +
        "Пустой выбор = как роли модераторов бота. Владелец / Manage Server — всегда.",
      options: [
        { label: "Роли доступа к сбору", value: "r:sboraccess", emoji: "🔑", description: "Кто может /сбор" },
      ],
      placeholder: "Что настроить?",
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
        `Модераторы бота: ${roleOrEmpty(cfg.moderatorRoleIds)}\n` +
        `Доступ к сбору: ${roleOrEmpty(cfg.sborAccessRoleIds) || "как модераторы"}\n\n` +
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
        `Пинг выхода: ${cfg.leaveLogPingRoleId ? `<@&${cfg.leaveLogPingRoleId}>` : "—"}\n` +
        `Роли выхода: ${roleOrEmpty(cfg.leaveLogTrackRoleIds)}\n` +
        `Без ролей: ${cfg.leaveLogIncludeNoRoles === false ? "нет" : "да"}\n\n` +
        `**Комнаты**\n` +
        `Роли семьи: ${roleOrEmpty(cfg.familyRoleIds)}\n` +
        `Создать комнату: ${fmtCh(cfg.tempVoiceCreateChannelId)}\n` +
        `Категория: ${fmtCh(cfg.tempVoiceCategoryId)}\n\n` +
        `**Архив**\n` +
        `Категория: ${fmtCh(cfg.archiveCategoryId)}\n` +
        `Модераторы: ${roleOrEmpty(cfg.archiveModRoleIds) || "как у тикетов"}\n` +
        `Тиры: ${[cfg.archiveTier1RoleId, cfg.archiveTier2RoleId, cfg.archiveTier3RoleId].filter(Boolean).map((id) => `<@&${id}>`).join(" ") || "—"}\n` +
        `Ранги: ${cfg.archiveRankChainRoleIds?.length ? roleOrEmpty(cfg.archiveRankChainRoleIds) : [cfg.archiveRankLowRoleId, cfg.archiveRankHighRoleId].filter(Boolean).map((id) => `<@&${id}>`).join(" ") || "—"}\n\n` +
        `**AFK / Инактив**\n` +
        `Роль инактива: ${cfg.afkInactiveRoleId ? `<@&${cfg.afkInactiveRoleId}>` : "—"}\n\n` +
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
        `${panelLine(cfg, "archive", "Архив")}\n` +
        `${panelLine(cfg, "afk", "AFK / Инактив")}\n` +
        `${panelLine(cfg, "control", "Админка")}`,
      options: [{ label: "Обновить сводку", value: "t:refresh", emoji: "🔄", description: "Перечитать привязки" }],
      placeholder: "Обновить сводку",
    };
  }
  return { title: "Админка", body: "Выбери раздел на главной.", options: [], placeholder: "…" };
}

function topicPayload(guild, tab, ui) {
  if (tab === "novaq") return novaQuestionsEditorPayload(guild, ui);
  if (tab === "welcome") return welcomeAdminPayload(guild);
  if (tab === "autoroles") return reactionRolesAdminPayload(guild);
  if (tab === "apps" && ui?.dept === "nova") return novaTicketsAdminPayload(guild);
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
  const homeId = ui?.dept === "nova" ? "c:adm:dept:nova" : "c:adm:dept:5rp";
  rows.push(
    new ActionRowBuilder().addComponents(btn(homeId, "← Назад", null, ButtonStyle.Secondary)),
  );
  return v2Message(t.title, t.body, rows);
}

const PICK_META = {
  "r:mod": { kind: "role", selectId: "c:cfg:r:mod", title: "Модераторы бота", max: 25, key: "moderatorRoleIds" },
  "r:sboraccess": { kind: "role", selectId: "c:cfg:r:sboraccess", title: "Доступ к /сбор", max: 25, key: "sborAccessRoleIds" },
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
  "r:leavetrack": { kind: "role", selectId: "c:cfg:r:leavetrack", title: "Роли для лога выхода", max: 25, key: "leaveLogTrackRoleIds" },
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
  "c:archcat": {
    kind: "channel",
    selectId: "c:cfg:c:archcat",
    title: "Категория архива",
    types: [ChannelType.GuildCategory],
    max: 1,
    key: "archiveCategoryId",
    single: true,
  },
  "r:archmod": { kind: "role", selectId: "c:cfg:r:archmod", title: "Модераторы архива", max: 25, key: "archiveModRoleIds" },
  "r:archt1": { kind: "role", selectId: "c:cfg:r:archt1", title: "Тир 1", max: 1, key: "archiveTier1RoleId", single: true },
  "r:archt2": { kind: "role", selectId: "c:cfg:r:archt2", title: "Тир 2", max: 1, key: "archiveTier2RoleId", single: true },
  "r:archt3": { kind: "role", selectId: "c:cfg:r:archt3", title: "Тир 3", max: 1, key: "archiveTier3RoleId", single: true },
  "r:archlow": { kind: "role", selectId: "c:cfg:r:archlow", title: "Низкий ранг", max: 1, key: "archiveRankLowRoleId", single: true },
  "r:archhigh": { kind: "role", selectId: "c:cfg:r:archhigh", title: "Высокий ранг", max: 1, key: "archiveRankHighRoleId", single: true },
  "r:archchain": { kind: "role", selectId: "c:cfg:r:archchain", title: "Цепочка рангов (низ → верх)", max: 25, key: "archiveRankChainRoleIds" },
  "r:afkinact": { kind: "role", selectId: "c:cfg:r:afkinact", title: "Роль инактива", max: 1, key: "afkInactiveRoleId", single: true },
  "c:novatcat": {
    kind: "channel",
    selectId: "c:cfg:c:novatcat",
    title: "Категория тикетов Нова",
    types: [ChannelType.GuildCategory],
    max: 1,
    key: "novaTicketCategoryId",
    single: true,
  },
  "r:novastaff": { kind: "role", selectId: "c:cfg:r:novastaff", title: "Роли рекрутера Нова", max: 25, key: "novaTicketStaffRoleIds" },
  "r:novaping": { kind: "role", selectId: "c:cfg:r:novaping", title: "Роли тега Нова", max: 25, key: "novaTicketPingRoleIds" },
  "r:novaok": { kind: "role", selectId: "c:cfg:r:novaok", title: "Роль после принятия", max: 1, key: "novaAcceptRoleId", single: true },
};

const PANEL_LABELS = {
  apps: "Заявки",
  novaapps: "Заявки Нова",
  welcome: "Приветствие",
  reactionroles: "Автороли",
  maps: "Карты VZP",
  kontr: "Контракты",
  ap: "Автопарк",
  voice: "Комнаты",
  archive: "Архив",
  afk: "AFK / Инактив",
  control: "Админка",
};

function panelChannelKey(kind) {
  if (kind === "kontr") return "kontrakt";
  if (kind === "ap") return "autopark";
  if (kind === "novaapps") return "novaApps";
  if (kind === "reactionroles") return "reactionRoles";
  return kind;
}

function dropPickPayload(guild, tab, value) {
  const cfg = getConfig(guild.id);
  const back = new ActionRowBuilder().addComponents(btn(`c:adm:back:${tab}`, "← Назад", null, ButtonStyle.Secondary));

  if (value.startsWith("pub:")) {
    const kind = value.slice(4);
    const label = PANEL_LABELS[kind] || kind;
    const lastId = cfg.panelChannels?.[panelChannelKey(kind)];
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
  return v2Message(meta.title, "Выбери ниже. Пустой выбор = сброс.", [row, back]);
}

async function openDept(interaction, dept) {
  let payload;
  let ui;
  if (dept === "nova") {
    ui = uiSet(interaction, { dept: "nova", tab: "panels" });
    payload = deptNovaPayload(interaction.guild);
  } else {
    ui = uiSet(interaction, { dept: "5rp", tab: "summary" });
    payload = dept5rpPayload(interaction.guild);
  }
  setConfig(interaction.guildId, { adminHubDept: dept === "nova" ? "nova" : "5rp" });
  await showPanel(interaction, payload);
  return ui;
}

async function openTopic(interaction, tab) {
  const ui = uiSet(interaction, { tab });
  await showPanel(interaction, topicPayload(interaction.guild, tab, ui));
}

async function refreshTopic(interaction, tab) {
  const ui = uiSet(interaction, { tab });
  await showPanel(interaction, topicPayload(interaction.guild, tab, ui));
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

function novaGifModal(cfg) {
  return new ModalBuilder()
    .setCustomId("c:cfg:m:novagif")
    .setTitle("Гифка панели заявок")
    .addComponents(
      new ActionRowBuilder().addComponents(
        maybeValue(
          new TextInputBuilder()
            .setCustomId("url")
            .setLabel("Ссылка на gif/png/jpg")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(400)
            .setRequired(false)
            .setPlaceholder("https://... .gif  (пусто = убрать)"),
          cfg.novaTicketGifUrl,
        ),
      ),
    );
}

function novaPanelTextModal(cfg) {
  return new ModalBuilder()
    .setCustomId("c:cfg:m:novatext")
    .setTitle("Текст панели заявок")
    .addComponents(
      new ActionRowBuilder().addComponents(
        maybeValue(
          new TextInputBuilder()
            .setCustomId("text")
            .setLabel("Текст ({cooldown} и {status})")
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(3500)
            .setRequired(true)
            .setPlaceholder("Пустой текст вернёт стандартный."),
          cfg.novaTicketPanelText || DEFAULT_NOVA_PANEL_TEXT,
        ),
      ),
    );
}

function welcomeAdminPayload(guild) {
  const cfg = getConfig(guild.id);
  const gif = String(cfg.welcomeGifUrl || "").trim();
  const links = welcomeLinkChannels(cfg);
  const body =
    `Оформление панели приветствия: гифка, текст и ссылки на заявки.\n\n` +
    `**GIF:** ${gif ? "установлен" : "не задан"}\n` +
    `**Nova RP:** ${fmtCh(links.nova)}\n` +
    `**5 RP:** ${fmtCh(links.rp)}\n` +
    `${panelLine(cfg, "welcome", "Панель")}\n\n` +
    "В тексте панели: `{nova}` и `{5rp}` — подставятся каналы заявок.";

  const container = new ContainerBuilder()
    .setAccentColor(COLOR_BLUE)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Приветствие\n${body}`))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        btn("c:adm:welgif", "GIF по ссылке", null, ButtonStyle.Secondary),
        btn("c:adm:weltext", "Текст панели", null, ButtonStyle.Secondary),
        btn("c:adm:welsend", "Отправить панель", null, ButtonStyle.Primary),
        btn("c:adm:dept:nova", "Назад", null, ButtonStyle.Secondary),
      ),
      channelSelect(
        guild,
        "c:cfg:c:welnnova",
        "Канал заявок Nova RP",
        TEXT_TYPES,
        cfg.welcomeNovaLinkChannelId ? [cfg.welcomeNovaLinkChannelId] : [],
        1,
      ),
      channelSelect(
        guild,
        "c:cfg:c:welrp",
        "Канал заявок 5 RP",
        TEXT_TYPES,
        cfg.welcomeRpLinkChannelId ? [cfg.welcomeRpLinkChannelId] : [],
        1,
      ),
    );

  return { components: [container], flags: V2 };
}

function welcomeGifModal(cfg) {
  return new ModalBuilder()
    .setCustomId("c:cfg:m:welgif")
    .setTitle("Гифка приветствия")
    .addComponents(
      new ActionRowBuilder().addComponents(
        maybeValue(
          new TextInputBuilder()
            .setCustomId("url")
            .setLabel("Ссылка на gif/png/jpg")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(400)
            .setRequired(false)
            .setPlaceholder("https://... .gif  (пусто = убрать)"),
          cfg.welcomeGifUrl,
        ),
      ),
    );
}

function welcomeTextModal(cfg) {
  return new ModalBuilder()
    .setCustomId("c:cfg:m:weltext")
    .setTitle("Текст приветствия")
    .addComponents(
      new ActionRowBuilder().addComponents(
        maybeValue(
          new TextInputBuilder()
            .setCustomId("text")
            .setLabel("Текст ({nova} и {5rp})")
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(3500)
            .setRequired(true)
            .setPlaceholder("Пустой текст вернёт стандартный."),
          cfg.welcomePanelText || DEFAULT_WELCOME_PANEL_TEXT,
        ),
      ),
    );
}

function reactionRolesAdminPayload(guild) {
  const cfg = getConfig(guild.id);
  const items = reactionRoleItems(cfg);
  const lines = items.map(
    (item, index) =>
      `${index + 1}. ${item.emoji} → <@&${item.roleId}>${item.label ? ` · ${item.label}` : ""}`,
  );
  const body =
    `Роль выдаётся при добавлении реакции и снимается при её удалении.\n` +
    `Бот должен стоять **выше выдаваемых ролей**.\n\n` +
    `${lines.length ? lines.join("\n") : "Автороли пока не добавлены."}\n\n` +
    `${panelLine(cfg, "reactionRoles", "Панель")} · **${items.length}/${MAX_REACTION_ROLES}**`;

  const rows = [
    new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId("c:cfg:r:rradd")
        .setPlaceholder("Добавить роль")
        .setMinValues(1)
        .setMaxValues(1),
    ),
  ];
  if (items.length) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("c:adm:rrdel")
          .setPlaceholder("Удалить связку")
          .addOptions(
            items.map((item, index) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(`${item.emoji} ${item.label || guild.roles.cache.get(item.roleId)?.name || item.roleId}`.slice(0, 100))
                .setValue(String(index))
                .setDescription(`Роль: ${guild.roles.cache.get(item.roleId)?.name || item.roleId}`.slice(0, 100)),
            ),
          ),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId("c:adm:send:reactionroles")
        .setPlaceholder("Отправить панель в канал")
        .setMinValues(1)
        .setMaxValues(1)
        .setChannelTypes(...TEXT_TYPES),
    ),
    new ActionRowBuilder().addComponents(
      btn("c:adm:dept:5rp", "← Назад", null, ButtonStyle.Secondary),
    ),
  );
  return v2Message("Автороли", body, rows);
}

function reactionRoleModal(role) {
  return new ModalBuilder()
    .setCustomId("c:cfg:m:rradd")
    .setTitle("Добавить автороль")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("emoji")
          .setLabel("Эмодзи реакции")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true)
          .setPlaceholder("✅ или <:название:ID>"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("label")
          .setLabel("Подпись роли")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(80)
          .setRequired(false)
          .setPlaceholder(role?.name || "Название"),
      ),
    );
}

function novaCooldownModal(cfg) {
  return new ModalBuilder()
    .setCustomId("c:cfg:m:novacd")
    .setTitle("Кулдаун после отказа")
    .addComponents(
      new ActionRowBuilder().addComponents(
        maybeValue(
          new TextInputBuilder()
            .setCustomId("days")
            .setLabel("Дней до повторной заявки (0 = нет)")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(3)
            .setRequired(true)
            .setPlaceholder("0"),
          String(Math.max(0, Number(cfg.novaTicketCooldownDays || 0))),
        ),
      ),
    );
}

function novaQuestionIndex(ui, qs) {
  const n = qs.length;
  if (!n) return 0;
  const i = Number(ui?.novaQIndex);
  if (!Number.isInteger(i) || i < 0) return 0;
  return Math.min(i, n - 1);
}

function dumpNovaQuestions(qs) {
  return qs.map((q) => ({
    label: q.label,
    placeholder: q.placeholder || "",
    long: Boolean(q.long),
  }));
}

function parseLongFlag(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return false;
  return /^(да|yes|y|1|long|длин|paragraph)/i.test(s);
}

function novaQuestionFormModal(mode, q) {
  const edit = mode === "edit";
  return new ModalBuilder()
    .setCustomId(edit ? "c:cfg:m:novaqedit" : "c:cfg:m:novaqadd")
    .setTitle(edit ? "Изменить вопрос" : "Добавить вопрос")
    .addComponents(
      new ActionRowBuilder().addComponents(
        maybeValue(
          new TextInputBuilder()
            .setCustomId("label")
            .setLabel("Название вопроса")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(45)
            .setRequired(true)
            .setPlaceholder("Например: Возраст"),
          q?.label,
        ),
      ),
      new ActionRowBuilder().addComponents(
        maybeValue(
          new TextInputBuilder()
            .setCustomId("placeholder")
            .setLabel("Подсказка в поле")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(100)
            .setRequired(false)
            .setPlaceholder("Например: 18"),
          q?.placeholder,
        ),
      ),
      new ActionRowBuilder().addComponents(
        maybeValue(
          new TextInputBuilder()
            .setCustomId("long")
            .setLabel("Длинный ответ? (да/нет)")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(12)
            .setRequired(true)
            .setPlaceholder("нет"),
          q?.long ? "да" : "нет",
        ),
      ),
    );
}

function novaQuestionsEditorPayload(guild, ui) {
  const cfg = getConfig(guild.id);
  const qs = novaQuestions(cfg);
  const selected = novaQuestionIndex(ui, qs);
  const cur = qs[selected];
  const lines = qs.map((q, i) => {
    const mark = i === selected ? "→" : "•";
    const kind = q.long ? "длинный" : "короткий";
    const hint = q.placeholder ? ` · ${q.placeholder}` : "";
    return `${mark} **${i + 1}. ${q.label}** — ${kind}${hint}`;
  });
  const body =
    `В анкете можно держать от **1** до **${MAX_NOVA_QUESTIONS}** вопросов.\n` +
    `Выбери вопрос в списке, затем измени, удали или подвинь.\n\n` +
    `${lines.join("\n")}\n\n` +
    `Выбран: **${cur?.label || "—"}**`;

  const pick = new StringSelectMenuBuilder()
    .setCustomId("c:adm:novaqpick")
    .setPlaceholder("Выберите вопрос")
    .addOptions(
      qs.map((q, i) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${i + 1}. ${q.label}`.slice(0, 100))
          .setValue(String(i))
          .setDescription(
            `${q.long ? "длинный" : "короткий"}${q.placeholder ? ` · ${q.placeholder}` : ""}`.slice(0, 100),
          )
          .setDefault(i === selected),
      ),
    );

  const addBtn = btn("c:adm:novaqadd", "Добавить", null, ButtonStyle.Success);
  if (qs.length >= MAX_NOVA_QUESTIONS) addBtn.setDisabled(true);
  const editBtn = btn("c:adm:novaqedit", "Изменить", null, ButtonStyle.Primary);
  const delBtn = btn("c:adm:novaqdel", "Удалить", null, ButtonStyle.Danger);
  if (qs.length <= 1) delBtn.setDisabled(true);
  const upBtn = btn("c:adm:novaqup", "Выше", null, ButtonStyle.Secondary);
  if (selected <= 0) upBtn.setDisabled(true);
  const downBtn = btn("c:adm:novaqdn", "Ниже", null, ButtonStyle.Secondary);
  if (selected >= qs.length - 1) downBtn.setDisabled(true);

  return v2Message("Вопросы заявки", body, [
    new ActionRowBuilder().addComponents(pick),
    new ActionRowBuilder().addComponents(addBtn, editBtn, delBtn),
    new ActionRowBuilder().addComponents(
      upBtn,
      downBtn,
      btn("c:adm:novaqback", "Назад", null, ButtonStyle.Secondary),
    ),
  ]);
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
    adminHubDept: cfg.adminHubDept === "nova" ? "nova" : "5rp",
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
  setConfig(interaction.guild.id, { adminHubDept: "5rp" });
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
  "c:cfg:r:sboraccess": (v) => ({ sborAccessRoleIds: v }),
  "c:cfg:r:spam": (v) => ({ spamCommandRoleIds: v }),
  "c:cfg:r:apmgr": (v) => ({ autoparkManagerRoleIds: v }),
  "c:cfg:r:kpost": (v) => ({ kontraktPostRoleIds: v }),
  "c:cfg:r:kmgr": (v) => ({ kontraktManagerRoleIds: v }),
  "c:cfg:r:kping": (v) => ({ kontraktNewContractPingRoleIds: v }),
  "c:cfg:r:family": (v) => ({ familyRoleIds: v }),
  "c:cfg:r:leaveping": (v) => ({ leaveLogPingRoleId: v[0] || null }),
  "c:cfg:r:leavetrack": (v) => ({ leaveLogTrackRoleIds: v }),
  "c:cfg:r:anrole": (v) => ({ antinukeWhitelistRoleIds: v }),
  "c:cfg:r:archmod": (v) => ({ archiveModRoleIds: v }),
  "c:cfg:r:archt1": (v) => ({ archiveTier1RoleId: v[0] || null }),
  "c:cfg:r:archt2": (v) => ({ archiveTier2RoleId: v[0] || null }),
  "c:cfg:r:archt3": (v) => ({ archiveTier3RoleId: v[0] || null }),
  "c:cfg:r:archlow": (v) => ({ archiveRankLowRoleId: v[0] || null }),
  "c:cfg:r:archhigh": (v) => ({ archiveRankHighRoleId: v[0] || null }),
  "c:cfg:r:archchain": (v) => ({ archiveRankChainRoleIds: v }),
  "c:cfg:r:afkinact": (v) => ({ afkInactiveRoleId: v[0] || null }),
  "c:cfg:r:novastaff": (v) => ({ novaTicketStaffRoleIds: v }),
  "c:cfg:r:novaping": (v) => ({ novaTicketPingRoleIds: v }),
  "c:cfg:r:novaok": (v) => ({ novaAcceptRoleId: v[0] || null }),
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
  "c:cfg:c:archcat": (v) => ({ archiveCategoryId: v[0] || null }),
  "c:cfg:c:novatcat": (v) => ({ novaTicketCategoryId: v[0] || null }),
  "c:cfg:c:welnnova": (v) => ({ welcomeNovaLinkChannelId: v[0] || null }),
  "c:cfg:c:welrp": (v) => ({ welcomeRpLinkChannelId: v[0] || null }),
};

const CFG_LABELS = {
  "c:cfg:r:staff": "Стафф тикетов",
  "c:cfg:r:tping": "Пинг новой заявки",
  "c:cfg:r:acad": "Роли академии",
  "c:cfg:r:main": "Роли основы",
  "c:cfg:r:mod": "Модераторы бота",
  "c:cfg:r:sboraccess": "Доступ к /сбор",
  "c:cfg:r:spam": "Кто может спамить",
  "c:cfg:r:apmgr": "Менеджеры автопарка",
  "c:cfg:r:kpost": "Публикация контрактов",
  "c:cfg:r:kmgr": "Пикнул / Отказ",
  "c:cfg:r:kping": "Пинг нового контракта",
  "c:cfg:r:family": "Роли семьи Consume",
  "c:cfg:r:leaveping": "Пинг при выходе",
  "c:cfg:r:leavetrack": "Роли для лога выхода",
  "c:cfg:r:anrole": "Whitelist роли антислив",
  "c:cfg:u:anuser": "Whitelist люди антислив",
  "c:cfg:c:tcat": "Категория тикетов",
  "c:cfg:c:log": "Канал логов",
  "c:cfg:c:modlog": "Лог банов/киков",
  "c:cfg:c:leavelog": "Лог выхода",
  "c:cfg:c:tvcreate": "Войс создать комнату",
  "c:cfg:c:tvcat": "Категория комнат",
  "c:cfg:c:kontr": "Канал контрактов",
  "c:cfg:c:archcat": "Категория архива",
  "c:cfg:r:archmod": "Модераторы архива",
  "c:cfg:r:archt1": "Тир 1",
  "c:cfg:r:archt2": "Тир 2",
  "c:cfg:r:archt3": "Тир 3",
  "c:cfg:r:archlow": "Низкий ранг",
  "c:cfg:r:archhigh": "Высокий ранг",
  "c:cfg:r:archchain": "Цепочка рангов",
  "c:cfg:r:afkinact": "Роль инактива",
  "c:cfg:c:novatcat": "Категория тикетов Нова",
  "c:cfg:c:welnnova": "Канал заявок Nova RP",
  "c:cfg:c:welrp": "Канал заявок 5 RP",
  "c:cfg:r:novastaff": "Роли рекрутера Нова",
  "c:cfg:r:novaping": "Роли тега Нова",
  "c:cfg:r:novaok": "Роль после принятия Нова",
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
  "r:sboraccess": "Роли доступа к сбору",
  "t:rpacc": "Вкл/выкл приём РП",
  "t:vzpacc": "Вкл/выкл приём VZP",
  "r:family": "Роли семьи",
  "c:tvcreate": "Войс создать комнату",
  "c:tvcat": "Категория комнат",
  "c:modlog": "Лог банов/киков",
  "c:leavelog": "Лог выхода",
  "r:leaveping": "Пинг при выходе",
  "r:leavetrack": "Роли для лога выхода",
  "t:leavenoroles": "Выход без ролей",
  "t:antinuke": "Вкл/выкл защиту",
  "t:chbak": "Создать бэкап каналов",
  "t:chrestore": "Восстановить каналы",
  "r:anrole": "Whitelist роли",
  "u:anuser": "Whitelist люди",
  "pub:apps": "Отправить панель заявок",
  "pub:novaapps": "Отправить панель заявок Нова",
  "pub:welcome": "Отправить панель приветствия",
  "pub:reactionroles": "Отправить панель авторолей",
  "c:novatcat": "Категория тикетов Нова",
  "r:novastaff": "Роли рекрутера Нова",
  "r:novaping": "Роли тега Нова",
  "r:novaok": "Роль после принятия Нова",
  "t:novagif": "Гифка панели заявок",
  "t:novaacc": "Вкл/выкл приём Нова",
  "pub:maps": "Отправить панель карт",
  "pub:kontr": "Отправить панель контрактов",
  "pub:ap": "Отправить панель автопарка",
  "pub:voice": "Отправить панель комнат",
  "pub:archive": "Отправить панель архива",
  "pub:afk": "Отправить панель AFK / Инактив",
  "pub:control": "Отправить админку",
  "c:archcat": "Категория архива",
  "r:archmod": "Модераторы архива",
  "r:archt1": "Тир 1",
  "r:archt2": "Тир 2",
  "r:archt3": "Тир 3",
  "r:archlow": "Низкий ранг",
  "r:archhigh": "Высокий ранг",
  "r:archchain": "Цепочка рангов",
  "r:afkinact": "Роль инактива",
};

const TAB_LABELS = {
  panels: "Панели",
  apps: "Заявки",
  cars: "Машины",
  kontr: "Контракты",
  spam: "Спам",
  logs: "Логи",
  mods: "Модераторы",
  sbor: "Доступ",
  rooms: "Комнаты",
  archive: "Архив",
  welcome: "Приветствие",
  autoroles: "Автороли",
  afk: "AFK / Инактив",
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
    } else if (kind === "novaapps") {
      const msg = await ch.send(novaApplicationPayload(interaction.guild.id));
      registerNovaAppPanel(interaction.guild.id, ch.id, msg.id);
      rememberPanelChannel(interaction.guild.id, "novaApps", ch.id);
    } else if (kind === "welcome") {
      const msg = await ch.send(welcomePanelPayload(interaction.guild.id));
      registerWelcomePanel(interaction.guild.id, ch.id, msg.id);
      rememberPanelChannel(interaction.guild.id, "welcome", ch.id);
    } else if (kind === "reactionroles") {
      await publishReactionRolePanel(ch, interaction.guild.id);
      rememberPanelChannel(interaction.guild.id, "reactionRoles", ch.id);
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
    } else if (kind === "archive") {
      await ch.send(buildArchivePublicPanel());
      rememberPanelChannel(interaction.guild.id, "archive", ch.id);
    } else if (kind === "afk") {
      const msg = await ch.send(afkPanelPayload(interaction.guild.id));
      registerAfkPanel(interaction.guild.id, ch.id, msg.id);
      rememberPanelChannel(interaction.guild.id, "afk", ch.id);
    } else if (kind === "control") {
      const payload = hubPayload(interaction.guild);
      const msg = await ch.send(payload);
      rememberHub(interaction.guild.id, ch.id, msg.id);
    } else {
      await safeReply(interaction, "Неизвестная панель.");
      return false;
    }
  } catch (err) {
    const text = String(err?.message || "");
    await safeReply(
      interaction,
      text.startsWith("Сначала ")
        ? text
        : `Не удалось отправить в ${ch}. Проверьте права бота и доступ к эмодзи.`,
    );
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

  if (interaction.isButton() && id === "c:adm:novagif") {
    uiSet(interaction, { dept: "nova", tab: "apps" });
    logAdminChange(interaction, "Админка: выбрал пункт", ["GIF по ссылке"]).catch(() => null);
    await interaction.showModal(novaGifModal(getConfig(interaction.guildId)));
    return true;
  }
  if (interaction.isButton() && id === "c:adm:novatext") {
    uiSet(interaction, { dept: "nova", tab: "apps" });
    logAdminChange(interaction, "Админка: выбрал пункт", ["Текст панели"]).catch(() => null);
    await interaction.showModal(novaPanelTextModal(getConfig(interaction.guildId)));
    return true;
  }
  if (interaction.isButton() && id === "c:adm:novacd") {
    uiSet(interaction, { dept: "nova", tab: "apps" });
    logAdminChange(interaction, "Админка: выбрал пункт", ["Кулдаун"]).catch(() => null);
    await interaction.showModal(novaCooldownModal(getConfig(interaction.guildId)));
    return true;
  }
  if (interaction.isButton() && id === "c:adm:welgif") {
    uiSet(interaction, { dept: "nova", tab: "welcome" });
    logAdminChange(interaction, "Админка: выбрал пункт", ["GIF приветствия"]).catch(() => null);
    await interaction.showModal(welcomeGifModal(getConfig(interaction.guildId)));
    return true;
  }
  if (interaction.isButton() && id === "c:adm:weltext") {
    uiSet(interaction, { dept: "nova", tab: "welcome" });
    logAdminChange(interaction, "Админка: выбрал пункт", ["Текст приветствия"]).catch(() => null);
    await interaction.showModal(welcomeTextModal(getConfig(interaction.guildId)));
    return true;
  }
  if (interaction.isButton() && id === "c:adm:welsend") {
    uiSet(interaction, { dept: "nova", tab: "welcome" });
    logAdminChange(interaction, "Админка: выбрал пункт", ["Отправить панель приветствия"]).catch(() => null);
    await showPanel(interaction, dropPickPayload(interaction.guild, "welcome", "pub:welcome"));
    return true;
  }
  if (interaction.isButton() && id === "c:adm:novaq") {
    const ui = uiSet(interaction, { dept: "nova", tab: "novaq", novaQIndex: 0 });
    logAdminChange(interaction, "Админка: выбрал пункт", ["Настройка вопросов"]).catch(() => null);
    await showPanel(interaction, novaQuestionsEditorPayload(interaction.guild, ui));
    return true;
  }
  if (interaction.isStringSelectMenu() && id === "c:adm:novaqpick") {
    const ui = uiSet(interaction, { dept: "nova", tab: "novaq", novaQIndex: Number(interaction.values[0]) || 0 });
    await showPanel(interaction, novaQuestionsEditorPayload(interaction.guild, ui));
    return true;
  }
  if (interaction.isButton() && id === "c:adm:novaqback") {
    uiSet(interaction, { dept: "nova", tab: "apps" });
    await refreshTopic(interaction, "apps");
    return true;
  }
  if (interaction.isButton() && id === "c:adm:novaqadd") {
    const qs = novaQuestions(getConfig(interaction.guildId));
    if (qs.length >= MAX_NOVA_QUESTIONS) {
      await safeReply(interaction, `Максимум ${MAX_NOVA_QUESTIONS} вопросов — лимит формы Discord.`);
      return true;
    }
    uiSet(interaction, { dept: "nova", tab: "novaq" });
    await interaction.showModal(novaQuestionFormModal("add", { label: "", placeholder: "", long: false }));
    return true;
  }
  if (interaction.isButton() && id === "c:adm:novaqedit") {
    const cfg = getConfig(interaction.guildId);
    const qs = novaQuestions(cfg);
    const idx = novaQuestionIndex(uiGet(interaction), qs);
    const q = qs[idx];
    if (!q) {
      await safeReply(interaction, "Сначала выберите вопрос в списке.");
      return true;
    }
    uiSet(interaction, { dept: "nova", tab: "novaq", novaQIndex: idx });
    await interaction.showModal(novaQuestionFormModal("edit", q));
    return true;
  }
  if (interaction.isButton() && id === "c:adm:novaqdel") {
    const qs = dumpNovaQuestions(novaQuestions(getConfig(interaction.guildId)));
    if (qs.length <= 1) {
      await safeReply(interaction, "Нужен хотя бы один вопрос.");
      return true;
    }
    const idx = novaQuestionIndex(uiGet(interaction), qs);
    const removed = qs.splice(idx, 1)[0];
    setConfig(interaction.guildId, { novaTicketQuestions: qs });
    logAdminChange(interaction, "Админка: удалил вопрос заявки Нова", [
      `Вопрос: **${removed?.label || idx + 1}**`,
    ]).catch(() => null);
    const ui = uiSet(interaction, {
      dept: "nova",
      tab: "novaq",
      novaQIndex: Math.min(idx, qs.length - 1),
    });
    await showPanel(interaction, novaQuestionsEditorPayload(interaction.guild, ui));
    return true;
  }
  if (interaction.isButton() && (id === "c:adm:novaqup" || id === "c:adm:novaqdn")) {
    const qs = dumpNovaQuestions(novaQuestions(getConfig(interaction.guildId)));
    const idx = novaQuestionIndex(uiGet(interaction), qs);
    const swap = id === "c:adm:novaqup" ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= qs.length) {
      await showPanel(interaction, novaQuestionsEditorPayload(interaction.guild, uiGet(interaction)));
      return true;
    }
    [qs[idx], qs[swap]] = [qs[swap], qs[idx]];
    setConfig(interaction.guildId, { novaTicketQuestions: qs });
    logAdminChange(interaction, "Админка: порядок вопросов заявок Нова", [
      qs.map((q, i) => `${i + 1}. **${q.label}**`).join("\n"),
    ]).catch(() => null);
    const ui = uiSet(interaction, { dept: "nova", tab: "novaq", novaQIndex: swap });
    await showPanel(interaction, novaQuestionsEditorPayload(interaction.guild, ui));
    return true;
  }
  if (interaction.isStringSelectMenu() && id === "c:adm:rrdel") {
    if (!(await canEditSettings(interaction))) {
      await safeReply(interaction, "Автороли может менять только владелец или участник с правом «Управлять сервером».");
      return true;
    }
    const cfg = getConfig(interaction.guildId);
    const items = reactionRoleItems(cfg);
    const index = Number(interaction.values[0]);
    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
      await safeReply(interaction, "Связка уже удалена или устарела.");
      return true;
    }
    const [removed] = items.splice(index, 1);
    setConfig(interaction.guildId, { reactionRoles: items });
    logAdminChange(interaction, "Админка: удалил автороль", [
      `${removed.emoji} → <@&${removed.roleId}>`,
    ]).catch(() => null);
    uiSet(interaction, { dept: "5rp", tab: "autoroles" });
    await refreshTopic(interaction, "autoroles");
    refreshReactionRolePanels(interaction.client, interaction.guildId).catch(() => null);
    return true;
  }
  if (interaction.isButton() && id === "c:adm:novaacc") {
    if (!(await canModerate(interaction))) {
      await safeReply(interaction, "Нет прав переключать приём заявок.");
      return true;
    }
    uiSet(interaction, { dept: "nova", tab: "apps" });
    const acc = guildAcceptance(interaction.guildId);
    setGuildAcceptance(interaction.guildId, { nova: !acc.nova });
    const next = guildAcceptance(interaction.guildId);
    logAdminChange(interaction, "Админка: изменил приём заявок", [
      `Нова: **${acc.nova ? "открыт" : "закрыт"}** → **${next.nova ? "открыт" : "закрыт"}**`,
    ]).catch(() => null);
    await refreshTopic(interaction, "apps");
    refreshNovaAppPanels(interaction.client, interaction.guildId).catch(() => null);
    return true;
  }

  const deptOpen = id.match(/^c:adm:dept:(5rp|nova)$/);
  if (interaction.isButton() && deptOpen) {
    const dept = deptOpen[1];
    await openDept(interaction, dept);
    logAdminChange(interaction, "Админка: открыл отдел", [
      `Отдел: **${dept === "nova" ? "Нова в нове" : "5рп"}**`,
    ]).catch(() => null);
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
        daily: "summary",
        dm: "summary",
        family: "rooms",
      }[tabOpen[1]] || tabOpen[1];
    if (!uiGet(interaction).dept) {
      const saved = getConfig(interaction.guildId).adminHubDept === "nova" ? "nova" : "5rp";
      uiSet(interaction, { dept: saved });
    }
    if (["cars", "logs", "kontr", "mods", "sbor", "rooms", "archive", "afk", "protect", "autoroles"].includes(tab) && !(await canEditSettings(interaction))) {
      await safeReply(interaction, "Привязки может менять только владелец или участник с правом «Управлять сервером».");
      return true;
    }
    if (tab === "spam" && !(await canSpam(interaction)) && !(await canEditSettings(interaction))) {
      await safeReply(interaction, "Нет прав на спам.");
      return true;
    }
    if (uiGet(interaction).dept === "nova" && !["panels", "apps", "welcome"].includes(tab)) {
      await openDept(interaction, "nova");
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
    if (kind === "reactionroles" && !(await canEditSettings(interaction))) {
      await safeReply(interaction, "Панель авторолей может публиковать только владелец или участник с правом «Управлять сервером».");
      return true;
    }
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
      const lastId = cfg.panelChannels?.[panelChannelKey(kind)];
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
          new ActionRowBuilder().addComponents(
            btn(
              uiGet(interaction).tab === "welcome" ? "c:adm:back:welcome" : "c:adm:back:panels",
              "← Назад",
              null,
              ButtonStyle.Secondary,
            ),
          ),
        ],
      );
      await showPanel(interaction, payload);
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
      await showPanel(interaction, dropPickPayload(interaction.guild, "panels", value));
      return true;
    }
    if (value === "t:refresh") {
      await refreshTopic(interaction, tab);
      return true;
    }
    if (value === "t:novaacc") {
      if (!(await canModerate(interaction))) {
        await safeReply(interaction, "Нет прав переключать приём заявок.");
        return true;
      }
      const acc = guildAcceptance(interaction.guildId);
      setGuildAcceptance(interaction.guildId, { nova: !acc.nova });
      const next = guildAcceptance(interaction.guildId);
      logAdminChange(interaction, "Админка: изменил приём заявок", [
        `Нова: **${acc.nova ? "открыт" : "закрыт"}** → **${next.nova ? "открыт" : "закрыт"}**`,
      ]).catch(() => null);
      await refreshTopic(interaction, "apps");
      refreshNovaAppPanels(interaction.client, interaction.guildId).catch(() => null);
      return true;
    }
    if (value === "t:novagif") {
      logAdminChange(interaction, "Админка: выбрал пункт", [
        `Раздел: **${TAB_LABELS[tab] || tab}**`,
        `Пункт: **${MENU_LABELS[value]}**`,
      ]).catch(() => null);
      await interaction.showModal(novaGifModal(getConfig(interaction.guildId)));
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
    if (value === "t:leavenoroles") {
      if (!(await canEditSettings(interaction))) {
        await safeReply(interaction, "Привязки может менять только владелец или Manage Server.");
        return true;
      }
      const before = getConfig(interaction.guildId);
      const next = before.leaveLogIncludeNoRoles === false;
      setConfig(interaction.guildId, { leaveLogIncludeNoRoles: next });
      logAdminChange(interaction, "Админка: лог выхода без ролей", [
        `Статус: **${before.leaveLogIncludeNoRoles === false ? "выкл" : "вкл"}** → **${next ? "вкл" : "выкл"}**`,
      ]).catch(() => null);
      await refreshTopic(interaction, "logs");
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
      await showPanel(interaction, payload);
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

  if (interaction.isRoleSelectMenu() && id === "c:cfg:r:rradd") {
    const cfg = getConfig(interaction.guildId);
    const items = reactionRoleItems(cfg);
    if (items.length >= MAX_REACTION_ROLES) {
      await safeReply(interaction, `Достигнут лимит: ${MAX_REACTION_ROLES} авторолей.`);
      return true;
    }
    const roleId = interaction.values[0];
    const role = interaction.guild.roles.cache.get(String(roleId));
    if (!role || role.id === interaction.guild.id || role.managed) {
      await safeReply(interaction, "Эту роль нельзя выдавать автоматически.");
      return true;
    }
    if (items.some((item) => item.roleId === role.id)) {
      await safeReply(interaction, "Для этой роли уже настроена реакция.");
      return true;
    }
    uiSet(interaction, { dept: "5rp", tab: "autoroles", reactionRoleId: role.id });
    await interaction.showModal(reactionRoleModal(role));
    return true;
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
    if (id.includes(":nova")) uiSet(interaction, { dept: "nova", tab: "apps" });
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
    if (id === "c:cfg:c:welnnova" || id === "c:cfg:c:welrp") {
      uiSet(interaction, { dept: "nova", tab: "welcome" });
      await refreshTopic(interaction, "welcome");
      refreshWelcomePanels(interaction.client, interaction.guildId).catch(() => null);
      return true;
    }
    if (id.includes(":nova")) uiSet(interaction, { dept: "nova", tab: "apps" });
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
  if (interaction.isModalSubmit() && id === "c:cfg:m:rradd") {
    if (!(await canEditSettings(interaction))) {
      await safeReply(interaction, "Автороли может менять только владелец или участник с правом «Управлять сервером».");
      return true;
    }
    const roleId = String(uiGet(interaction).reactionRoleId || "");
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role || role.id === interaction.guild.id || role.managed) {
      await safeReply(interaction, "Выбранная роль больше недоступна.");
      return true;
    }
    const parsed = parseReactionEmoji(interaction.fields.getTextInputValue("emoji"));
    if (!parsed) {
      await safeReply(interaction, "Укажите один обычный эмодзи или серверный эмодзи в формате `<:название:ID>`.");
      return true;
    }
    const cfg = getConfig(interaction.guildId);
    const items = reactionRoleItems(cfg);
    if (items.length >= MAX_REACTION_ROLES) {
      await safeReply(interaction, `Достигнут лимит: ${MAX_REACTION_ROLES} авторолей.`);
      return true;
    }
    if (items.some((item) => item.roleId === role.id)) {
      await safeReply(interaction, "Для этой роли уже настроена реакция.");
      return true;
    }
    if (items.some((item) => item.emojiKey === parsed.emojiKey)) {
      await safeReply(interaction, "Этот эмодзи уже используется для другой роли.");
      return true;
    }
    const label =
      String(interaction.fields.getTextInputValue("label") || "").trim().slice(0, 80) ||
      role.name;
    items.push({
      emoji: parsed.emoji,
      emojiKey: parsed.emojiKey,
      roleId: role.id,
      label,
    });
    setConfig(interaction.guildId, { reactionRoles: items });
    logAdminChange(interaction, "Админка: добавил автороль", [
      `${parsed.emoji} → <@&${role.id}> · ${label}`,
    ]).catch(() => null);
    uiSet(interaction, { dept: "5rp", tab: "autoroles", reactionRoleId: null });
    await refreshTopic(interaction, "autoroles");
    refreshReactionRolePanels(interaction.client, interaction.guildId).catch(() => null);
    return true;
  }
  if (interaction.isModalSubmit() && id === "c:cfg:m:novagif") {
    const raw = String(interaction.fields.getTextInputValue("url") || "").trim();
    if (raw) {
      try {
        const u = new URL(raw);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad");
      } catch {
        await safeReply(interaction, "Нужна обычная ссылка http(s) на картинку/гифку.");
        return true;
      }
    }
    setConfig(interaction.guildId, { novaTicketGifUrl: raw || null });
    logAdminChange(interaction, "Админка: гифка заявок Нова", [
      raw ? `Ссылка: ${raw.slice(0, 120)}` : "Гифка снята",
    ]).catch(() => null);
    uiSet(interaction, { dept: "nova", tab: "apps" });
    await refreshTopic(interaction, "apps");
    refreshNovaAppPanels(interaction.client, interaction.guildId).catch(() => null);
    return true;
  }
  if (interaction.isModalSubmit() && id === "c:cfg:m:novatext") {
    const text = String(interaction.fields.getTextInputValue("text") || "").trim() || DEFAULT_NOVA_PANEL_TEXT;
    setConfig(interaction.guildId, { novaTicketPanelText: text });
    logAdminChange(interaction, "Админка: текст панели заявок Нова", [
      `Длина: **${text.length}** символов`,
      `Превью: ${text.slice(0, 120)}${text.length > 120 ? "…" : ""}`,
    ]).catch(() => null);
    uiSet(interaction, { dept: "nova", tab: "apps" });
    await refreshTopic(interaction, "apps");
    refreshNovaAppPanels(interaction.client, interaction.guildId).catch(() => null);
    return true;
  }
  if (interaction.isModalSubmit() && id === "c:cfg:m:welgif") {
    const raw = String(interaction.fields.getTextInputValue("url") || "").trim();
    if (raw) {
      try {
        const u = new URL(raw);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad");
      } catch {
        await safeReply(interaction, "Нужна обычная ссылка http(s) на картинку/гифку.");
        return true;
      }
    }
    setConfig(interaction.guildId, { welcomeGifUrl: raw || null });
    logAdminChange(interaction, "Админка: гифка приветствия", [
      raw ? `Ссылка: ${raw.slice(0, 120)}` : "Гифка снята",
    ]).catch(() => null);
    uiSet(interaction, { dept: "nova", tab: "welcome" });
    await refreshTopic(interaction, "welcome");
    refreshWelcomePanels(interaction.client, interaction.guildId).catch(() => null);
    return true;
  }
  if (interaction.isModalSubmit() && id === "c:cfg:m:weltext") {
    const text = String(interaction.fields.getTextInputValue("text") || "").trim() || DEFAULT_WELCOME_PANEL_TEXT;
    setConfig(interaction.guildId, { welcomePanelText: text });
    logAdminChange(interaction, "Админка: текст приветствия", [
      `Длина: **${text.length}** символов`,
      `Превью: ${text.slice(0, 120)}${text.length > 120 ? "…" : ""}`,
    ]).catch(() => null);
    uiSet(interaction, { dept: "nova", tab: "welcome" });
    await refreshTopic(interaction, "welcome");
    refreshWelcomePanels(interaction.client, interaction.guildId).catch(() => null);
    return true;
  }
  if (interaction.isModalSubmit() && id === "c:cfg:m:novacd") {
    const days = Math.min(365, Math.max(0, Math.floor(Number(String(interaction.fields.getTextInputValue("days") || "0").replace(",", ".")) || 0)));
    const before = Math.max(0, Number(getConfig(interaction.guildId).novaTicketCooldownDays || 0));
    setConfig(interaction.guildId, { novaTicketCooldownDays: days });
    logAdminChange(interaction, "Админка: кулдаун заявок Нова", [
      `Дней после отказа: **${before}** → **${days}**`,
    ]).catch(() => null);
    uiSet(interaction, { dept: "nova", tab: "apps" });
    await refreshTopic(interaction, "apps");
    refreshNovaAppPanels(interaction.client, interaction.guildId).catch(() => null);
    return true;
  }
  if (interaction.isModalSubmit() && (id === "c:cfg:m:novaqadd" || id === "c:cfg:m:novaqedit")) {
    const label = String(interaction.fields.getTextInputValue("label") || "").trim().slice(0, 45);
    if (!label) {
      await safeReply(interaction, "Название вопроса не может быть пустым.");
      return true;
    }
    const nextQ = {
      label,
      placeholder: String(interaction.fields.getTextInputValue("placeholder") || "").trim().slice(0, 100),
      long: parseLongFlag(interaction.fields.getTextInputValue("long")),
    };
    const qs = dumpNovaQuestions(novaQuestions(getConfig(interaction.guildId)));
    let selected = novaQuestionIndex(uiGet(interaction), qs);
    if (id === "c:cfg:m:novaqadd") {
      if (qs.length >= MAX_NOVA_QUESTIONS) {
        await safeReply(interaction, `Максимум ${MAX_NOVA_QUESTIONS} вопросов — лимит формы Discord.`);
        return true;
      }
      qs.push(nextQ);
      selected = qs.length - 1;
      logAdminChange(interaction, "Админка: добавил вопрос заявки Нова", [`**${nextQ.label}**`]).catch(() => null);
    } else {
      if (!qs[selected]) {
        await safeReply(interaction, "Сначала выберите вопрос в списке.");
        return true;
      }
      qs[selected] = nextQ;
      logAdminChange(interaction, "Админка: изменил вопрос заявки Нова", [
        `${selected + 1}. **${nextQ.label}**`,
      ]).catch(() => null);
    }
    setConfig(interaction.guildId, { novaTicketQuestions: qs });
    const ui = uiSet(interaction, { dept: "nova", tab: "novaq", novaQIndex: selected });
    await showPanel(interaction, novaQuestionsEditorPayload(interaction.guild, ui));
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
