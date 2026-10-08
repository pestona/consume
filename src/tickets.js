import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  EmbedBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { kvGet, kvSet } from "./db.js";
import { DEFAULT_NOVA_PANEL_TEXT, DEFAULT_NOVA_QUESTIONS, MAX_NOVA_QUESTIONS, getConfig } from "./config.js";
import { canHandleTicket, canModerate } from "./perms.js";
import {
  COLOR_BLUE,
  COLOR_DARK,
  COLOR_GOLD,
  COLOR_GREEN,
  COLOR_ORANGE,
  COLOR_RED,
  channelSlug,
  embedFieldCodeblock,
  formatDateRu,
  logJson,
  reasonInCodeBlock,
  safeDm,
  safeReply,
  statusLine,
  withLock,
} from "./util.js";

function ticketsState() {
  const data = kvGet("tickets") || {};
  data.byChannel = data.byChannel || data.by_channel || {};
  data.counter = data.counter || {};
  data.pending = data.pending || {};
  data.novaRejectAt = data.novaRejectAt && typeof data.novaRejectAt === "object" ? data.novaRejectAt : {};
  return data;
}

function saveTickets(data) {
  kvSet("tickets", {
    byChannel: data.byChannel,
    counter: data.counter,
    pending: data.pending,
    novaRejectAt: data.novaRejectAt || {},
  });
}

function acceptanceState() {
  const data = kvGet("state") || { guilds: {} };
  data.guilds = data.guilds || {};
  return data;
}

export function guildAcceptance(guildId) {
  const data = acceptanceState();
  const g = data.guilds[String(guildId)] || { rp: true, vzp: true, nova: true };
  return { rp: g.rp !== false, vzp: g.vzp !== false, nova: g.nova !== false };
}

export function setGuildAcceptance(guildId, patch) {
  const data = acceptanceState();
  const key = String(guildId);
  const g = data.guilds[key] || { rp: true, vzp: true, nova: true };
  if (patch.rp !== undefined) g.rp = patch.rp;
  if (patch.vzp !== undefined) g.vzp = patch.vzp;
  if (patch.nova !== undefined) g.nova = patch.nova;
  data.guilds[key] = g;
  kvSet("state", data);
  return { rp: Boolean(g.rp), vzp: Boolean(g.vzp), nova: Boolean(g.nova) };
}

/** Минимальный номер следующего тикета (на чистом деплое не сбрасывается в 1). */
const MIN_NEXT_TICKET_NO = 4169;

function nextTicketNo(guildId) {
  const data = ticketsState();
  const key = String(guildId);
  const n = Math.max(Number(data.counter[key] || 0) + 1, MIN_NEXT_TICKET_NO);
  data.counter[key] = n;
  saveTickets(data);
  return n;
}

function ticketGet(channelId) {
  return ticketsState().byChannel[String(channelId)] || null;
}

function ticketPut(channelId, rec) {
  const data = ticketsState();
  data.byChannel[String(channelId)] = rec;
  saveTickets(data);
}

function ticketDelete(channelId) {
  const data = ticketsState();
  delete data.byChannel[String(channelId)];
  saveTickets(data);
}

export function novaQuestions(cfg) {
  const list = Array.isArray(cfg?.novaTicketQuestions) ? cfg.novaTicketQuestions : [];
  const labeled = list
    .map((q) => ({
      label: String(q?.label || "").trim().slice(0, 45),
      placeholder: String(q?.placeholder || "").trim().slice(0, 100),
      long: q?.long,
    }))
    .filter((q) => q.label);
  const src = labeled.length ? labeled.slice(0, MAX_NOVA_QUESTIONS) : DEFAULT_NOVA_QUESTIONS;
  return src.map((q, i, arr) => ({
    label: q.label,
    placeholder: q.placeholder || "",
    long: typeof q.long === "boolean" ? q.long : i === arr.length - 1,
  }));
}

function normalizeFields(kind, fields, cfg) {
  const values = (fields || []).map(([, v]) => String(v));
  const names =
    kind === "rp"
      ? ["Возраст", "Онлайн", "Семьи", "Откуда", "Откат"]
      : kind === "nova"
        ? novaQuestions(cfg).map((q) => q.label)
        : ["Возраст", "Онлайн", "Семьи", "Откат"];
  return names.map((name, i) => [name, values[i] || "—"]);
}

function novaCooldownLeftMs(guildId, userId) {
  const days = Math.max(0, Number(getConfig(guildId).novaTicketCooldownDays || 0));
  if (!days) return 0;
  const at = Number(ticketsState().novaRejectAt?.[`${guildId}:${userId}`] || 0);
  if (!at) return 0;
  return Math.max(0, at + days * 86_400_000 - Date.now());
}

function markNovaRejected(guildId, userId) {
  const data = ticketsState();
  data.novaRejectAt[`${guildId}:${userId}`] = Date.now();
  saveTickets(data);
}

function ticketKindLabel(kind) {
  if (kind === "rp") return "РП";
  if (kind === "nova") return "Нова";
  return "VZP";
}

function ticketDeptCfg(cfg, kind) {
  if (kind === "nova") {
    return {
      categoryId: cfg.novaTicketCategoryId,
      staffRoleIds: cfg.novaTicketStaffRoleIds || [],
      pingRoleIds: cfg.novaTicketPingRoleIds || [],
      acceptRoleIds: cfg.novaAcceptRoleId
        ? [cfg.novaAcceptRoleId]
        : (cfg.novaAcceptRoleIdsAcademy || []).slice(0, 1),
      academyRoleIds: [],
      mainRoleIds: [],
      settingsHint: "/panel → Нова → Заявки",
    };
  }
  return {
    categoryId: cfg.ticketCategoryId,
    staffRoleIds: cfg.ticketStaffRoleIds || [],
    pingRoleIds: cfg.ticketPingRoleIds || [],
    academyRoleIds: cfg.acceptRoleIdsAcademy || [],
    mainRoleIds: cfg.acceptRoleIdsMain || [],
    settingsHint: "/panel → 5рп → Заявки",
  };
}

function buildTicketEmbed({ kind, ticketNo, applicant, fields }) {
  const label = ticketKindLabel(kind);
  const emb = new EmbedBuilder()
    .setTitle(`Новая заявка: ${label} · #${ticketNo}`)
    .setColor(kind === "rp" ? COLOR_BLUE : COLOR_GREEN)
    .setTimestamp(new Date())
    .addFields({ name: "ПОЛЬЗОВАТЕЛЬ", value: applicant.toString(), inline: false });
  for (const [name, value] of normalizeFields(kind, fields, getConfig(applicant.guildId || applicant.guild?.id))) {
    emb.addFields({ name, value: embedFieldCodeblock(value), inline: false });
  }
  emb.setFooter({
    text: `User ID: ${applicant.id} - Тикет №${ticketNo} - ${formatDateRu()}`,
  });
  return emb;
}

export function moderationEmbed(guildId) {
  const { rp, vzp } = guildAcceptance(guildId);
  return new EmbedBuilder()
    .setTitle("Модерация заявок")
    .setDescription("Переключите прием заявок по типам.")
    .setColor(COLOR_ORANGE)
    .addFields({
      name: "Статус",
      value: `РП: **${statusLine(rp)}**\nVZP: **${statusLine(vzp)}**`,
    })
    .setFooter({ text: formatDateRu() });
}

export function moderationPanel() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("c:mod:rp").setLabel("РП").setStyle(ButtonStyle.Secondary).setEmoji("📝"),
    new ButtonBuilder().setCustomId("c:mod:vzp").setLabel("VZP").setStyle(ButtonStyle.Secondary).setEmoji("📋"),
  );
}

export function applicationPanel() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("c:app:select")
      .setPlaceholder("📋 Подать Заявку VZP")
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel("Подать Заявку РП")
          .setDescription("Нажмите, чтобы заполнить анкету RP")
          .setValue("rp")
          .setEmoji("📝"),
        new StringSelectMenuOptionBuilder()
          .setLabel("Подать Заявку VZP")
          .setDescription("Нажмите, чтобы заполнить анкету VZP")
          .setValue("vzp")
          .setEmoji("📋"),
      ),
  );
}

function normalizeImageUrl(raw) {
  let s = String(raw || "").trim().replace(/^<|>$/g, "").trim();
  const found = s.match(/https?:\/\/[^\s<>"'`]+/i);
  if (!found) return null;
  let url = found[0].replace(/[),.;]+$/g, "");
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return url.slice(0, 2048);
}

function novaAppPanelsStore() {
  const data = kvGet("novaAppPanels") || {};
  data.byGuild = data.byGuild && typeof data.byGuild === "object" ? data.byGuild : {};
  return data;
}

function saveNovaAppPanels(data) {
  kvSet("novaAppPanels", { byGuild: data.byGuild });
}

export function registerNovaAppPanel(guildId, channelId, messageId) {
  const data = novaAppPanelsStore();
  const gid = String(guildId);
  const list = Array.isArray(data.byGuild[gid]) ? data.byGuild[gid] : [];
  const mid = String(messageId);
  data.byGuild[gid] = [
    ...list.filter((p) => String(p.messageId) !== mid),
    { channelId: String(channelId), messageId: mid },
  ].slice(-20);
  saveNovaAppPanels(data);
}

export function novaApplicationPanel() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("c:nova:app").setLabel("Подать заявку").setStyle(ButtonStyle.Success),
  );
}

export function novaApplicationPayload(guildId) {
  const { nova } = guildAcceptance(guildId);
  const cfg = getConfig(guildId);
  const gif = normalizeImageUrl(cfg.novaTicketGifUrl);
  const days = Math.max(0, Number(cfg.novaTicketCooldownDays || 0));
  const raw = String(cfg.novaTicketPanelText || DEFAULT_NOVA_PANEL_TEXT);
  const body =
    `## Оформление заявки в семью.\n` +
    raw
      .replaceAll("{cooldown}", String(days))
      .replaceAll("{status}", nova ? "открыт" : "закрыт")
      .slice(0, 3500);

  const container = new ContainerBuilder().setAccentColor(COLOR_DARK);
  if (gif) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(gif)),
    );
  }
  container
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
    .addActionRowComponents(novaApplicationPanel());
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

async function discoverNovaAppPanels(guild) {
  const cfg = getConfig(guild.id);
  const chId = cfg.panelChannels?.novaApps;
  if (!chId) return;
  const ch = guild.channels.cache.get(String(chId));
  if (!ch?.messages) return;
  try {
    const msgs = await ch.messages.fetch({ limit: 40 });
    for (const msg of msgs.values()) {
      if (msg.author?.id !== guild.client.user?.id) continue;
      const raw = JSON.stringify(msg.components || []);
      if (raw.includes("c:nova:app")) registerNovaAppPanel(guild.id, ch.id, msg.id);
    }
  } catch (err) {
    logJson("WARN", "nova panel discover", { error: String(err) });
  }
}

export async function refreshNovaAppPanels(client, guildId) {
  const guild = client.guilds.cache.get(String(guildId));
  if (!guild) return;
  await discoverNovaAppPanels(guild);
  const data = novaAppPanelsStore();
  const list = Array.isArray(data.byGuild[String(guildId)]) ? data.byGuild[String(guildId)] : [];
  const payload = novaApplicationPayload(guildId);
  let changed = false;
  const next = [];
  for (const panel of list) {
    const ch = guild.channels.cache.get(panel.channelId);
    if (!ch?.isTextBased?.()) {
      changed = true;
      continue;
    }
    try {
      const msg = await ch.messages.fetch(panel.messageId);
      await msg.edit({ content: null, embeds: [], ...payload });
      next.push(panel);
    } catch (err) {
      if (err?.code === 10008 || err?.code === 50001) changed = true;
      else next.push(panel);
    }
  }
  if (changed || next.length !== list.length) {
    data.byGuild[String(guildId)] = next;
    saveNovaAppPanels(data);
  }
}

function novaModal(guildId) {
  const qs = novaQuestions(getConfig(guildId));
  const modal = new ModalBuilder().setCustomId("c:nova:m:app").setTitle("Заявка в семью");
  qs.forEach((q, i) => {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(`f${i + 1}`)
          .setLabel(q.label.slice(0, 45) || `Вопрос ${i + 1}`)
          .setPlaceholder((q.placeholder || " ").slice(0, 100))
          .setStyle(q.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setMaxLength(q.long ? 500 : 200)
          .setRequired(true),
      ),
    );
  });
  return modal;
}

export function buildApplicationEmbed(botUser) {
  const emb = new EmbedBuilder()
    .setTitle("Оформление заявки.")
    .setColor(COLOR_DARK)
    .setDescription(
      "**После отправки анкеты сразу создаётся отдельный тикет-канал с вами.**\n\n" +
        "> В канале команда рассматривает заявку и выносит решение: **Принять / Отказать**.\n\n" +
        "**Также продублируем ссылку на тикет в личные сообщения, чтобы вы ничего не пропустили.**",
    )
    .setFooter({ text: "Подать заявку:" });
  const icon = botUser?.displayAvatarURL?.({ size: 128 });
  emb.setAuthor({ name: "Consume famq", ...(icon ? { iconURL: icon } : {}) });
  return emb;
}

function rpModal() {
  const modal = new ModalBuilder().setCustomId("c:app:rp").setTitle("Заявка РП");
  const fields = [
    ["f1", "Возраст", "18", TextInputStyle.Short, 200],
    ["f2", "Онлайн", "Пример: 4-6 часов", TextInputStyle.Short, 200],
    ["f3", "Список семей в которых были", "Пример: Killa, Kai, Black", TextInputStyle.Short, 100],
    ["f4", "Откуда узнали о семье Consume", "Пример: От друга | Из рекламы", TextInputStyle.Paragraph, 1000],
    ["f5", "Откат стрельбы DM 10.500 урона", "Ссылка на YouTube | Нету = academy", TextInputStyle.Paragraph, 500],
  ];
  for (const [id, label, placeholder, style, max] of fields) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(id)
          .setLabel(label)
          .setPlaceholder(placeholder)
          .setStyle(style)
          .setMaxLength(max)
          .setRequired(true),
      ),
    );
  }
  return modal;
}

function vzpModal() {
  const modal = new ModalBuilder().setCustomId("c:app:vzp").setTitle("Форма заявки VZP");
  const fields = [
    ["f1", "Возраст", "Пример: 18", TextInputStyle.Short, 200],
    ["f2", "Онлайн", "Пример: 4-6 часов", TextInputStyle.Short, 200],
    ["f3", "В каких семьях были", "Пример: Killa, Kai, Black", TextInputStyle.Short, 100],
    ["f4", "Откат с ВЗП/DM", "Ссылка на YouTube", TextInputStyle.Paragraph, 500],
  ];
  for (const [id, label, placeholder, style, max] of fields) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(id)
          .setLabel(label)
          .setPlaceholder(placeholder)
          .setStyle(style)
          .setMaxLength(max)
          .setRequired(true),
      ),
    );
  }
  return modal;
}

function rejectModal(channelId) {
  return new ModalBuilder()
    .setCustomId(`c:tk:rej:${channelId}`)
    .setTitle("Причина отказа")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Причина отказа")
          .setPlaceholder("Укажи причину отказа для заявителя…")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1000)
          .setRequired(true),
      ),
    );
}

export function ticketFinalRows(channelId, kind) {
  if (kind === "nova") {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`c:tk:ok:${channelId}`)
          .setLabel("Принять")
          .setStyle(ButtonStyle.Success)
          .setEmoji("✅"),
        new ButtonBuilder()
          .setCustomId(`c:tk:rejbtn:${channelId}`)
          .setLabel("Отказать")
          .setStyle(ButtonStyle.Danger)
          .setEmoji("❌"),
      ),
    ];
  }
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`c:tk:acad:${channelId}`)
        .setLabel("Принять в академию")
        .setStyle(ButtonStyle.Success)
        .setEmoji("🎓"),
      new ButtonBuilder()
        .setCustomId(`c:tk:main:${channelId}`)
        .setLabel("Принять в основу")
        .setStyle(ButtonStyle.Success)
        .setEmoji("✅"),
      new ButtonBuilder()
        .setCustomId(`c:tk:rejbtn:${channelId}`)
        .setLabel("Отказать")
        .setStyle(ButtonStyle.Danger)
        .setEmoji("❌"),
    ),
  ];
}

function rejectionEmbed(reason, afterInterview) {
  return new EmbedBuilder()
    .setTitle(afterInterview ? "❌ Отказ после обзвона" : "❌ Заявка отклонена")
    .setDescription(
      afterInterview
        ? "Модератор рассмотрел анкету после обзвона. Главное — блок ниже."
        : "Модератор рассмотрел анкету. Главное — блок ниже.",
    )
    .setColor(COLOR_RED)
    .setTimestamp(new Date())
    .addFields(
      { name: "Причина отказа", value: reasonInCodeBlock(reason), inline: false },
      {
        name: "Дальше",
        value: "Повторная заявка — через 1–3 дня.\nИсправь то, что указано в причине.",
        inline: false,
      },
    )
    .setFooter({ text: formatDateRu() });
}

function interviewInviteEmbed(guildName, channel) {
  return new EmbedBuilder()
    .setTitle("🕒 Тикет на рассмотрении")
    .setDescription(
      `Заявку в **${guildName}** приняли на рассмотрение. Зайди в канал ниже — там продолжится общение.`,
    )
    .setColor(COLOR_GOLD)
    .setTimestamp(new Date())
    .addFields({ name: "Канал", value: `${channel}`, inline: false })
    .setFooter({ text: formatDateRu() });
}

async function createTicketChannel(guild, applicant, { kind, ticketNo }) {
  const cfg = getConfig(guild.id);
  const dept = ticketDeptCfg(cfg, kind);
  const catId = dept.categoryId;
  let category = null;
  if (catId) {
    category = guild.channels.cache.get(String(catId)) || null;
    if (!category || category.type !== ChannelType.GuildCategory) {
      throw new Error(`Категория тикетов не настроена или это не категория. Откройте ${dept.settingsHint}.`);
    }
  }
  if (kind === "nova" && (!category || category.type !== ChannelType.GuildCategory)) {
    throw new Error(`Категория тикетов не настроена или это не категория. Откройте ${dept.settingsHint}.`);
  }

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: guild.members.me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    {
      id: applicant.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];
  for (const rid of dept.staffRoleIds) {
    const role = guild.roles.cache.get(String(rid));
    if (role) {
      overwrites.push({
        id: role.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages,
        ],
      });
    }
  }

  const pingIds = (dept.pingRoleIds.length ? dept.pingRoleIds : dept.staffRoleIds) || [];
  const roleMentions = [];
  const allowedRoleIds = [];
  for (const rid of pingIds) {
    if (guild.roles.cache.has(String(rid))) {
      roleMentions.push(`<@&${rid}>`);
      allowedRoleIds.push(String(rid));
    }
  }

  const ch = await guild.channels.create({
    name: channelSlug(applicant.displayName, ticketNo, kind),
    type: ChannelType.GuildText,
    parent: category?.id,
    permissionOverwrites: overwrites,
    reason: `Заявка ${kind.toUpperCase()} #${ticketNo}`,
  });

  return { channel: ch, pingContent: roleMentions.join(" "), allowedRoleIds };
}

async function submitApplication(interaction, kind, fields) {
  if (!interaction.guild) {
    await safeReply(interaction, "Заявки только на сервере.");
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const applicant = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!applicant) {
    await interaction.editReply("Не удалось определить участника.");
    return;
  }

  const cfg = getConfig(interaction.guild.id);
  if (kind === "nova") {
    const left = novaCooldownLeftMs(interaction.guild.id, applicant.id);
    if (left > 0) {
      const days = Math.max(1, Math.ceil(left / 86_400_000));
      await interaction.editReply(`Повторная заявка доступна через **${days}** дн.`);
      return;
    }
  }

  const ticketNo = nextTicketNo(interaction.guild.id);
  const norm = normalizeFields(kind, fields, cfg);
  const emb = buildTicketEmbed({ kind, ticketNo, applicant, fields: norm });

  try {
    const { channel, pingContent, allowedRoleIds } = await createTicketChannel(interaction.guild, applicant, {
      kind,
      ticketNo,
    });
    await channel.send({
      content: pingContent || undefined,
      embeds: [emb],
      components: ticketFinalRows(channel.id, kind),
      allowedMentions: allowedRoleIds.length
        ? { roles: allowedRoleIds }
        : { users: [applicant.id] },
    });
    await safeDm(applicant.user, { embeds: [interviewInviteEmbed(interaction.guild.name, channel)] });
    ticketPut(channel.id, {
      guildId: interaction.guild.id,
      applicantId: applicant.id,
      kind,
      ticketNo,
      phase: "interview",
      embedFields: norm,
    });
    await interaction.editReply(`Тикет создан: ${channel}`);
  } catch (err) {
    logJson("ERROR", "Ошибка создания тикета", { error: String(err) });
    await interaction.editReply(
      err?.message?.includes("Категория")
        ? err.message
        : "Не удалось создать тикет-канал. Проверьте права бота и настройки заявок в /panel.",
    );
  }
}

async function handleAccept(interaction, channelId, track) {
  if (!(await canHandleTicket(interaction))) {
    await safeReply(interaction, "Нет прав на работу с заявками.");
    return;
  }
  if (interaction.channelId !== channelId) {
    await safeReply(interaction, "Неверный канал тикета.");
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const locked = await withLock(`ticket:${channelId}`, async () => {
    const rec = ticketGet(channelId);
    if (!rec || rec.phase !== "interview") return { ok: false, text: "Заявка уже закрыта." };
    rec.phase = "closing";
    ticketPut(channelId, rec);
    return { ok: true, rec };
  });
  if (!locked.ok) {
    await interaction.editReply(locked.text);
    return;
  }
  const rec = locked.rec;
  const guild = interaction.guild;
  const cfg = getConfig(guild.id);
  const dept = ticketDeptCfg(cfg, rec.kind);
  const roleIds =
    rec.kind === "nova"
      ? dept.acceptRoleIds
      : track === "academy"
        ? dept.academyRoleIds
        : dept.mainRoleIds;
  if (!roleIds?.length) {
    rec.phase = "interview";
    ticketPut(channelId, rec);
    await interaction.editReply(
      rec.kind === "nova"
        ? `Роль принятия не задана. Откройте **${dept.settingsHint}**.`
        : `Роли принятия не заданы. Откройте **${dept.settingsHint}** и выберите роли академии/основы.`,
    );
    return;
  }
  const roles = [];
  const missing = [];
  for (const rid of roleIds) {
    const r = guild.roles.cache.get(String(rid));
    if (r) roles.push(r);
    else missing.push(rid);
  }
  if (missing.length) {
    rec.phase = "interview";
    ticketPut(channelId, rec);
    await interaction.editReply(`На сервере не найдены роли: ${missing.join(", ")}. Проверьте настройки в /panel.`);
    return;
  }
  let member = guild.members.cache.get(String(rec.applicantId));
  if (!member) {
    try {
      member = await guild.members.fetch(String(rec.applicantId));
    } catch {
      rec.phase = "interview";
      ticketPut(channelId, rec);
      await interaction.editReply("Пользователь не на сервере — роль не выдана.");
      return;
    }
  }
  try {
    await member.roles.add(
      roles,
      rec.kind === "nova"
        ? "Заявка Нова принята"
        : track === "academy"
          ? "Заявка принята в академию"
          : "Заявка принята в основу",
    );
  } catch {
    rec.phase = "interview";
    ticketPut(channelId, rec);
    await interaction.editReply(
      "Не удалось выдать роль: проверьте иерархию ролей (роль бота выше всех выдаваемых).",
    );
    return;
  }
  await safeDm(
    member.user,
    rec.kind === "nova"
      ? "> **Вас приняли. Добро пожаловать!**"
      : track === "academy"
        ? "> **Вас приняли в академию. Добро пожаловать!**"
        : "> **Вас приняли в основу. Добро пожаловать!**",
  );
  ticketDelete(channelId);
  await interaction.editReply(
    rec.kind === "nova"
      ? "Принят. Удаляю канал…"
      : track === "academy"
        ? "Принят в академию. Удаляю канал…"
        : "Принят в основу. Удаляю канал…",
  );
  try {
    await interaction.channel?.delete("Заявка принята");
  } catch (err) {
    logJson("ERROR", "Не удалось удалить канал после принятия", { error: String(err) });
  }
}

async function handleRejectSubmit(interaction, channelId) {
  if (!(await canHandleTicket(interaction))) {
    await safeReply(interaction, "Нет прав на работу с заявками.");
    return;
  }
  const reason = interaction.fields.getTextInputValue("reason").trim();
  if (!reason) {
    await safeReply(interaction, "Причина не может быть пустой.");
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const locked = await withLock(`ticket:${channelId}`, async () => {
    const rec = ticketGet(channelId);
    if (!rec || rec.phase !== "interview") return { ok: false, text: "Заявка уже закрыта или устарела." };
    rec.phase = "closing";
    ticketPut(channelId, rec);
    return { ok: true, rec };
  });
  if (!locked.ok) {
    await interaction.editReply(locked.text);
    return;
  }
  const rec = locked.rec;
  const guild = interaction.guild;
  let applicant = guild.members.cache.get(String(rec.applicantId));
  if (!applicant) {
    applicant = await guild.members.fetch(String(rec.applicantId)).catch(() => null);
  }
  if (applicant) {
    await safeDm(applicant.user, { embeds: [rejectionEmbed(reason, true)] });
  }
  if (rec.kind === "nova") markNovaRejected(guild.id, rec.applicantId);
  ticketDelete(channelId);
  await interaction.editReply("Отказ с причиной отправлен заявителю в ЛС.");
  const ch = guild.channels.cache.get(channelId);
  if (ch) {
    try {
      await ch.delete("Отказ после обзвона");
    } catch (err) {
      logJson("ERROR", "Не удалось удалить канал после отказа", { error: String(err) });
    }
  }
}

export async function handleTicketInteraction(interaction) {
  const id = interaction.customId || "";

  if (interaction.isStringSelectMenu() && id === "c:app:select") {
    const val = interaction.values[0];
    if (!interaction.guild) {
      await safeReply(interaction, "Используйте на сервере.");
      return true;
    }
    const resetSelect = () =>
      interaction.message?.edit({ components: [applicationPanel()] }).catch(() => null);

    const acc = guildAcceptance(interaction.guild.id);
    if (val === "rp") {
      if (!acc.rp) {
        await safeReply(interaction, "Приём заявок РП временно закрыт.");
        await resetSelect();
        return true;
      }
      await interaction.showModal(rpModal());
      await resetSelect();
      return true;
    }
    if (val === "vzp") {
      if (!acc.vzp) {
        await safeReply(interaction, "Приём заявок VZP временно закрыт.");
        await resetSelect();
        return true;
      }
      await interaction.showModal(vzpModal());
      await resetSelect();
      return true;
    }
    await resetSelect();
    return true;
  }

  if (interaction.isButton() && (id === "c:mod:rp" || id === "c:mod:vzp")) {
    if (!(await canModerate(interaction))) {
      await safeReply(interaction, "Нет прав.");
      return true;
    }
    const acc = guildAcceptance(interaction.guild.id);
    if (id === "c:mod:rp") setGuildAcceptance(interaction.guild.id, { rp: !acc.rp });
    else setGuildAcceptance(interaction.guild.id, { vzp: !acc.vzp });
    await interaction.update({
      embeds: [moderationEmbed(interaction.guild.id)],
      components: [moderationPanel()],
    });
    return true;
  }

  if (interaction.isModalSubmit() && id === "c:app:rp") {
    await submitApplication(interaction, "rp", [
      ["ВОЗРАСТ", interaction.fields.getTextInputValue("f1")],
      ["ОНЛАЙН", interaction.fields.getTextInputValue("f2")],
      ["СПИСОК СЕМЕЙ, В КОТОРЫХ БЫЛИ", interaction.fields.getTextInputValue("f3")],
      ["ОТКУДА УЗНАЛИ", interaction.fields.getTextInputValue("f4")],
      ["ОТКАТ СТРЕЛЬБЫ DM 10.500 УРОНА", interaction.fields.getTextInputValue("f5")],
    ]);
    return true;
  }
  if (interaction.isModalSubmit() && id === "c:app:vzp") {
    await submitApplication(interaction, "vzp", [
      ["ВОЗРАСТ", interaction.fields.getTextInputValue("f1")],
      ["ОНЛАЙН", interaction.fields.getTextInputValue("f2")],
      ["В КАКИХ СЕМЬЯХ БЫЛИ", interaction.fields.getTextInputValue("f3")],
      ["ОТКАТ С ВЗП/DM", interaction.fields.getTextInputValue("f4")],
    ]);
    return true;
  }

  if (interaction.isButton() && id === "c:nova:app") {
    if (!interaction.guild) {
      await safeReply(interaction, "Используйте на сервере.");
      return true;
    }
    if (!guildAcceptance(interaction.guild.id).nova) {
      await safeReply(interaction, "Приём заявок Нова временно закрыт.");
      return true;
    }
    const left = novaCooldownLeftMs(interaction.guild.id, interaction.user.id);
    if (left > 0) {
      const days = Math.max(1, Math.ceil(left / 86_400_000));
      await safeReply(interaction, `Повторная заявка доступна через **${days}** дн.`);
      return true;
    }
    await interaction.showModal(novaModal(interaction.guild.id));
    return true;
  }
  if (interaction.isModalSubmit() && id === "c:nova:m:app") {
    const qs = novaQuestions(getConfig(interaction.guildId));
    await submitApplication(
      interaction,
      "nova",
      qs.map((q, i) => [q.label, interaction.fields.getTextInputValue(`f${i + 1}`)]),
    );
    return true;
  }

  const acad = id.match(/^c:tk:acad:(\d+)$/);
  if (interaction.isButton() && acad) {
    await handleAccept(interaction, acad[1], "academy");
    return true;
  }
  const main = id.match(/^c:tk:main:(\d+)$/);
  if (interaction.isButton() && main) {
    await handleAccept(interaction, main[1], "main");
    return true;
  }
  const ok = id.match(/^c:tk:ok:(\d+)$/);
  if (interaction.isButton() && ok) {
    await handleAccept(interaction, ok[1], "nova");
    return true;
  }
  const rejBtn = id.match(/^c:tk:rejbtn:(\d+)$/);
  if (interaction.isButton() && rejBtn) {
    if (!(await canHandleTicket(interaction))) {
      await safeReply(interaction, "Нет прав на работу с заявками.");
      return true;
    }
    await interaction.showModal(rejectModal(rejBtn[1]));
    return true;
  }
  const rej = id.match(/^c:tk:rej:(\d+)$/);
  if (interaction.isModalSubmit() && rej) {
    await handleRejectSubmit(interaction, rej[1]);
    return true;
  }

  return false;
}
