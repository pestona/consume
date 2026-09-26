import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
} from "discord.js";
import { kvGet, kvSet, getSbor, setSbor, getAllSbors } from "./db.js";
import { getConfig } from "./config.js";
import { canModerate } from "./perms.js";
import {
  COLOR_GREEN,
  COLOR_RED,
  formatDateRu,
  hasAnyRole,
  isGuildManager,
  logJson,
  resolveMember,
  safeDm,
  safeReply,
  withLock,
  MSK,
} from "./util.js";

const REACT_MAIN = "✅";
const REACT_SUB = "🔥";

function nextEventNo(guildId) {
  const key = `sborCounter:${guildId}`;
  const n = Number(kvGet(key) || 0) + 1;
  kvSet(key, n);
  return n;
}

function findByThread(threadId) {
  const tid = String(threadId);
  for (const [id, s] of Object.entries(getAllSbors())) {
    if (String(s.threadId) === tid) return { id, state: s };
  }
  return null;
}

function findByPanel(messageId) {
  const s = getSbor(messageId);
  return s ? { id: String(messageId), state: s } : null;
}

/** Парс "26.09.2026" / "26.09" + "14:11" → Date в MSK. */
export function parseSborDateTime(dateStr, timeStr) {
  const d = String(dateStr || "").trim();
  const t = String(timeStr || "").trim();
  const dm = d.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?$/);
  const tm = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!dm || !tm) return null;
  let year = dm[3] ? Number(dm[3]) : new Date().getFullYear();
  if (year < 100) year += 2000;
  const month = Number(dm[2]);
  const day = Number(dm[1]);
  const hour = Number(tm[1]);
  const minute = Number(tm[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  // MSK = UTC+3
  const utc = Date.UTC(year, month - 1, day, hour - 3, minute, 0);
  const dt = new Date(utc);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function fmtDate(dt) {
  return formatDateRu(dt, MSK);
}

function fmtTime(dt) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: MSK,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(dt);
}

function fmtShort(dt) {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: MSK,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(dt);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${get("day")}.${get("month")} в ${get("hour")}:${get("minute")}`;
}

function listMentions(ids) {
  if (!ids?.length) return "—";
  return ids.map((id, i) => `${i + 1}. <@${id}>`).join("\n").slice(0, 1024);
}

function removeFromAll(state, userId) {
  const uid = String(userId);
  const was =
    state.main.includes(uid) || state.subs.includes(uid) || state.reserve.includes(uid);
  state.main = state.main.filter((id) => id !== uid);
  state.subs = state.subs.filter((id) => id !== uid);
  state.reserve = state.reserve.filter((id) => id !== uid);
  return was;
}

function buildEmbed(state) {
  const at = new Date(state.startsAt);
  const left = Math.max(0, state.mainLimit - state.main.length);
  const status = state.open ? "🟢 Сбор открыт" : "🔴 Сбор закрыт";
  const color = state.open ? COLOR_GREEN : COLOR_RED;

  const info =
    `🗓️ **Дата:** ${fmtDate(at)}\n` +
    `⏳ **Время:** ${fmtTime(at)}\n` +
    `📌 **Сбор:** ${fmtShort(at)}\n` +
    `👤 **Организатор:** <@${state.organizerId}>\n` +
    `📢 **ЛС роль:** ${state.dmRoleId ? `<@&${state.dmRoleId}>` : "—"}`;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`Мероприятие: ${state.eventNo}`)
    .addFields(
      { name: "Информация", value: info, inline: false },
      {
        name: `Участники (${state.main.length}/${state.mainLimit})`,
        value: listMentions(state.main),
        inline: true,
      },
      {
        name: `Замены (${state.subs.length}/${state.subLimit})`,
        value: listMentions(state.subs),
        inline: true,
      },
      {
        name: `Резерв (${state.reserve.length})`,
        value: listMentions(state.reserve),
        inline: true,
      },
    )
    .setFooter({
      text: `Записано: ${state.main.length}/${state.mainLimit} (осталось ${left}) | Замена: ${state.subs.length} | ${status}`,
    });
}

function adminRows(state) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`c:sbor:close:${state.messageId}`)
        .setLabel("Завершить сбор")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!state.open),
      new ButtonBuilder()
        .setCustomId(`c:sbor:resume:${state.messageId}`)
        .setLabel("Возобновить сбор")
        .setStyle(ButtonStyle.Success)
        .setDisabled(state.open),
      new ButtonBuilder()
        .setCustomId(`c:sbor:postpone:${state.messageId}`)
        .setLabel("Перенос")
        .setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`c:sbor:ping:${state.messageId}`)
        .setLabel("Позвать всех (@everyone)")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`c:sbor:voice:${state.messageId}`)
        .setLabel("Все в войс")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`c:sbor:dm:${state.messageId}`)
        .setLabel("Напомнить всем (ЛС)")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

const HOW_TO =
  "📋 **Как записаться:**\n" +
  "• Напиши `+` — попадёшь в резерв\n" +
  "• Модератор ставит ✅ — основа · 🔥 — запасные\n" +
  "• Снятие ✅/🔥 — назад в резерв\n" +
  "• Напиши `-` — уберёшь плюс";

async function refreshPanel(client, messageId) {
  const state = getSbor(messageId);
  if (!state) return;
  try {
    const ch = await client.channels.fetch(state.channelId).catch(() => null);
    if (!ch?.isTextBased?.()) return;
    const msg = await ch.messages.fetch(state.messageId).catch(() => null);
    if (!msg) return;
    await msg.edit({ embeds: [buildEmbed(state)], components: adminRows(state) });
  } catch (err) {
    logJson("WARN", "sbor refresh", { messageId, error: String(err) });
  }
}

async function threadSend(client, state, content, opts = {}) {
  if (!state.threadId) return;
  const thr = await client.channels.fetch(state.threadId).catch(() => null);
  if (!thr?.isTextBased?.()) return;
  await thr.send({ content, ...opts }).catch(() => null);
}

async function canManageSbor(interaction, state) {
  if (String(interaction.user.id) === String(state.organizerId)) return true;
  return canModerate(interaction);
}

async function memberCanMod(member, guild, state) {
  if (!member) return false;
  if (String(member.id) === String(state.organizerId)) return true;
  if (isGuildManager(member)) return true;
  const cfg = getConfig(guild.id);
  return hasAnyRole(member, cfg.moderatorRoleIds);
}

export async function handleSborCommand(interaction) {
  if (!interaction.guild) {
    await safeReply(interaction, "Только на сервере.");
    return;
  }
  if (!(await canModerate(interaction))) {
    await safeReply(interaction, "Нет прав создавать сбор.");
    return;
  }

  const dateStr = interaction.options.getString("date", true);
  const timeStr = interaction.options.getString("time", true);
  const mainLimit = interaction.options.getInteger("main") || 10;
  const subLimit = interaction.options.getInteger("subs") || 6;
  const dmRole = interaction.options.getRole("role");
  const channel =
    interaction.options.getChannel("channel") ||
    (interaction.channel?.isTextBased?.() && !interaction.channel.isThread?.()
      ? interaction.channel
      : null);

  const startsAt = parseSborDateTime(dateStr, timeStr);
  if (!startsAt) {
    await safeReply(interaction, "Дата/время: формат `26.09.2026` и `14:11`.");
    return;
  }
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
    await safeReply(interaction, "Укажи текстовый канал или вызови команду из канала.");
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const eventNo = nextEventNo(interaction.guildId);
  const organizerId = interaction.user.id;

  const draft = {
    guildId: String(interaction.guildId),
    channelId: String(channel.id),
    messageId: null,
    threadId: null,
    organizerId: String(organizerId),
    dmRoleId: dmRole ? String(dmRole.id) : null,
    eventNo,
    startsAt: startsAt.getTime(),
    mainLimit: Math.min(50, Math.max(1, mainLimit)),
    subLimit: Math.min(50, Math.max(0, subLimit)),
    open: true,
    main: [],
    subs: [],
    reserve: [],
    createdAt: Date.now(),
  };

  try {
    const panel = await channel.send({
      embeds: [buildEmbed({ ...draft, messageId: "0" })],
      components: adminRows({ ...draft, messageId: "0" }),
    });

    draft.messageId = panel.id;

    // fix buttons with real message id
    await panel.edit({ embeds: [buildEmbed(draft)], components: adminRows(draft) });

    const thread = await panel.startThread({
      name: `Сбор: ${eventNo}`.slice(0, 100),
      autoArchiveDuration: 10080,
      reason: `Consume сбор #${eventNo}`,
    });
    draft.threadId = thread.id;
    setSbor(panel.id, draft);

    await thread.send({ content: HOW_TO });
    await thread.send({
      content: dmRole
        ? `${dmRole} Сбор! Запишитесь через \`+\` в этой ветке.`
        : "@everyone Сбор! Запишитесь через `+` в этой ветке.",
      allowedMentions: dmRole ? { roles: [dmRole.id] } : { parse: ["everyone"] },
    });

    await interaction.editReply(`Сбор создан: ${panel.url}`);
  } catch (err) {
    logJson("ERROR", "sbor create", { error: String(err) });
    await interaction.editReply("Не удалось создать сбор. Проверьте права бота (сообщения, ветки).");
  }
}

export async function handleSborInteraction(interaction) {
  const id = interaction.customId || "";
  if (!id.startsWith("c:sbor:")) return false;

  const m = id.match(/^c:sbor:(close|resume|postpone|ping|voice|dm):(\d+)$/);
  if (!interaction.isButton() || !m) {
    await safeReply(interaction, "Неизвестное действие сбора.");
    return true;
  }

  const action = m[1];
  const messageId = m[2];
  const found = findByPanel(messageId);
  if (!found) {
    await safeReply(interaction, "Этот сбор уже не активен.");
    return true;
  }
  const { state } = found;

  if (!(await canManageSbor(interaction, state))) {
    await safeReply(interaction, "Только организатор или модератор.");
    return true;
  }

  if (action === "close") {
    state.open = false;
    setSbor(messageId, state);
    await refreshPanel(interaction.client, messageId);
    await threadSend(interaction.client, state, "🔴 **Сбор закрыт.**");
    await interaction.reply({ content: "Сбор закрыт.", ephemeral: true });
    return true;
  }

  if (action === "resume") {
    state.open = true;
    setSbor(messageId, state);
    await refreshPanel(interaction.client, messageId);
    await threadSend(interaction.client, state, "🟢 **Сбор возобновлён.**");
    await interaction.reply({ content: "Сбор возобновлён.", ephemeral: true });
    return true;
  }

  if (action === "postpone") {
    state.startsAt = Number(state.startsAt) + 15 * 60 * 1000;
    setSbor(messageId, state);
    await refreshPanel(interaction.client, messageId);
    const when = fmtShort(new Date(state.startsAt));
    await threadSend(
      interaction.client,
      state,
      `🟡 **Сбор перенесён на 15 мин.** Новое время: **${when}**`,
    );
    await interaction.reply({ content: `Перенос на 15 мин → ${when}`, ephemeral: true });
    return true;
  }

  if (action === "ping") {
    await threadSend(interaction.client, state, "@everyone Сбор! Зайдите в войс / будьте готовы.", {
      allowedMentions: { parse: ["everyone"] },
    });
    await interaction.reply({ content: "Пинг отправлен в ветку.", ephemeral: true });
    return true;
  }

  if (action === "voice") {
    const member = await resolveMember(interaction);
    const dest = member?.voice?.channel;
    if (!dest || dest.type !== ChannelType.GuildVoice) {
      await safeReply(interaction, "Сначала зайди в голосовой канал.");
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    const ids = [...new Set([...state.main, ...state.subs, ...state.reserve])];
    let moved = 0;
    let failed = 0;
    for (const uid of ids) {
      if (uid === String(interaction.user.id)) continue;
      const mbr = await interaction.guild.members.fetch(uid).catch(() => null);
      if (!mbr?.voice?.channelId) continue;
      try {
        await mbr.voice.setChannel(dest, "Consume сбор: все в войс");
        moved += 1;
      } catch {
        failed += 1;
      }
    }
    await interaction.editReply(
      failed ? `Переместил **${moved}**, ошибок: **${failed}**.` : `Переместил в войс: **${moved}**.`,
    );
    return true;
  }

  if (action === "dm") {
    await interaction.deferReply({ ephemeral: true });
    const ids = [...new Set([...state.main, ...state.subs, ...state.reserve])];
    const when = fmtShort(new Date(state.startsAt));
    let ok = 0;
    let fail = 0;
    for (const uid of ids) {
      const user = await interaction.client.users.fetch(uid).catch(() => null);
      if (!user) {
        fail += 1;
        continue;
      }
      const r = await safeDm(user, {
        content: `Напоминание: **Мероприятие ${state.eventNo}** — сбор **${when}** на сервере **${interaction.guild.name}**.`,
      });
      if (r) ok += 1;
      else fail += 1;
    }
    await interaction.editReply(`ЛС отправлено: **${ok}**, не удалось: **${fail}**.`);
    return true;
  }

  return true;
}

export async function onSborMessage(message) {
  if (!message.guild || message.author.bot) return;
  if (!message.channel?.isThread?.()) return;

  const found = findByThread(message.channel.id);
  if (!found) return;

  const text = String(message.content || "").trim();
  if (text !== "+" && text !== "-") return;

  const { id: messageId, state } = found;
  const uid = String(message.author.id);

  await withLock(`sbor:${messageId}`, async () => {
    const fresh = getSbor(messageId);
    if (!fresh) return;

    if (text === "+") {
      if (!fresh.open) {
        await message.reply({ content: "Сбор закрыт.", allowedMentions: { repliedUser: false } }).catch(() => null);
        return;
      }
      if (fresh.main.includes(uid) || fresh.subs.includes(uid) || fresh.reserve.includes(uid)) {
        return;
      }
      fresh.reserve.push(uid);
      setSbor(messageId, fresh);
      await refreshPanel(message.client, messageId);
      return;
    }

    // "-"
    const was = removeFromAll(fresh, uid);
    if (was) {
      setSbor(messageId, fresh);
      await refreshPanel(message.client, messageId);
    }
  });
}

export async function onSborReaction(reaction, user, added) {
  if (!user || user.bot) return;
  if (reaction.partial) await reaction.fetch().catch(() => null);
  const msg = reaction.message;
  if (!msg?.guild || !msg.channel?.isThread?.()) return;

  const emoji = reaction.emoji?.name;
  if (emoji !== REACT_MAIN && emoji !== REACT_SUB) return;

  const found = findByThread(msg.channel.id);
  if (!found) return;
  const { id: panelId } = found;

  const member = await msg.guild.members.fetch(user.id).catch(() => null);
  const state0 = getSbor(panelId);
  if (!state0) return;
  if (!(await memberCanMod(member, msg.guild, state0))) {
    await reaction.users.remove(user.id).catch(() => null);
    return;
  }

  // цель — автор сообщения с "+"
  if (msg.partial) await msg.fetch().catch(() => null);
  if (msg.author?.bot) return;
  const targetId = String(msg.author?.id || "");
  if (!targetId) return;

  await withLock(`sbor:${panelId}`, async () => {
    const state = getSbor(panelId);
    if (!state) return;

    if (!added) {
      // снятие ✅/🔥 → назад в резерв (если ещё в основе/заменах)
      if (state.main.includes(targetId) || state.subs.includes(targetId)) {
        removeFromAll(state, targetId);
        state.reserve.push(targetId);
        setSbor(panelId, state);
        await refreshPanel(reaction.client, panelId);
      }
      return;
    }

    if (!state.open) {
      await reaction.users.remove(user.id).catch(() => null);
      return;
    }

    removeFromAll(state, targetId);

    if (emoji === REACT_MAIN) {
      if (state.main.length >= state.mainLimit) {
        // нет мест в основе — в замены или резерв
        if (state.subs.length < state.subLimit) state.subs.push(targetId);
        else state.reserve.push(targetId);
      } else {
        state.main.push(targetId);
      }
    } else if (emoji === REACT_SUB) {
      if (state.subs.length >= state.subLimit) state.reserve.push(targetId);
      else state.subs.push(targetId);
    }

    setSbor(panelId, state);
    await refreshPanel(reaction.client, panelId);
  });
}
