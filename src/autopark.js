import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { getConfig } from "./config.js";
import {
  deleteAutoparkCar,
  getAutoparkCar,
  listAutoparkCars,
  listAutoparkPanels,
  registerAutoparkPanel,
  removeAutoparkPanel,
  upsertAutoparkCar,
  allAutoparkCarsEntries,
} from "./db.js";
import { canManageAutopark } from "./perms.js";
import { COLOR_DARK, embedLinesValue, hasAnyRole, logJson, resolveMember, safeReply, withLock } from "./util.js";

function userHasAccess(member, car) {
  if (!car.roleIds?.length) return true;
  return hasAnyRole(member, car.roleIds);
}

function loadCars(guildId) {
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  for (const car of listAutoparkCars(guildId)) {
    let reservedBy = car.reservedBy ?? null;
    let reservedUntil = car.reservedUntilTs ?? null;
    if (reservedUntil != null && reservedUntil <= now) {
      reservedBy = null;
      reservedUntil = null;
      upsertAutoparkCar(guildId, { ...car, reservedBy: null, reservedUntilTs: null });
    }
    out.push({ ...car, reservedBy, reservedUntilTs: reservedUntil });
  }
  return out;
}

function autoparkEmbed(guild) {
  const cars = loadCars(guild.id);
  const free = cars.filter((c) => !c.reservedBy);
  const busy = cars.filter((c) => c.reservedBy);
  const now = Math.floor(Date.now() / 1000);

  const carLine = (c) => {
    const parts = [`• ${c.label}`];
    if (c.note) parts.push(c.note);
    if (c.roleIds?.length) {
      const mentions = c.roleIds.filter((rid) => guild.roles.cache.has(String(rid))).map((rid) => `<@&${rid}>`);
      if (mentions.length) parts.push(mentions.join(" "));
    }
    return parts.join("\n");
  };

  const linesBusy = busy.slice(0, 20).map((c) => {
    let left = "";
    if (c.reservedUntilTs != null) {
      const mins = Math.max(0, Math.floor((c.reservedUntilTs - now) / 60));
      left = mins >= 60 ? `(через ${Math.max(1, Math.round(mins / 60))} часа)` : `(через ${mins} мин)`;
    }
    const who = c.reservedBy ? ` <@${c.reservedBy}>` : "";
    return left ? `• ${c.label}${who}\n${left}` : `• ${c.label}${who}`;
  });

  return new EmbedBuilder()
    .setTitle("🚗 Автопарк: Car")
    .setDescription("Актуальный статус автомобилей.")
    .setColor(COLOR_DARK)
    .setTimestamp(new Date())
    .addFields(
      {
        name: `🟢 Свободные (${free.length})`,
        value: embedLinesValue(free.slice(0, 40).map(carLine)),
        inline: false,
      },
      { name: `🔴 Занятые (${busy.length})`, value: embedLinesValue(linesBusy), inline: false },
    )
    .setFooter({ text: " " });
}

export function autoparkPanelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("c:ap:take").setLabel("Занять авто").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("c:ap:rel").setLabel("Освободить авто").setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("c:ap:edit")
        .setLabel("Изменить список")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("✏️"),
    ),
  ];
}

export async function refreshAutoparkPanels(client, guildId) {
  const guild = client.guilds.cache.get(String(guildId));
  if (!guild) return;
  const emb = autoparkEmbed(guild);
  for (const panel of listAutoparkPanels(guildId)) {
    const ch = guild.channels.cache.get(panel.channelId);
    if (!ch?.isTextBased?.()) {
      removeAutoparkPanel(panel.messageId);
      continue;
    }
    try {
      const msg = await ch.messages.fetch(panel.messageId);
      await msg.edit({ embeds: [emb], components: autoparkPanelRows() });
    } catch (err) {
      if (err?.code === 10008 || err?.code === 50001) removeAutoparkPanel(panel.messageId);
    }
  }
}

export function registerPanel(guildId, channelId, messageId) {
  registerAutoparkPanel(guildId, channelId, messageId);
}

export function buildAutoparkEmbed(guild) {
  return autoparkEmbed(guild);
}

function claim(guildId, carKey, userId, minutes) {
  const now = Math.floor(Date.now() / 1000);
  const car = getAutoparkCar(guildId, carKey);
  if (!car) return false;
  if (car.reservedBy && car.reservedUntilTs && car.reservedUntilTs > now) return false;
  upsertAutoparkCar(guildId, {
    ...car,
    reservedBy: userId,
    reservedUntilTs: now + minutes * 60,
  });
  return true;
}

function release(guildId, carKey, actorId, force) {
  const car = getAutoparkCar(guildId, carKey);
  if (!car?.reservedBy) return false;
  if (!force && String(car.reservedBy) !== String(actorId)) return false;
  upsertAutoparkCar(guildId, { ...car, reservedBy: null, reservedUntilTs: null });
  return true;
}

export function expireOverdue() {
  const now = Math.floor(Date.now() / 1000);
  const touched = new Set();
  for (const [key, car] of allAutoparkCarsEntries()) {
    if (car.reservedUntilTs != null && car.reservedUntilTs <= now) {
      const [guildId] = key.split(":");
      touched.add(guildId);
      upsertAutoparkCar(guildId, { ...car, reservedBy: null, reservedUntilTs: null });
    }
  }
  return [...touched];
}

function addModal() {
  return new ModalBuilder()
    .setCustomId("c:ap:addform")
    .setTitle("Добавить авто в список")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("key")
          .setLabel("Ключ (уникальный ID)")
          .setPlaceholder("Например: PESTONA01")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(60)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("label")
          .setLabel("Как показывать в списке")
          .setPlaceholder("BMW M5 H90 LCI - PESTONA01")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(120)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("note")
          .setLabel("Текст под строкой (необязательно)")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(250)
          .setRequired(false),
      ),
    );
}

function editModal(car) {
  const modal = new ModalBuilder().setCustomId(`c:ap:edform:${car.key}`).setTitle("Изменить авто в списке");
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("label")
        .setLabel("Как показывать в списке")
        .setStyle(TextInputStyle.Short)
        .setMaxLength(120)
        .setRequired(true)
        .setValue(String(car.label || "").slice(0, 120)),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("note")
        .setLabel("Текст под строкой (необязательно)")
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(250)
        .setRequired(false)
        .setValue(String(car.note || "").slice(0, 250)),
    ),
  );
  return modal;
}

function editorRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("c:ap:add").setLabel("Добавить авто").setEmoji("➕").setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("c:ap:chg")
        .setLabel("Изменить позицию")
        .setEmoji("✏️")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("c:ap:del")
        .setLabel("Удалить из списка")
        .setEmoji("➖")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function carSelect(customId, cars, placeholder) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        cars.slice(0, 25).map((c) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(c.label.slice(0, 100))
            .setValue(c.key)
            .setDescription((c.note || c.key).slice(0, 100)),
        ),
      ),
  );
}

function accessRoleRow(carKey) {
  return new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId(`c:ap:roles:${carKey}`)
      .setPlaceholder("Кто может бронировать (пусто = все)")
      .setMinValues(0)
      .setMaxValues(25),
  );
}

export async function handleAutoparkInteraction(interaction) {
  const id = interaction.customId || "";
  if (!id.startsWith("c:ap:")) return false;

  if (interaction.isButton() && id === "c:ap:take") {
    const member = await resolveMember(interaction);
    if (!interaction.guild || !member) {
      await safeReply(interaction, "Только на сервере.");
      return true;
    }
    const free = loadCars(interaction.guild.id).filter((c) => !c.reservedBy && userHasAccess(member, c));
    if (!free.length) {
      await safeReply(interaction, "Нет доступных машин.");
      return true;
    }
    await interaction.reply({
      content: "Выбери авто, которое хочешь занять:",
      components: [carSelect("c:ap:claim", free, "Выбери авто для брони...")],
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isStringSelectMenu() && id === "c:ap:claim") {
    const member = await resolveMember(interaction);
    if (!interaction.guild || !member) {
      await safeReply(interaction, "Только на сервере.");
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    const key = interaction.values[0];
    const minutes = Math.max(1, Number(getConfig(interaction.guild.id).autoparkReserveMinutes) || 60);
    const ok = await withLock(`ap:${interaction.guild.id}:${key}`, async () =>
      claim(interaction.guild.id, key, interaction.user.id, minutes),
    );
    if (!ok) {
      await interaction.editReply("Не удалось занять авто (возможно, уже занято).");
      return true;
    }
    const car = getAutoparkCar(interaction.guild.id, key);
    await refreshAutoparkPanels(interaction.client, interaction.guild.id);
    await interaction.editReply(`Ты занял(а) **${car?.label || key}** на ${minutes} мин.`);
    return true;
  }

  if (interaction.isButton() && id === "c:ap:rel") {
    const member = await resolveMember(interaction);
    if (!interaction.guild || !member) {
      await safeReply(interaction, "Только на сервере.");
      return true;
    }
    const manager = await canManageAutopark(interaction);
    const busy = loadCars(interaction.guild.id).filter(
      (c) => c.reservedBy && (manager || String(c.reservedBy) === member.id),
    );
    if (!busy.length) {
      await safeReply(interaction, "У тебя нет активной брони.");
      return true;
    }
    await interaction.reply({
      content: "Выбери авто для освобождения:",
      components: [carSelect(manager ? "c:ap:relsef" : "c:ap:relse", busy, "Выбери авто для освобождения...")],
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isStringSelectMenu() && (id === "c:ap:relse" || id === "c:ap:relsef")) {
    await interaction.deferReply({ ephemeral: true });
    const key = interaction.values[0];
    const ok = await withLock(`ap:${interaction.guild.id}:${key}`, async () =>
      release(interaction.guild.id, key, interaction.user.id, id === "c:ap:relsef"),
    );
    if (!ok) {
      await interaction.editReply("Не удалось освободить авто.");
      return true;
    }
    await refreshAutoparkPanels(interaction.client, interaction.guild.id);
    await interaction.editReply("Авто освобождено.");
    return true;
  }

  if (interaction.isButton() && id === "c:ap:edit") {
    if (!(await canManageAutopark(interaction))) {
      await safeReply(interaction, "Редактировать список может только администрация.");
      return true;
    }
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Редактирование списка (видно только тебе)")
          .setDescription("Добавляй, изменяй или удаляй позиции — все панели автопарка на сервере обновятся.")
          .setColor(COLOR_DARK),
      ],
      components: editorRows(),
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isButton() && id === "c:ap:add") {
    if (!(await canManageAutopark(interaction))) {
      await safeReply(interaction, "Нет доступа.");
      return true;
    }
    await interaction.showModal(addModal());
    return true;
  }

  if (interaction.isModalSubmit() && id === "c:ap:addform") {
    if (!(await canManageAutopark(interaction))) {
      await safeReply(interaction, "Нет доступа к редактированию автопарка.");
      return true;
    }
    const key = interaction.fields.getTextInputValue("key").trim().toUpperCase();
    const label = interaction.fields.getTextInputValue("label").trim();
    const note = (interaction.fields.getTextInputValue("note") || "").trim();
    if (!key || !label) {
      await safeReply(interaction, "Нужны ключ и название.");
      return true;
    }
    upsertAutoparkCar(interaction.guild.id, {
      key,
      label,
      note,
      roleIds: [],
      reservedBy: null,
      reservedUntilTs: null,
    });
    await refreshAutoparkPanels(interaction.client, interaction.guild.id);
    await interaction.reply({
      content: `Добавил авто **${label}**. Выберите роли доступа (можно никого — тогда доступно всем):`,
      components: [accessRoleRow(key)],
      ephemeral: true,
    });
    return true;
  }

  const roleSet = id.match(/^c:ap:roles:(.+)$/);
  if (interaction.isRoleSelectMenu() && roleSet) {
    if (!(await canManageAutopark(interaction))) {
      await safeReply(interaction, "Нет доступа.");
      return true;
    }
    const car = getAutoparkCar(interaction.guild.id, roleSet[1]);
    if (!car) {
      await safeReply(interaction, "Позиция не найдена.");
      return true;
    }
    upsertAutoparkCar(interaction.guild.id, { ...car, roleIds: interaction.values });
    await refreshAutoparkPanels(interaction.client, interaction.guild.id);
    await interaction.update({
      content: interaction.values.length
        ? `Роли доступа для **${car.label}**: ${interaction.values.map((r) => `<@&${r}>`).join(" ")}`
        : `**${car.label}** доступно всем.`,
      components: [],
    });
    return true;
  }

  if (interaction.isButton() && id === "c:ap:chg") {
    const cars = loadCars(interaction.guild.id);
    if (!cars.length) {
      await safeReply(interaction, "Список пуст.");
      return true;
    }
    await interaction.reply({
      content: "Выбери позицию для изменения:",
      components: [carSelect("c:ap:edsel", cars, "Выбери авто для изменения...")],
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isStringSelectMenu() && id === "c:ap:edsel") {
    const car = getAutoparkCar(interaction.guild.id, interaction.values[0]);
    if (!car) {
      await safeReply(interaction, "Позиция не найдена.");
      return true;
    }
    await interaction.showModal(editModal(car));
    return true;
  }

  const edform = id.match(/^c:ap:edform:(.+)$/);
  if (interaction.isModalSubmit() && edform) {
    if (!(await canManageAutopark(interaction))) {
      await safeReply(interaction, "Нет доступа.");
      return true;
    }
    const existing = getAutoparkCar(interaction.guild.id, edform[1]);
    if (!existing) {
      await safeReply(interaction, "Позиция не найдена (возможно, уже удалена).");
      return true;
    }
    const label = interaction.fields.getTextInputValue("label").trim();
    const note = (interaction.fields.getTextInputValue("note") || "").trim();
    if (!label) {
      await safeReply(interaction, "Название не может быть пустым.");
      return true;
    }
    upsertAutoparkCar(interaction.guild.id, { ...existing, label, note });
    await refreshAutoparkPanels(interaction.client, interaction.guild.id);
    await interaction.reply({
      content: `Обновил авто **${label}**. При необходимости смените роли доступа:`,
      components: [accessRoleRow(existing.key)],
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isButton() && id === "c:ap:del") {
    const cars = loadCars(interaction.guild.id);
    if (!cars.length) {
      await safeReply(interaction, "Список пуст.");
      return true;
    }
    await interaction.reply({
      content: "Выбери позицию для удаления:",
      components: [carSelect("c:ap:delsel", cars, "Выбери авто, чтобы убрать из списка...")],
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isStringSelectMenu() && id === "c:ap:delsel") {
    if (!(await canManageAutopark(interaction))) {
      await safeReply(interaction, "Нет доступа.");
      return true;
    }
    const deleted = deleteAutoparkCar(interaction.guild.id, interaction.values[0]);
    await refreshAutoparkPanels(interaction.client, interaction.guild.id);
    await interaction.update({
      content: deleted ? "Позиция удалена." : "Не удалось удалить позицию.",
      components: [],
    });
    return true;
  }

  return true;
}

export async function autoparkExpireLoop(client) {
  while (true) {
    try {
      const touched = expireOverdue();
      for (const guildId of touched) await refreshAutoparkPanels(client, guildId);
    } catch (err) {
      logJson("ERROR", "autopark expire loop", { error: String(err) });
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}
