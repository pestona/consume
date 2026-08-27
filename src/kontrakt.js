import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { getConfig } from "./config.js";
import { getContract, setContract } from "./db.js";
import { canManageKontrakt } from "./perms.js";
import {
  COLOR_DARK,
  COLOR_RED,
  mentionUsers,
  parsePeopleCap,
  safeReply,
  withLock,
} from "./util.js";

export function kontraktAllowedInChannel(interaction) {
  const cfg = getConfig(interaction.guildId);
  if (!cfg.kontraktChannelId) return true;
  return String(interaction.channelId) === String(cfg.kontraktChannelId);
}

export function kontraktChannelRestrictionMessage(guildId) {
  const cfg = getConfig(guildId);
  if (!cfg.kontraktChannelId) return "";
  return `Контракт можно отправить только в <#${cfg.kontraktChannelId}>.`;
}

export function buildKontraktPanelEmbed(guildId) {
  const cfg = getConfig(guildId);
  return new EmbedBuilder()
    .setTitle("📋 Контракт")
    .setDescription(String(cfg.kontraktRulesText || "").slice(0, 4000))
    .setColor(COLOR_DARK);
}

export function kontraktPanelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("c:k:propose")
        .setLabel("Предложить")
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

function contractViewRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("c:k:join").setLabel("Участвовать").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("c:k:pinged").setLabel("Пикнул").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("c:k:reject").setLabel("Отказ").setStyle(ButtonStyle.Danger),
    ),
  ];
}

function buildContractEmbed(state) {
  return new EmbedBuilder()
    .setTitle((state.title || "Контракт").slice(0, 256))
    .setColor(COLOR_DARK)
    .addFields(
      {
        name: "Автор",
        value: `<@${state.creatorId}>\nКонтракт: ${(state.title || "—").slice(0, 256)}`,
        inline: false,
      },
      { name: "На 100%", value: state.razdel100 || "—", inline: false },
      {
        name: `Участники (${(state.participantIds || []).length}/${state.maxParticipants})`,
        value: mentionUsers(state.participantIds),
        inline: false,
      },
    )
    .setFooter({ text: `Людей: ${state.peopleNote} | Статус: ${state.statusNote}` })
    .setTimestamp(new Date());
}

async function refreshContract(client, messageId) {
  const state = getContract(messageId);
  if (!state) return false;
  const ch = await client.channels.fetch(state.channelId).catch(() => null);
  if (!ch?.isTextBased?.()) return false;
  const msg = await ch.messages.fetch(messageId).catch(() => null);
  if (!msg) return false;
  await msg.edit({
    embeds: [buildContractEmbed(state)],
    components: state.statusOpen ? contractViewRows() : [],
  });
  return true;
}

async function openThreadAndNotify(client, messageId, { decisionText, reason = "", actorId = null }) {
  const state = getContract(messageId);
  if (!state) return;
  const ch = await client.channels.fetch(state.channelId).catch(() => null);
  if (!ch?.isTextBased?.()) return;
  const msg = await ch.messages.fetch(messageId).catch(() => null);
  if (!msg) return;
  let thread;
  try {
    thread = await msg.startThread({
      name: `Контракт · ${decisionText}`.slice(0, 100),
      autoArchiveDuration: 1440,
    });
  } catch {
    return;
  }
  const targets = (state.participantIds || []).length
    ? state.participantIds.map((id) => `<@${id}>`)
    : [`<@${state.creatorId}>`];
  const actorPart = actorId ? `\nМодератор: <@${actorId}>` : "";
  const reasonPart = reason ? `\nПричина: ${reason}` : "";
  const text = `${targets.join(" ")}\nВас ${decisionText.toLowerCase()} по контракту **${state.title}**.${actorPart}${reasonPart}`;
  await thread.send({ content: text.slice(0, 2000), allowedMentions: { users: true } });
}

function proposeModal() {
  return new ModalBuilder()
    .setCustomId("c:k:form")
    .setTitle("Предложить контракт")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("Название")
          .setPlaceholder("Например: Ограбление фуры")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(120)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("razdel")
          .setLabel("На 100%")
          .setPlaceholder("Да / Нет")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("people")
          .setLabel("Люди")
          .setPlaceholder("Например: От 2-6")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true),
      ),
    );
}

function rejectModal() {
  return new ModalBuilder()
    .setCustomId("c:k:rejform")
    .setTitle("Причина отказа")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Причина")
          .setPlaceholder("Коротко: почему отказ")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(300)
          .setRequired(false),
      ),
    );
}

export async function handleKontraktInteraction(interaction) {
  const id = interaction.customId || "";
  if (!id.startsWith("c:k:")) return false;

  if (interaction.isButton() && id === "c:k:propose") {
    if (!kontraktAllowedInChannel(interaction)) {
      await safeReply(interaction, kontraktChannelRestrictionMessage(interaction.guildId));
      return true;
    }
    await interaction.showModal(proposeModal());
    return true;
  }

  if (interaction.isModalSubmit() && id === "c:k:form") {
    if (!interaction.guild || !interaction.channel) {
      await safeReply(interaction, "Используйте на сервере.");
      return true;
    }
    if (interaction.channel.type !== ChannelType.GuildText) {
      await safeReply(interaction, "Контракт можно публиковать только в текстовом канале.");
      return true;
    }
    if (!kontraktAllowedInChannel(interaction)) {
      await safeReply(interaction, kontraktChannelRestrictionMessage(interaction.guildId));
      return true;
    }
    const { cap, note } = parsePeopleCap(interaction.fields.getTextInputValue("people"));
    const state = {
      channelId: interaction.channel.id,
      creatorId: interaction.user.id,
      creatorTag: interaction.member?.displayName || interaction.user.username,
      title: interaction.fields.getTextInputValue("title").trim(),
      veksels: "—",
      timeSlot: "—",
      razdel100: interaction.fields.getTextInputValue("razdel").trim(),
      peopleNote: note,
      maxParticipants: cap,
      participantIds: [],
      statusOpen: true,
      statusNote: "Открыт",
    };
    const cfg = getConfig(interaction.guildId);
    const pingMentions = [];
    const allowedRoles = [];
    for (const rid of cfg.kontraktNewContractPingRoleIds || []) {
      const role = interaction.guild.roles.cache.get(String(rid));
      if (role) {
        pingMentions.push(role.toString());
        allowedRoles.push(role.id);
      }
    }
    const msg = await interaction.channel.send({
      content: pingMentions.length ? pingMentions.join(" ") : undefined,
      embeds: [buildContractEmbed(state)],
      components: contractViewRows(),
      allowedMentions: allowedRoles.length ? { roles: allowedRoles } : { parse: [] },
    });
    setContract(msg.id, state);
    await interaction.reply({ content: "Контракт опубликован.", ephemeral: true });
    return true;
  }

  if (interaction.isButton() && id === "c:k:join") {
    const msg = interaction.message;
    if (!msg) {
      await safeReply(interaction, "Не удалось обработать нажатие.");
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    const result = await withLock(`kontrakt:${msg.id}`, async () => {
      const state = getContract(msg.id);
      if (!state) return { ok: false, text: "Контракт не найден." };
      if (!state.statusOpen) return { ok: false, text: "Контракт уже закрыт." };
      if ((state.participantIds || []).includes(interaction.user.id)) {
        return { ok: false, text: "Вы уже в списке." };
      }
      if ((state.participantIds || []).length >= state.maxParticipants) {
        return { ok: false, text: "Список уже заполнен." };
      }
      state.participantIds = [...(state.participantIds || []), interaction.user.id];
      setContract(msg.id, state);
      return { ok: true, text: "Вы добавлены в контракт.", refresh: true };
    });
    if (result.refresh) await refreshContract(interaction.client, msg.id);
    await interaction.editReply(result.text);
    return true;
  }

  if (interaction.isButton() && id === "c:k:pinged") {
    const msg = interaction.message;
    if (!msg) {
      await safeReply(interaction, "Не удалось обработать нажатие.");
      return true;
    }
    if (!(await canManageKontrakt(interaction))) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Нет доступа")
            .setDescription("Пикнул и Отказ доступны модераторам или ролям из настроек контрактов.")
            .setColor(COLOR_RED),
        ],
        ephemeral: true,
      });
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    const result = await withLock(`kontrakt:${msg.id}`, async () => {
      const state = getContract(msg.id);
      if (!state) return { ok: false, text: "Контракт не найден." };
      if (!state.statusOpen) return { ok: false, text: "Контракт уже закрыт." };
      state.statusOpen = false;
      state.statusNote = "Пикнул";
      setContract(msg.id, state);
      return { ok: true, text: "Контракт отмечен: Пикнул.", notify: true };
    });
    if (result.ok) {
      await refreshContract(interaction.client, msg.id);
      if (result.notify) {
        await openThreadAndNotify(interaction.client, msg.id, {
          decisionText: "Пикнули",
          actorId: interaction.user.id,
        });
      }
    }
    await interaction.editReply(result.text);
    return true;
  }

  if (interaction.isButton() && id === "c:k:reject") {
    const msg = interaction.message;
    if (!msg) {
      await safeReply(interaction, "Не удалось обработать нажатие.");
      return true;
    }
    const state = getContract(msg.id);
    if (!state) {
      await safeReply(interaction, "Контракт не найден.");
      return true;
    }
    if (!(await canManageKontrakt(interaction))) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Нет доступа")
            .setDescription("Пикнул и Отказ доступны модераторам или ролям из настроек контрактов.")
            .setColor(COLOR_RED),
        ],
        ephemeral: true,
      });
      return true;
    }
    pendingReject.set(`${interaction.user.id}:${interaction.guildId}`, msg.id);
    await interaction.showModal(rejectModal());
    return true;
  }

  if (interaction.isModalSubmit() && id === "c:k:rejform") {
    const messageId = pendingReject.get(`${interaction.user.id}:${interaction.guildId}`);
    pendingReject.delete(`${interaction.user.id}:${interaction.guildId}`);
    if (!(await canManageKontrakt(interaction))) {
      await safeReply(interaction, "Нет доступа.");
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    const reason = (interaction.fields.getTextInputValue("reason") || "").trim().slice(0, 300);
    const result = await withLock(`kontrakt:${messageId || "x"}`, async () => {
      const state = messageId ? getContract(messageId) : null;
      if (!state) return { ok: false, text: "Контракт не найден или уже закрыт." };
      if (!state.statusOpen) return { ok: false, text: "Контракт уже закрыт." };
      state.statusOpen = false;
      state.statusNote = `Отказ: ${reason.slice(0, 120) || "без причины"}`;
      setContract(messageId, state);
      return { ok: true, text: "Контракт закрыт с отказом.", messageId, reason };
    });
    if (result.ok) {
      await refreshContract(interaction.client, result.messageId);
      await openThreadAndNotify(interaction.client, result.messageId, {
        decisionText: "Отказали",
        reason: result.reason || "без причины",
        actorId: interaction.user.id,
      });
    }
    await interaction.editReply(result.text);
    return true;
  }

  return true;
}

const pendingReject = new Map();
