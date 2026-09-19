import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { kvGet, kvSet } from "./db.js";
import { getConfig } from "./config.js";
import { canHandleTicket, canOpenPanel } from "./perms.js";
import {
  COLOR_DARK,
  channelSlug,
  formatDateRu,
  hasAnyRole,
  isGuildManager,
  logJson,
  resolveMember,
  safeReply,
  withLock,
} from "./util.js";

const THREAD_NAMES = ["Рп мероприятия", "Капт/мцл", "Арена"];

function state() {
  const data = kvGet("archiveRooms") || {};
  data.byChannel = data.byChannel || {};
  data.byUser = data.byUser || {};
  return data;
}

function save(data) {
  kvSet("archiveRooms", {
    byChannel: data.byChannel,
    byUser: data.byUser,
  });
}

function userKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function getRoom(channelId) {
  return state().byChannel[String(channelId)] || null;
}

function getUserRoomId(guildId, userId) {
  return state().byUser[userKey(guildId, userId)] || null;
}

export async function canManageArchive(interaction) {
  const member = await resolveMember(interaction);
  if (!member) return false;
  if (isGuildManager(member)) return true;
  const cfg = getConfig(interaction.guildId);
  if (cfg.archiveModRoleIds?.length) return hasAnyRole(member, cfg.archiveModRoleIds);
  if (await canHandleTicket(interaction)) return true;
  return await canOpenPanel(interaction);
}

function rankChain(cfg) {
  const chain = (cfg.archiveRankChainRoleIds || []).map(String);
  if (chain.length) return chain;
  const low = cfg.archiveRankLowRoleId;
  const high = cfg.archiveRankHighRoleId;
  if (low && high && String(low) !== String(high)) return [String(low), String(high)];
  if (low) return [String(low)];
  if (high) return [String(high)];
  return [];
}

function currentRankId(member, cfg) {
  const chain = rankChain(cfg);
  let found = null;
  for (const id of chain) {
    if (member.roles.cache.has(id)) found = id;
  }
  return found;
}

function currentTierLabel(room, cfg) {
  const t = Number(room?.tier || 0);
  if (t === 1 && cfg.archiveTier1RoleId) return `<@&${cfg.archiveTier1RoleId}>`;
  if (t === 2 && cfg.archiveTier2RoleId) return `<@&${cfg.archiveTier2RoleId}>`;
  if (t === 3 && cfg.archiveTier3RoleId) return `<@&${cfg.archiveTier3RoleId}>`;
  if (t === 1) return "Тир 1";
  if (t === 2) return "Тир 2";
  if (t === 3) return "Тир 3";
  return "Нет тира";
}

function publicCreateEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR_DARK)
    .setTitle("📁 Создать канал архива")
    .setDescription(
      [
        "- В приватном канале люди с опытом оценят ваши откаты и решат — повысить вам ранг или порекомендовать дополнительную тренировку, указав на ошибки.",
        "- В вашем канале также идёт рассмотрение вашего Tier, решение принимают уполномоченные роли.",
        "- Видеоматериалы желательно заливать на видеохостинги `Youtube`, `Rutube`.",
      ].join("\n"),
    );
}

export function archiveCreateButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("c:arch:create")
      .setLabel("Создать канал")
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildArchivePublicPanel() {
  return { embeds: [publicCreateEmbed()], components: [archiveCreateButton()] };
}

function roomEmbed(member, room, cfg) {
  const rankId = currentRankId(member, cfg);
  return new EmbedBuilder()
    .setColor(COLOR_DARK)
    .setTitle("⬜ Личный канал архива")
    .setDescription(
      [
        `Личный канал участника — <@${member.id}>`,
        "",
        "- Отправляйте видео-откаты с МП в текстовый канал (желательно геймплей 10+ минут из сильных лобби).",
        "- Изучайте залазы — это важно для участия в основном составе на каптах.",
        "- Прикрепляйте откаты с лучшей стрельбой и демонстрацией понимания игры.",
      ].join("\n"),
    )
    .addFields(
      { name: "Текущий Ранг", value: rankId ? `<@&${rankId}>` : "—", inline: true },
      { name: "Текущий Тир", value: currentTierLabel(room, cfg), inline: true },
    )
    .setFooter({ text: formatDateRu(new Date()) });
}

function roomMenus() {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("c:arch:act")
        .setPlaceholder("Взаимодействие с каналом")
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel("Удалить канал").setValue("delete").setEmoji("🗑️"),
          new StringSelectMenuOptionBuilder().setLabel("Повышение ранга").setValue("rankup").setEmoji("↗️"),
          new StringSelectMenuOptionBuilder().setLabel("Понижение ранга").setValue("rankdown").setEmoji("↘️"),
        ),
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("c:arch:tier")
        .setPlaceholder("Выдача тира")
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel("Выдать Тир 1").setValue("t1").setEmoji("🥇"),
          new StringSelectMenuOptionBuilder().setLabel("Выдать Тир 2").setValue("t2").setEmoji("🥈"),
          new StringSelectMenuOptionBuilder().setLabel("Выдать Тир 3").setValue("t3").setEmoji("🥉"),
          new StringSelectMenuOptionBuilder().setLabel("Снять тир").setValue("toff").setEmoji("❌"),
        ),
    ),
  ];
}

async function refreshRoomPanel(channel, room, guild) {
  if (!room?.panelMessageId) return;
  const cfg = getConfig(guild.id);
  const owner = await guild.members.fetch(room.ownerId).catch(() => null);
  if (!owner) return;
  const msg = await channel.messages.fetch(room.panelMessageId).catch(() => null);
  if (!msg) return;
  await msg.edit({ embeds: [roomEmbed(owner, room, cfg)], components: roomMenus() }).catch(() => null);
}

async function createThreads(channel) {
  for (const name of THREAD_NAMES) {
    try {
      const starter = await channel.send({ content: `**${name}**` });
      await starter.startThread({
        name: name.slice(0, 100),
        autoArchiveDuration: 10080,
        reason: "Consume архив: ветка",
      });
    } catch (err) {
      logJson("WARN", "archive thread", { name, error: String(err) });
    }
  }
}

async function createArchiveRoom(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;
  const cfg = getConfig(guild.id);

  if (!cfg.archiveCategoryId) {
    await safeReply(interaction, "Категория архива не настроена. Админ → Архив.");
    return;
  }

  const existingId = getUserRoomId(guild.id, member.id);
  if (existingId) {
    const existing = guild.channels.cache.get(existingId);
    if (existing) {
      await safeReply(interaction, `У тебя уже есть канал: ${existing}`);
      return;
    }
  }

  await interaction.deferReply({ ephemeral: true });

  await withLock(`arch:create:${guild.id}:${member.id}`, async () => {
    const again = getUserRoomId(guild.id, member.id);
    if (again && guild.channels.cache.get(again)) {
      await interaction.editReply(`У тебя уже есть канал: <#${again}>`);
      return;
    }

    const overwrites = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: member.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.SendMessagesInThreads,
        ],
      },
      {
        id: guild.members.me.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.ManageThreads,
        ],
      },
    ];

    const modRoles = cfg.archiveModRoleIds?.length
      ? cfg.archiveModRoleIds
      : cfg.ticketStaffRoleIds?.length
        ? cfg.ticketStaffRoleIds
        : cfg.moderatorRoleIds || [];
    for (const rid of modRoles) {
      overwrites.push({
        id: rid,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.AttachFiles,
        ],
      });
    }

    const channel = await guild.channels.create({
      name: channelSlug(member.displayName, member.id.slice(-4), "arch"),
      type: ChannelType.GuildText,
      parent: cfg.archiveCategoryId,
      permissionOverwrites: overwrites,
      topic: `Архив · ${member.user.tag} · ${member.id}`,
      reason: `Consume архив для ${member.id}`,
    });

    const room = {
      guildId: String(guild.id),
      ownerId: String(member.id),
      panelMessageId: null,
      tier: 0,
      createdAt: Date.now(),
    };

    const panel = await channel.send({
      embeds: [roomEmbed(member, room, cfg)],
      components: roomMenus(),
    });
    room.panelMessageId = panel.id;

    const data = state();
    data.byChannel[channel.id] = room;
    data.byUser[userKey(guild.id, member.id)] = channel.id;
    save(data);

    await createThreads(channel);
    await interaction.editReply(`Канал создан: ${channel}`);
  });
}

async function deleteRoom(interaction, channel, room) {
  const data = state();
  delete data.byChannel[channel.id];
  const uk = userKey(room.guildId, room.ownerId);
  if (data.byUser[uk] === channel.id) delete data.byUser[uk];
  save(data);
  await interaction.update({ content: "Канал удаляется…", embeds: [], components: [] }).catch(() => null);
  await channel.delete("Consume архив: удаление").catch(() => null);
}

async function changeRank(interaction, member, direction) {
  const cfg = getConfig(interaction.guildId);
  const chain = rankChain(cfg);
  if (chain.length < 2) return false;
  const cur = currentRankId(member, cfg);
  let idx = cur ? chain.indexOf(cur) : -1;
  if (direction === "up") {
    const next = idx < 0 ? 0 : Math.min(chain.length - 1, idx + 1);
    const toAdd = chain[next];
    const toRemove = chain.filter((id) => id !== toAdd && member.roles.cache.has(id));
    if (toRemove.length) await member.roles.remove(toRemove, "Consume архив: повышение ранга").catch(() => null);
    if (!member.roles.cache.has(toAdd)) await member.roles.add(toAdd, "Consume архив: повышение ранга").catch(() => null);
  } else if (idx <= 0) {
    const toRemove = chain.filter((id) => member.roles.cache.has(id));
    if (toRemove.length) await member.roles.remove(toRemove, "Consume архив: понижение ранга").catch(() => null);
  } else {
    const next = chain[idx - 1];
    const toRemove = chain.filter((id) => id !== next && member.roles.cache.has(id));
    if (toRemove.length) await member.roles.remove(toRemove, "Consume архив: понижение ранга").catch(() => null);
    if (!member.roles.cache.has(next)) await member.roles.add(next, "Consume архив: понижение ранга").catch(() => null);
  }
  return true;
}

async function setTier(interaction, member, room, tier) {
  const cfg = getConfig(interaction.guildId);
  const map = {
    1: cfg.archiveTier1RoleId,
    2: cfg.archiveTier2RoleId,
    3: cfg.archiveTier3RoleId,
  };
  const all = [cfg.archiveTier1RoleId, cfg.archiveTier2RoleId, cfg.archiveTier3RoleId].filter(Boolean).map(String);
  if (all.length) {
    const remove = all.filter((id) => member.roles.cache.has(id));
    if (remove.length) await member.roles.remove(remove, "Consume архив: смена тира").catch(() => null);
  }
  if (tier && map[tier]) {
    await member.roles.add(String(map[tier]), `Consume архив: тир ${tier}`).catch(() => null);
  }
  room.tier = tier || 0;
  const data = state();
  data.byChannel[interaction.channelId] = room;
  save(data);
  return true;
}

export async function handleArchiveInteraction(interaction) {
  const id = interaction.customId || "";
  if (!id.startsWith("c:arch:")) return false;

  if (interaction.isButton() && id === "c:arch:create") {
    if (!interaction.guild || !interaction.member) {
      await safeReply(interaction, "Только на сервере.");
      return true;
    }
    try {
      await createArchiveRoom(interaction);
    } catch (err) {
      logJson("ERROR", "archive create", { error: String(err) });
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("Не удалось создать канал. Проверьте права бота и настройки Архива.").catch(() => null);
      } else {
        await safeReply(interaction, "Не удалось создать канал.");
      }
    }
    return true;
  }

  if (!interaction.guild || !interaction.channel) {
    await safeReply(interaction, "Только на сервере.");
    return true;
  }

  const room = getRoom(interaction.channelId);
  if (!room) {
    await safeReply(interaction, "Это не канал архива.");
    return true;
  }

  if (!(await canManageArchive(interaction))) {
    await safeReply(interaction, "Нет прав управлять архивом.");
    return true;
  }

  const owner = await interaction.guild.members.fetch(room.ownerId).catch(() => null);
  if (!owner) {
    await safeReply(interaction, "Владелец канала не найден на сервере.");
    return true;
  }

  if (interaction.isStringSelectMenu() && id === "c:arch:act") {
    const action = interaction.values[0];
    if (action === "delete") {
      await deleteRoom(interaction, interaction.channel, room);
      return true;
    }
    if (action === "rankup" || action === "rankdown") {
      await interaction.deferUpdate().catch(() => null);
      const ok = await changeRank(interaction, owner, action === "rankup" ? "up" : "down");
      if (!ok) {
        await interaction.followUp({ content: "Цепочка рангов не настроена (нужно минимум 2 роли).", ephemeral: true }).catch(() => null);
        return true;
      }
      const data = state();
      const fresh = data.byChannel[interaction.channelId] || room;
      await refreshRoomPanel(interaction.channel, fresh, interaction.guild);
      await interaction.followUp({
        content: action === "rankup" ? "Ранг повышен." : "Ранг понижен.",
        ephemeral: true,
      }).catch(() => null);
      return true;
    }
  }

  if (interaction.isStringSelectMenu() && id === "c:arch:tier") {
    const v = interaction.values[0];
    const tier = v === "t1" ? 1 : v === "t2" ? 2 : v === "t3" ? 3 : 0;
    await interaction.deferUpdate().catch(() => null);
    await setTier(interaction, owner, room, tier);
    await refreshRoomPanel(interaction.channel, room, interaction.guild);
    await interaction.followUp({
      content: tier ? `Выдан Тир ${tier}.` : "Тир снят.",
      ephemeral: true,
    }).catch(() => null);
    return true;
  }

  await safeReply(interaction, "Неизвестное действие архива.");
  return true;
}
