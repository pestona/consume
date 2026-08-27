import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { kvGet, kvSet } from "./db.js";
import { getConfig } from "./config.js";
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
  return data;
}

function saveTickets(data) {
  kvSet("tickets", {
    byChannel: data.byChannel,
    counter: data.counter,
    pending: data.pending,
  });
}

function acceptanceState() {
  const data = kvGet("state") || { guilds: {} };
  data.guilds = data.guilds || {};
  return data;
}

export function guildAcceptance(guildId) {
  const data = acceptanceState();
  const g = data.guilds[String(guildId)] || { rp: true, vzp: true };
  return { rp: g.rp !== false, vzp: g.vzp !== false };
}

export function setGuildAcceptance(guildId, patch) {
  const data = acceptanceState();
  const key = String(guildId);
  const g = data.guilds[key] || { rp: true, vzp: true };
  if (patch.rp !== undefined) g.rp = patch.rp;
  if (patch.vzp !== undefined) g.vzp = patch.vzp;
  data.guilds[key] = g;
  kvSet("state", data);
  return { rp: Boolean(g.rp), vzp: Boolean(g.vzp) };
}

function nextTicketNo(guildId) {
  const data = ticketsState();
  const key = String(guildId);
  const n = Number(data.counter[key] || 0) + 1;
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

function normalizeFields(kind, fields) {
  const values = (fields || []).map(([, v]) => String(v));
  const names =
    kind === "rp" ? ["Возраст", "Онлайн", "Семьи", "Откуда", "Откат"] : ["Возраст", "Онлайн", "Семьи", "Откат"];
  return names.map((name, i) => [name, values[i] || "—"]);
}

function buildTicketEmbed({ kind, ticketNo, applicant, fields }) {
  const label = kind === "rp" ? "РП" : "VZP";
  const emb = new EmbedBuilder()
    .setTitle(`Новая заявка: ${label} · #${ticketNo}`)
    .setColor(kind === "rp" ? COLOR_BLUE : COLOR_GREEN)
    .setTimestamp(new Date())
    .addFields({ name: "ПОЛЬЗОВАТЕЛЬ", value: applicant.toString(), inline: false });
  for (const [name, value] of normalizeFields(kind, fields)) {
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

export function ticketFinalRows(channelId) {
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
  const catId = cfg.ticketCategoryId;
  let category = null;
  if (catId) {
    category = guild.channels.cache.get(String(catId)) || null;
    if (!category || category.type !== ChannelType.GuildCategory) {
      throw new Error("Категория тикетов не настроена или это не категория. Откройте /panel → Настройки.");
    }
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
  for (const rid of cfg.ticketStaffRoleIds || []) {
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

  const pingIds = (cfg.ticketPingRoleIds?.length ? cfg.ticketPingRoleIds : cfg.ticketStaffRoleIds) || [];
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

  const ticketNo = nextTicketNo(interaction.guild.id);
  const norm = normalizeFields(kind, fields);
  const emb = buildTicketEmbed({ kind, ticketNo, applicant, fields: norm });

  try {
    const { channel, pingContent, allowedRoleIds } = await createTicketChannel(interaction.guild, applicant, {
      kind,
      ticketNo,
    });
    await channel.send({
      content: pingContent || undefined,
      embeds: [emb],
      components: ticketFinalRows(channel.id),
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
        : "Не удалось создать тикет-канал. Проверьте права бота и настройки в /panel.",
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
  const roleIds = track === "academy" ? cfg.acceptRoleIdsAcademy : cfg.acceptRoleIdsMain;
  if (!roleIds?.length) {
    rec.phase = "interview";
    ticketPut(channelId, rec);
    await interaction.editReply(
      "Роли принятия не заданы. Откройте **/panel → Заявки** и выберите роли академии/основы.",
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
    await member.roles.add(roles, track === "academy" ? "Заявка принята в академию" : "Заявка принята в основу");
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
    track === "academy"
      ? "> **Вас приняли в академию. Добро пожаловать!**"
      : "> **Вас приняли в основу. Добро пожаловать!**",
  );
  ticketDelete(channelId);
  await interaction.editReply(
    track === "academy" ? "Принят в академию. Удаляю канал…" : "Принят в основу. Удаляю канал…",
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
