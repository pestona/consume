import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from "discord.js";
import { getConfig } from "./config.js";
import { kvGet, kvSet } from "./db.js";
import { COLOR_DARK, hasAnyRole, logJson, safeReply, withLock } from "./util.js";

const V2 = MessageFlags.IsComponentsV2;
const V2_EPH = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;
const creating = new Set();
const emptyTimers = new Map();

function roomsState() {
  const data = kvGet("tempVoices") || {};
  data.byChannel = data.byChannel || {};
  return data;
}

function saveRooms(data) {
  kvSet("tempVoices", { byChannel: data.byChannel });
}

function getRoom(channelId) {
  return roomsState().byChannel[String(channelId)] || null;
}

function setRoom(channelId, row) {
  const data = roomsState();
  data.byChannel[String(channelId)] = row;
  saveRooms(data);
}

function deleteRoom(channelId) {
  const data = roomsState();
  delete data.byChannel[String(channelId)];
  saveRooms(data);
}

function findOwnedRoom(guild, userId) {
  const data = roomsState();
  for (const [id, row] of Object.entries(data.byChannel)) {
    if (row.guildId === String(guild.id) && row.ownerId === String(userId)) {
      const ch = guild.channels.cache.get(id);
      if (ch) return { channel: ch, row };
      deleteRoom(id);
    }
  }
  return null;
}

function findMemberRoom(guild, member) {
  const owned = findOwnedRoom(guild, member.id);
  if (owned) return owned;
  const voiceId = member.voice?.channelId;
  if (!voiceId) return null;
  const row = getRoom(voiceId);
  if (!row) return null;
  const ch = guild.channels.cache.get(voiceId);
  return ch ? { channel: ch, row } : null;
}

function isFamily(member, cfg) {
  const ids = cfg.familyRoleIds || [];
  if (!ids.length) return false;
  return hasAnyRole(member, ids);
}

function isOwnerOrManager(member, row, cfg) {
  if (!member || !row) return false;
  if (String(row.ownerId) === String(member.id)) return true;
  if (member.permissions?.has?.(PermissionFlagsBits.ManageChannels)) return true;
  return hasAnyRole(member, cfg.moderatorRoleIds || []);
}

export function tempVoicePanelPayload() {
  const body =
    `## Возможные манипуляции в вашей комнате\n` +
    `👤+ = Добавить 1 слот в вашу комнату\n` +
    `👤− = Убрать 1 слот из вашей комнаты\n` +
    `🔒 = Разрешить/запретить вход пользователям в вашу комнату\n` +
    `🔊 = Запретить/выдать пользователю возможность говорить в вашей комнате\n` +
    `❌ = Исключить пользователя из вашей комнаты\n` +
    `🎧 = Изменить битрейт вашей комнаты\n` +
    `👥 = Установить количество слотов в комнате\n` +
    `👑 = Передать право владения комнатой\n` +
    `📝 = Сменить название вашей комнаты\n` +
    `🔓 = Выдать/забрать доступ пользователю в вашу комнату\n\n` +
    `😤 Создание временных комнат — только для участников семьи **Consume**!`;

  const container = new ContainerBuilder()
    .setAccentColor(COLOR_DARK)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("c:tv:slot+").setEmoji("👤").setLabel("+").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("c:tv:slot-").setEmoji("👤").setLabel("−").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("c:tv:lock").setEmoji("🔒").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("c:tv:mute").setEmoji("🔊").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("c:tv:kick").setEmoji("❌").setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("c:tv:bitrate").setEmoji("🎧").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("c:tv:slots").setEmoji("👥").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("c:tv:owner").setEmoji("👑").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("c:tv:rename").setEmoji("📝").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("c:tv:access").setEmoji("🔓").setStyle(ButtonStyle.Secondary),
  );

  container.addActionRowComponents(row1, row2);
  return { components: [container], flags: V2 };
}

function eph(text) {
  return {
    components: [
      new ContainerBuilder()
        .setAccentColor(COLOR_DARK)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(text)),
    ],
    flags: V2_EPH,
  };
}

async function requireOwnedRoom(interaction) {
  const cfg = getConfig(interaction.guildId);
  const member = interaction.member;
  const found = findMemberRoom(interaction.guild, member);
  if (!found) {
    await interaction.reply(eph("У тебя нет временной комнаты. Зайди в канал создания комнаты.")).catch(() => null);
    return null;
  }
  if (!isOwnerOrManager(member, found.row, cfg)) {
    await interaction.reply(eph("Только владелец комнаты может это делать.")).catch(() => null);
    return null;
  }
  return found;
}

function userPickRow(customId, placeholder) {
  return new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(1).setMaxValues(1),
  );
}

function isHiddenOrAfkVoice(channel, guild, cfg) {
  if (!channel) return true;
  if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) return true;
  if (guild.afkChannelId && String(channel.id) === String(guild.afkChannelId)) return true;
  if (cfg.tempVoiceCreateChannelId && String(channel.id) === String(cfg.tempVoiceCreateChannelId)) return true;
  const everyoneView = channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel);
  if (!everyoneView) return true;
  return false;
}

/** Собрать людей из видимых войсов к текущему войсу нажавшего (AFK/скрытые не трогаем). */
export async function gatherEveryoneToMe(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;
  const dest = member?.voice?.channel;
  if (!dest || (dest.type !== ChannelType.GuildVoice && dest.type !== ChannelType.GuildStageVoice)) {
    await safeReply(interaction, "Сначала зайди в голосовой канал — туда и соберу.");
    return;
  }

  const cfg = getConfig(guild.id);
  const targets = [];

  for (const ch of guild.channels.cache.values()) {
    if (String(ch.id) === String(dest.id)) continue;
    if (isHiddenOrAfkVoice(ch, guild, cfg)) continue;
    for (const m of ch.members.values()) {
      if (m.user.bot) continue;
      if (String(m.id) === String(interaction.user.id)) continue;
      targets.push(m);
    }
  }

  if (!targets.length) {
    await safeReply(interaction, "Некого перемещать — в видимых войсах никого нет.");
    return;
  }

  const need = (dest.members?.size || 0) + targets.length;
  const lim = dest.userLimit || 0;
  if (lim > 0 && need > lim) {
    await dest.setUserLimit(0).catch(() => null);
  }

  await interaction.deferReply({ ephemeral: true }).catch(() => null);

  let moved = 0;
  let failed = 0;
  for (const m of targets) {
    try {
      await m.voice.setChannel(dest, "Consume: все ко мне");
      moved += 1;
    } catch {
      failed += 1;
    }
  }

  const text =
    failed > 0
      ? `Переместил **${moved}**, не удалось: **${failed}**.`
      : `Переместил к тебе: **${moved}**.`;
  await interaction.editReply({ content: text }).catch(() => null);
}

export async function handleTempVoiceInteraction(interaction) {
  const id = interaction.customId || "";
  if (!id.startsWith("c:tv:")) return false;
  if (!interaction.guild) {
    await safeReply(interaction, "Только на сервере.");
    return true;
  }

  if (interaction.isButton() && id === "c:tv:slot+") {
    const found = await requireOwnedRoom(interaction);
    if (!found) return true;
    const lim = found.channel.userLimit || 0;
    const next = Math.min(99, lim === 0 ? 2 : lim + 1);
    await found.channel.setUserLimit(next).catch(() => null);
    await interaction.reply(eph(`Слотов теперь: **${next}**`));
    return true;
  }

  if (interaction.isButton() && id === "c:tv:slot-") {
    const found = await requireOwnedRoom(interaction);
    if (!found) return true;
    const lim = found.channel.userLimit || 0;
    const next = lim <= 1 ? 0 : lim - 1;
    await found.channel.setUserLimit(next).catch(() => null);
    await interaction.reply(eph(next ? `Слотов теперь: **${next}**` : "Лимит слотов снят."));
    return true;
  }

  if (interaction.isButton() && id === "c:tv:lock") {
    const found = await requireOwnedRoom(interaction);
    if (!found) return true;
    const everyone = interaction.guild.roles.everyone;
    const over = found.channel.permissionOverwrites.cache.get(everyone.id);
    const locked = over?.deny?.has?.(PermissionFlagsBits.Connect);
    await found.channel.permissionOverwrites
      .edit(everyone, { Connect: locked ? null : false })
      .catch(() => null);
    await interaction.reply(eph(locked ? "Комната **открыта**." : "Комната **закрыта** (вход запрещён @everyone)."));
    return true;
  }

  if (interaction.isButton() && ["c:tv:mute", "c:tv:kick", "c:tv:owner", "c:tv:access"].includes(id)) {
    const found = await requireOwnedRoom(interaction);
    if (!found) return true;
    const map = {
      "c:tv:mute": ["c:tv:pick:mute", "Кого замьютить / размьютить?"],
      "c:tv:kick": ["c:tv:pick:kick", "Кого исключить из комнаты?"],
      "c:tv:owner": ["c:tv:pick:owner", "Кому передать комнату?"],
      "c:tv:access": ["c:tv:pick:access", "Кому выдать / забрать доступ?"],
    };
    const [cid, ph] = map[id];
    await interaction.reply({
      components: [
        new ContainerBuilder()
          .setAccentColor(COLOR_DARK)
          .addTextDisplayComponents(new TextDisplayBuilder().setContent("Выбери пользователя:"))
          .addActionRowComponents(userPickRow(cid, ph)),
      ],
      flags: V2_EPH,
    });
    return true;
  }

  if (interaction.isButton() && id === "c:tv:bitrate") {
    const found = await requireOwnedRoom(interaction);
    if (!found) return true;
    const modal = new ModalBuilder().setCustomId("c:tv:modal:bitrate").setTitle("Битрейт комнаты");
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("bitrate")
          .setLabel("Битрейт (8–96 кбит/с)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(Math.round((found.channel.bitrate || 64000) / 1000))),
      ),
    );
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isButton() && id === "c:tv:slots") {
    const found = await requireOwnedRoom(interaction);
    if (!found) return true;
    const modal = new ModalBuilder().setCustomId("c:tv:modal:slots").setTitle("Количество слотов");
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("slots")
          .setLabel("Слоты (0 = без лимита, макс 99)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(found.channel.userLimit || 0)),
      ),
    );
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isButton() && id === "c:tv:rename") {
    const found = await requireOwnedRoom(interaction);
    if (!found) return true;
    const modal = new ModalBuilder().setCustomId("c:tv:modal:rename").setTitle("Название комнаты");
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("name")
          .setLabel("Новое название")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
          .setValue(found.channel.name.slice(0, 100)),
      ),
    );
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isModalSubmit() && id === "c:tv:modal:bitrate") {
    const found = await requireOwnedRoom(interaction);
    if (!found) return true;
    const n = Number(interaction.fields.getTextInputValue("bitrate"));
    if (!Number.isFinite(n) || n < 8 || n > 96) {
      await interaction.reply(eph("Битрейт: число от 8 до 96."));
      return true;
    }
    await found.channel.setBitrate(Math.round(n) * 1000).catch(() => null);
    await interaction.reply(eph(`Битрейт: **${Math.round(n)}** кбит/с`));
    return true;
  }

  if (interaction.isModalSubmit() && id === "c:tv:modal:slots") {
    const found = await requireOwnedRoom(interaction);
    if (!found) return true;
    const n = Number(interaction.fields.getTextInputValue("slots"));
    if (!Number.isInteger(n) || n < 0 || n > 99) {
      await interaction.reply(eph("Слоты: целое 0–99."));
      return true;
    }
    await found.channel.setUserLimit(n).catch(() => null);
    await interaction.reply(eph(n ? `Слотов: **${n}**` : "Лимит слотов снят."));
    return true;
  }

  if (interaction.isModalSubmit() && id === "c:tv:modal:rename") {
    const found = await requireOwnedRoom(interaction);
    if (!found) return true;
    const name = String(interaction.fields.getTextInputValue("name") || "")
      .trim()
      .slice(0, 100);
    if (!name) {
      await interaction.reply(eph("Пустое название."));
      return true;
    }
    await found.channel.setName(name).catch(() => null);
    await interaction.reply(eph(`Название: **${name}**`));
    return true;
  }

  if (interaction.isUserSelectMenu() && id.startsWith("c:tv:pick:")) {
    const found = await requireOwnedRoom(interaction);
    if (!found) return true;
    const targetId = interaction.values[0];
    const action = id.slice("c:tv:pick:".length);
    const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);

    if (action === "kick") {
      if (targetMember?.voice?.channelId === found.channel.id) {
        await targetMember.voice.disconnect("Исключён из комнаты Consume").catch(() => null);
      }
      await interaction.update(eph(`Исключил <@${targetId}> из комнаты.`));
      return true;
    }

    if (action === "mute") {
      const over = found.channel.permissionOverwrites.cache.get(targetId);
      const muted = over?.deny?.has?.(PermissionFlagsBits.Speak);
      await found.channel.permissionOverwrites
        .edit(targetId, { Speak: muted ? null : false })
        .catch(() => null);
      await interaction.update(eph(muted ? `Размьютил <@${targetId}>.` : `Замьютил <@${targetId}>.`));
      return true;
    }

    if (action === "access") {
      const over = found.channel.permissionOverwrites.cache.get(targetId);
      const allowed = over?.allow?.has?.(PermissionFlagsBits.Connect);
      if (allowed) {
        await found.channel.permissionOverwrites.delete(targetId).catch(() => null);
        await interaction.update(eph(`Забрал доступ у <@${targetId}>.`));
      } else {
        await found.channel.permissionOverwrites
          .edit(targetId, { Connect: true, ViewChannel: true })
          .catch(() => null);
        await interaction.update(eph(`Выдал доступ <@${targetId}>.`));
      }
      return true;
    }

    if (action === "owner") {
      if (!targetMember) {
        await interaction.update(eph("Пользователь не найден на сервере."));
        return true;
      }
      const cfg = getConfig(interaction.guildId);
      if (!isFamily(targetMember, cfg)) {
        await interaction.update(eph("Новый владелец должен быть из семьи Consume."));
        return true;
      }
      const data = roomsState();
      const row = data.byChannel[found.channel.id];
      if (row) {
        row.ownerId = String(targetId);
        saveRooms(data);
      }
      await found.channel.permissionOverwrites
        .edit(targetId, {
          Connect: true,
          Speak: true,
          ManageChannels: true,
          MoveMembers: true,
        })
        .catch(() => null);
      await interaction.update(eph(`Владелец комнаты теперь <@${targetId}>.`));
      return true;
    }
  }

  await safeReply(interaction, "Неизвестное действие комнаты.");
  return true;
}

async function createTempRoom(state) {
  const member = state.member;
  const guild = state.guild;
  if (!member || !guild || member.user.bot) return;

  const cfg = getConfig(guild.id);
  const createId = cfg.tempVoiceCreateChannelId;
  const categoryId = cfg.tempVoiceCategoryId;
  if (!createId || !categoryId) return;
  if (String(state.channelId) !== String(createId)) return;
  if (!isFamily(member, cfg)) return;

  const key = `${guild.id}:${member.id}`;
  if (creating.has(key)) return;
  creating.add(key);

  try {
    await withLock(`tv:create:${key}`, async () => {
      const existing = findOwnedRoom(guild, member.id);
      if (existing) {
        await member.voice.setChannel(existing.channel).catch(() => null);
        return;
      }

      const parent = guild.channels.cache.get(String(categoryId));
      if (!parent || parent.type !== ChannelType.GuildCategory) {
        logJson("WARN", "temp voice: category missing", { guildId: guild.id, categoryId });
        return;
      }

      const name = `🔊 ${member.displayName}`.slice(0, 100);
      const channel = await guild.channels.create({
        name,
        type: ChannelType.GuildVoice,
        parent: parent.id,
        userLimit: 5,
        reason: `Временная комната Consume · ${member.id}`,
      });

      // Права как у категории, сверху — владелец комнаты (и бот).
      await channel.permissionOverwrites
        .edit(member.id, {
          ViewChannel: true,
          Connect: true,
          Speak: true,
          ManageChannels: true,
          MoveMembers: true,
        })
        .catch(() => null);
      if (guild.members.me) {
        await channel.permissionOverwrites
          .edit(guild.members.me.id, {
            ViewChannel: true,
            Connect: true,
            ManageChannels: true,
            MoveMembers: true,
          })
          .catch(() => null);
      }

      setRoom(channel.id, {
        guildId: String(guild.id),
        ownerId: String(member.id),
        createdAt: Date.now(),
      });

      await member.voice.setChannel(channel).catch(async () => {
        await channel.delete("Владелец не перешёл в комнату").catch(() => null);
        deleteRoom(channel.id);
      });
    });
  } catch (err) {
    logJson("ERROR", "temp voice create", { error: String(err), guildId: guild.id });
  } finally {
    creating.delete(key);
  }
}

function scheduleEmptyDelete(channel) {
  const id = channel.id;
  if (emptyTimers.has(id)) clearTimeout(emptyTimers.get(id));
  const t = setTimeout(async () => {
    emptyTimers.delete(id);
    try {
      const fresh = channel.guild.channels.cache.get(id) || (await channel.guild.channels.fetch(id).catch(() => null));
      if (!fresh || fresh.members?.size) return;
      if (!getRoom(id)) return;
      await fresh.delete("Пустая временная комната Consume").catch(() => null);
      deleteRoom(id);
    } catch (err) {
      logJson("WARN", "temp voice delete", { error: String(err) });
    }
  }, 2500);
  emptyTimers.set(id, t);
}

export async function onTempVoiceState(oldState, newState) {
  try {
    if (newState.channelId && !oldState.channelId) {
      await createTempRoom(newState);
    } else if (newState.channelId && oldState.channelId && newState.channelId !== oldState.channelId) {
      await createTempRoom(newState);
    }

    if (oldState.channelId && getRoom(oldState.channelId)) {
      const ch = oldState.channel || oldState.guild.channels.cache.get(oldState.channelId);
      if (ch && (!ch.members || ch.members.size === 0)) scheduleEmptyDelete(ch);
    }
  } catch (err) {
    logJson("ERROR", "temp voice state", { error: String(err) });
  }
}
