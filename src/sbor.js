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
  hasAnyRole,
  isGuildManager,
  logJson,
  resolveMember,
  safeDm,
  safeReply,
  sleep,
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

function mskParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: MSK,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

function mskDate(year, month, day, hour, minute) {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const utc = Date.UTC(year, month - 1, day, hour - 3, minute, 0);
  const dt = new Date(utc);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * Одно поле времени:
 *  15 / +15       → через N минут
 *  15:00 / 15 00  → сегодня в 15:00 МСК
 *  26.09 15:00 / 26.09.2026 15 00 / 26.09.2026 14:11
 */
export function parseWhen(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const s = raw.replace(/\s+/g, " ").trim();

  // через N минут
  if (/^\+?\d{1,4}$/.test(s)) {
    const mins = Number(s.replace("+", ""));
    if (mins < 0 || mins > 7 * 24 * 60) return null;
    return new Date(Date.now() + mins * 60_000);
  }

  // сегодня HH:MM / HH MM
  let m = s.match(/^(\d{1,2})[:\s.](\d{2})$/);
  if (m) {
    const now = mskParts();
    return mskDate(now.year, now.month, now.day, Number(m[1]), Number(m[2]));
  }

  // ДД.ММ[.ГГГГ] HH:MM / HH MM
  m = s.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\s+(\d{1,2})[:\s.](\d{2})$/);
  if (m) {
    let year = m[3] ? Number(m[3]) : mskParts().year;
    if (year < 100) year += 2000;
    return mskDate(year, Number(m[2]), Number(m[1]), Number(m[4]), Number(m[5]));
  }

  // ДД.ММ[.ГГГГ] без времени → сегодняшняя логика: 00:00 того дня? лучше 12:00
  m = s.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?$/);
  if (m) {
    let year = m[3] ? Number(m[3]) : mskParts().year;
    if (year < 100) year += 2000;
    return mskDate(year, Number(m[2]), Number(m[1]), 12, 0);
  }

  return null;
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
  if (!ids?.length) return null;
  return ids.map((id, i) => `${i + 1}. <@${id}>`).join("\n").slice(0, 1024);
}

function ensureLists(state) {
  state.main = state.main || [];
  state.subs = state.subs || [];
  state.reserve = state.reserve || [];
  state.left = state.left || [];
  return state;
}

function removeFromAll(state, userId) {
  ensureLists(state);
  const uid = String(userId);
  let from = null;
  if (state.main.includes(uid)) from = "main";
  else if (state.subs.includes(uid)) from = "subs";
  else if (state.reserve.includes(uid)) from = "reserve";
  state.main = state.main.filter((id) => id !== uid);
  state.subs = state.subs.filter((id) => id !== uid);
  state.reserve = state.reserve.filter((id) => id !== uid);
  return from;
}

function buildEmbed(state) {
  ensureLists(state);
  const at = new Date(state.startsAt);
  const leftSlots = Math.max(0, state.mainLimit - state.main.length);
  const status = state.open ? "🟢 Сбор открыт" : "🔴 Сбор закрыт";
  const color = state.open ? COLOR_GREEN : COLOR_RED;

  const pingLabel = state.pingEveryone
    ? "@everyone"
    : state.dmRoleId
      ? `<@&${state.dmRoleId}>`
      : "—";

  const info =
    `📌 **Время:** ${fmtShort(at)}\n` +
    `👤 **Организатор:** <@${state.organizerId}>\n` +
    `📢 **Пинг / ЛС:** ${pingLabel}`;

  const fields = [{ name: "Информация", value: info, inline: false }];

  if (state.main.length) {
    fields.push({
      name: `Участники (${state.main.length}/${state.mainLimit})`,
      value: listMentions(state.main),
      inline: true,
    });
  }
  if (state.subs.length) {
    fields.push({
      name: `Замены (${state.subs.length}/${state.subLimit})`,
      value: listMentions(state.subs),
      inline: true,
    });
  }
  if (state.reserve.length) {
    fields.push({
      name: `Резерв (${state.reserve.length})`,
      value: listMentions(state.reserve),
      inline: true,
    });
  }
  if (state.left.length) {
    fields.push({
      name: `Сняли + (${state.left.length})`,
      value: listMentions(state.left),
      inline: false,
    });
  }

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`Мероприятие: ${state.eventNo}`)
    .addFields(fields)
    .setFooter({
      text: `Записано: ${state.main.length}/${state.mainLimit} (осталось ${leftSlots}) | Замена: ${state.subs.length} | ${status}`,
    });
}

function dmEmbed(state) {
  const when = fmtShort(new Date(state.startsAt));
  return new EmbedBuilder()
    .setColor(COLOR_GREEN)
    .setTitle("Важное сообщение по мероприятию")
    .addFields({
      name: "Мероприятие",
      value: `1. **${state.eventNo}** (${when})\n2. Создал <@${state.organizerId}>`,
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
        .setLabel("Позвать всех")
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
  "• Модератор ставит ✅ — основа · 🔥 — замены\n" +
  "• Снятие ✅/🔥 — снова в резерв\n" +
  "• Напиши `-` — уберёшь плюс (попадёшь в список снявших)";

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

async function collectDmTargets(guild, state) {
  if (state.pingEveryone) {
    ensureLists(state);
    return [...new Set([...state.main, ...state.subs, ...state.reserve])];
  }
  if (!state.dmRoleId) return [];
  await guild.members.fetch().catch(() => null);
  return guild.members.cache
    .filter((m) => !m.user.bot && m.roles.cache.has(String(state.dmRoleId)))
    .map((m) => m.id);
}

async function sendSborDms(guild, state) {
  const ids = await collectDmTargets(guild, state);
  const emb = dmEmbed(state);
  let ok = 0;
  let fail = 0;
  for (const uid of ids) {
    const user = await guild.client.users.fetch(uid).catch(() => null);
    if (!user) {
      fail += 1;
      continue;
    }
    const r = await safeDm(user, { embeds: [emb] });
    if (r) ok += 1;
    else fail += 1;
    await sleep(350);
  }
  return { ok, fail, total: ids.length };
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

  const whenStr = interaction.options.getString("when", true);
  const mainLimit = interaction.options.getInteger("main") || 10;
  const subLimit = interaction.options.getInteger("subs") || 6;
  const dmRole = interaction.options.getRole("role");
  const pingEveryone = Boolean(interaction.options.getBoolean("everyone"));
  const channel =
    interaction.options.getChannel("channel") ||
    (interaction.channel?.isTextBased?.() && !interaction.channel.isThread?.()
      ? interaction.channel
      : null);

  if (!dmRole && !pingEveryone) {
    await safeReply(interaction, "Укажи **роль** или включи **everyone**.");
    return;
  }

  const startsAt = parseWhen(whenStr);
  if (!startsAt) {
    await safeReply(
      interaction,
      "Время: `15` (через 15 мин), `15:00` / `15 00`, `26.09 15:00`, `26.09.2026 14:11`.",
    );
    return;
  }
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
    await safeReply(interaction, "Вызови команду в текстовом канале или укажи канал.");
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const eventNo = nextEventNo(interaction.guildId);
  const draft = {
    guildId: String(interaction.guildId),
    channelId: String(channel.id),
    messageId: null,
    threadId: null,
    organizerId: String(interaction.user.id),
    dmRoleId: dmRole && !pingEveryone ? String(dmRole.id) : null,
    pingEveryone: pingEveryone || !dmRole,
    eventNo,
    startsAt: startsAt.getTime(),
    mainLimit: Math.min(50, Math.max(1, mainLimit)),
    subLimit: Math.min(50, Math.max(0, subLimit)),
    open: true,
    main: [],
    subs: [],
    reserve: [],
    left: [],
    createdAt: Date.now(),
  };

  try {
    const panel = await channel.send({
      embeds: [buildEmbed({ ...draft, messageId: "0" })],
      components: adminRows({ ...draft, messageId: "0" }),
    });
    draft.messageId = panel.id;
    await panel.edit({ embeds: [buildEmbed(draft)], components: adminRows(draft) });

    const thread = await panel.startThread({
      name: `Сбор: ${eventNo}`.slice(0, 100),
      autoArchiveDuration: 10080,
      reason: `Consume сбор #${eventNo}`,
    });
    draft.threadId = thread.id;
    setSbor(panel.id, draft);

    await thread.send({ content: HOW_TO });

    if (draft.pingEveryone) {
      await thread.send({
        content: "@everyone Сбор! Запишитесь через `+` в этой ветке.",
        allowedMentions: { parse: ["everyone"] },
      });
    } else {
      await thread.send({
        content: `<@&${draft.dmRoleId}> Сбор! Запишитесь через \`+\` в этой ветке.`,
        allowedMentions: { roles: [draft.dmRoleId] },
      });
    }

    let dmHint = "";
    if (draft.dmRoleId) {
      const r = await sendSborDms(interaction.guild, draft);
      dmHint = `\nЛС по роли: **${r.ok}** / ${r.total} (не доставлено: ${r.fail}).`;
    }

    await interaction.editReply(`Сбор создан: ${panel.url}${dmHint}`);
  } catch (err) {
    logJson("ERROR", "sbor create", { error: String(err) });
    await interaction.editReply("Не удалось создать сбор. Проверьте права бота (сообщения, ветки, упоминания).");
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
  ensureLists(state);

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
    if (state.pingEveryone || !state.dmRoleId) {
      await threadSend(interaction.client, state, "@everyone Сбор! Зайдите в войс / будьте готовы.", {
        allowedMentions: { parse: ["everyone"] },
      });
    } else {
      await threadSend(interaction.client, state, `<@&${state.dmRoleId}> Сбор! Зайдите в войс / будьте готовы.`, {
        allowedMentions: { roles: [state.dmRoleId] },
      });
    }
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
    // только основа + замены
    const ids = [...new Set([...state.main, ...state.subs])];
    let moved = 0;
    let failed = 0;
    for (const uid of ids) {
      const mbr = await interaction.guild.members.fetch(uid).catch(() => null);
      if (!mbr?.voice?.channelId) continue;
      if (mbr.voice.channelId === dest.id) continue;
      try {
        await mbr.voice.setChannel(dest, "Consume сбор: все в войс");
        moved += 1;
      } catch {
        failed += 1;
      }
    }
    await interaction.editReply(
      failed ? `Переместил **${moved}** (основа+замены), ошибок: **${failed}**.` : `Переместил в войс: **${moved}** (основа+замены).`,
    );
    return true;
  }

  if (action === "dm") {
    await interaction.deferReply({ ephemeral: true });
    const r = await sendSborDms(interaction.guild, state);
    await interaction.editReply(
      state.pingEveryone
        ? `ЛС записанным: **${r.ok}** / ${r.total} (не доставлено: ${r.fail}).`
        : `ЛС по роли: **${r.ok}** / ${r.total} (не доставлено: ${r.fail}).`,
    );
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

  const { id: messageId } = found;
  const uid = String(message.author.id);

  await withLock(`sbor:${messageId}`, async () => {
    const fresh = getSbor(messageId);
    if (!fresh) return;
    ensureLists(fresh);

    if (text === "+") {
      if (!fresh.open) {
        await message.reply({ content: "Сбор закрыт — запись через `+` недоступна.", allowedMentions: { repliedUser: false } }).catch(() => null);
        return;
      }
      if (fresh.main.includes(uid) || fresh.subs.includes(uid) || fresh.reserve.includes(uid)) return;
      fresh.left = fresh.left.filter((id) => id !== uid);
      fresh.reserve.push(uid);
      setSbor(messageId, fresh);
      await refreshPanel(message.client, messageId);
      return;
    }

    // "-"
    const from = removeFromAll(fresh, uid);
    if (from) {
      if (!fresh.left.includes(uid)) fresh.left.push(uid);
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

  if (msg.partial) await msg.fetch().catch(() => null);
  if (msg.author?.bot) return;
  const targetId = String(msg.author?.id || "");
  if (!targetId) return;

  await withLock(`sbor:${panelId}`, async () => {
    const state = getSbor(panelId);
    if (!state) return;
    ensureLists(state);

    if (!added) {
      // снятие любой галочки/огонька → снова в резерв
      if (state.main.includes(targetId) || state.subs.includes(targetId)) {
        removeFromAll(state, targetId);
        state.reserve.push(targetId);
        state.left = state.left.filter((id) => id !== targetId);
        setSbor(panelId, state);
        await refreshPanel(reaction.client, panelId);
      }
      return;
    }

    // даже если сбор закрыт — галочки/огоньки работают
    removeFromAll(state, targetId);
    state.left = state.left.filter((id) => id !== targetId);

    if (emoji === REACT_MAIN) {
      if (state.main.length >= state.mainLimit) {
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
