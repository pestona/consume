import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { getAllSbors, getSbor, setSbor } from "./db.js";
import { broadcastDms } from "./dmBroadcast.js";
import { canModerate } from "./perms.js";
import {
  COLOR_DARK,
  COLOR_GREEN,
  MSK,
  formatDateRu,
  formatDateTimeRu,
  logJson,
  mentionUsers,
  safeReply,
  withLock,
} from "./util.js";

const drafts = new Map();
const tasks = new Map();

function draftKey(interaction) {
  return `${interaction.guildId}:${interaction.user.id}`;
}

function sborEmbed(state) {
  const startAt = new Date(state.startAt);
  const unix = Math.floor(startAt.getTime() / 1000);
  return new EmbedBuilder()
    .setTitle(`Сбор · ${state.kind}`)
    .setColor(COLOR_DARK)
    .setTimestamp(new Date())
    .addFields(
      {
        name: "Время",
        value: `${formatDateTimeRu(startAt, MSK)} МСК\nСтарт <t:${unix}:R>`,
        inline: false,
      },
      {
        name: `Участники (${(state.mainIds || []).length}/${state.maxMain})`,
        value: mentionUsers(state.mainIds),
        inline: false,
      },
      {
        name: `Замены (${(state.reserveIds || []).length}/${state.maxReserve})`,
        value: mentionUsers(state.reserveIds),
        inline: false,
      },
    )
    .setFooter({ text: formatDateRu(new Date(), MSK) });
}

function publicRows(open) {
  if (!open) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("c:sbor:modc")
          .setLabel("Модерация списка")
          .setStyle(ButtonStyle.Primary),
      ),
    ];
  }
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("c:sbor:main").setLabel("В основу").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("c:sbor:res").setLabel("На замену").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("c:sbor:leave").setLabel("Выйти").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("c:sbor:mod").setLabel("Модерация списка").setStyle(ButtonStyle.Primary),
    ),
  ];
}

function isOpen(state) {
  return Boolean(state.open) && new Date(state.startAt).getTime() >= Date.now();
}

async function refreshSbor(client, messageId) {
  const state = getSbor(messageId);
  if (!state) return false;
  const guild = client.guilds.cache.get(state.guildId);
  const ch = guild?.channels.cache.get(state.channelId);
  if (!ch?.isTextBased?.()) return false;
  const msg = await ch.messages.fetch(messageId).catch(() => null);
  if (!msg) return false;
  const open = isOpen(state);
  if (state.open && !open) {
    state.open = false;
    setSbor(messageId, state);
  }
  try {
    await msg.edit({ embeds: [sborEmbed(state)], components: publicRows(state.open && open) });
    return true;
  } catch {
    return false;
  }
}

async function announceStart(client, state) {
  const guild = client.guilds.cache.get(state.guildId);
  const ch = guild?.channels.cache.get(state.channelId);
  if (!ch?.isTextBased?.()) return;
  const role = guild.roles.cache.get(state.roleId);
  if (!role) return;
  const mains = (state.mainIds || []).length
    ? [...state.mainIds].sort().map((id) => `<@${id}>`).join(" ")
    : "—";
  try {
    await ch.send({
      content: role.toString(),
      allowedMentions: { roles: [role.id] },
      embeds: [
        new EmbedBuilder()
          .setTitle(`Сбор · ${state.kind} — старт`)
          .setDescription(`**Основа:**\n${mains}`)
          .setColor(COLOR_GREEN)
          .setTimestamp(new Date()),
      ],
    });
  } catch {
    /* ignore */
  }
}

async function notifyRoleDm(guild, role, channel, kind, startAt, jumpUrl) {
  const startStr = formatDateTimeRu(startAt, MSK);
  const dmText =
    `Тебя собирают на **${kind}** в **${guild.name}**.\n` +
    `Канал: ${channel}\n` +
    `Старт: **${startStr} МСК**\n` +
    `Записаться: ${jumpUrl}`;
  await guild.members.fetch().catch(() => null);
  const targets = [...role.members.values()].filter((m) => !m.user.bot);
  await broadcastDms(targets, dmText);
}

function startCountdown(client, messageId) {
  if (tasks.has(messageId)) return;
  const runner = async () => {
    try {
      while (true) {
        const state = getSbor(messageId);
        if (!state) break;
        if (!state.open || Date.now() > new Date(state.startAt).getTime()) {
          state.open = false;
          setSbor(messageId, state);
          await refreshSbor(client, messageId);
          await announceStart(client, state);
          break;
        }
        await refreshSbor(client, messageId);
        await new Promise((r) => setTimeout(r, 60_000));
      }
    } catch (err) {
      logJson("ERROR", "sbor countdown", { messageId, error: String(err) });
    } finally {
      tasks.delete(messageId);
    }
  };
  tasks.set(
    messageId,
    runner().catch((err) => logJson("ERROR", "sbor countdown unhandled", { messageId, error: String(err) })),
  );
}

export function restoreSborCountdowns(client) {
  for (const [id, state] of Object.entries(getAllSbors())) {
    if (state.open) startCountdown(client, id);
  }
}

function join(state, userId, target) {
  const main = new Set(state.mainIds || []);
  const reserve = new Set(state.reserveIds || []);
  if (target === "main") {
    reserve.delete(userId);
    main.add(userId);
  } else {
    main.delete(userId);
    reserve.add(userId);
  }
  state.mainIds = [...main];
  state.reserveIds = [...reserve];
}

function removeUser(state, userId) {
  const main = new Set(state.mainIds || []);
  const reserve = new Set(state.reserveIds || []);
  const removed = main.has(userId) || reserve.has(userId);
  main.delete(userId);
  reserve.delete(userId);
  state.mainIds = [...main];
  state.reserveIds = [...reserve];
  return removed;
}

function parseStart(raw) {
  const startIn = String(raw || "").trim();
  if (/^\d{1,4}$/.test(startIn)) {
    const minutes = Number(startIn);
    if (minutes <= 0) return { error: "Количество минут должно быть больше 0." };
    return { startAt: new Date(Date.now() + minutes * 60_000) };
  }
  const m = startIn.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    return { error: "Неверный формат времени. Укажите минуты (`15`) или ЧЧ:ММ (`19:30`)." };
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return { error: "Неверное время. Часы 0–23, минуты 0–59." };
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: MSK,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, mo, d] = fmt.format(new Date()).split("-").map(Number);
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  let startAt = new Date(`${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${hh}:${mm}:00+03:00`);
  if (startAt.getTime() <= Date.now()) {
    startAt = new Date(startAt.getTime() + 24 * 3600_000);
  }
  return { startAt };
}

export function patchSborDraft(interaction, patch) {
  const key = draftKey(interaction);
  const next = { ...(drafts.get(key) || {}), ...patch };
  drafts.set(key, next);
  return next;
}

export function getSborDraft(interaction) {
  return drafts.get(draftKey(interaction)) || {};
}

export function sborKindRows() {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("c:sbor:kind")
        .setPlaceholder("Тип сбора")
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel("ВЗХ").setValue("ВЗХ"),
          new StringSelectMenuOptionBuilder().setLabel("МП").setValue("МП"),
          new StringSelectMenuOptionBuilder().setLabel("Поставка").setValue("Поставка"),
        ),
    ),
  ];
}

export function sborRoleRows() {
  return [
    new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId("c:sbor:role")
        .setPlaceholder("Роль для пинга")
        .setMinValues(1)
        .setMaxValues(1),
    ),
  ];
}

export function openSborModal() {
  return sborModal();
}

function sborModal() {
  return new ModalBuilder()
    .setCustomId("c:sbor:form")
    .setTitle("Параметры сбора")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("main")
          .setLabel("Мест в основе")
          .setPlaceholder("10")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(3)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("res")
          .setLabel("Мест на замене")
          .setPlaceholder("5")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(3)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("when")
          .setLabel("Старт: минуты или ЧЧ:ММ")
          .setPlaceholder("15 или 19:30")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(8)
          .setRequired(true),
      ),
    );
}

function memberName(guild, uid) {
  return guild.members.cache.get(String(uid))?.displayName || String(uid);
}

function moderationRows(state, guild) {
  const registered = [...new Set([...(state.mainIds || []), ...(state.reserveIds || [])])];
  const rows = [];
  const approveOpts = registered.slice(0, 25).map((uid) =>
    new StringSelectMenuOptionBuilder().setLabel(memberName(guild, uid).slice(0, 100)).setValue(String(uid)),
  );
  rows.push(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`c:sbor:ok:${state.messageId}`)
        .setPlaceholder("Отметьте, кто идёт в основу")
        .setMinValues(0)
        .setMaxValues(Math.max(1, Math.min(25, approveOpts.length || 1)))
        .setDisabled(!registered.length)
        .addOptions(
          approveOpts.length
            ? approveOpts
            : [new StringSelectMenuOptionBuilder().setLabel("Никто не записан").setValue("0")],
        ),
    ),
  );
  const removeOpts = [
    ...(state.mainIds || []).map((uid) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`Основа: ${memberName(guild, uid)}`.slice(0, 100))
        .setValue(String(uid)),
    ),
    ...(state.reserveIds || []).map((uid) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`Замена: ${memberName(guild, uid)}`.slice(0, 100))
        .setValue(String(uid)),
    ),
  ].slice(0, 25);
  rows.push(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`c:sbor:kick:${state.messageId}`)
        .setPlaceholder("Выписать участника")
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(!removeOpts.length)
        .addOptions(
          removeOpts.length
            ? removeOpts
            : [new StringSelectMenuOptionBuilder().setLabel("Список пуст").setValue("0")],
        ),
    ),
  );
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`c:sbor:toggle:${state.messageId}`)
        .setLabel("Закрыть/открыть запись")
        .setStyle(ButtonStyle.Danger),
    ),
  );
  return rows;
}

export async function handleSborCommand(interaction) {
  if (!interaction.guild) {
    await safeReply(interaction, "Команда только на сервере.");
    return;
  }
  if (!(await canModerate(interaction))) {
    await safeReply(interaction, "Нужны права модератора бота или «Управлять сервером».");
    return;
  }
  const kind = interaction.options.getString("type", true);
  const role = interaction.options.getRole("role", true);
  const channel = interaction.options.getChannel("channel");
  if (role.id === interaction.guild.id) {
    await safeReply(interaction, "Нельзя выбрать @everyone.");
    return;
  }
  const channelId = channel?.id || interaction.channelId;
  const ch = interaction.guild.channels.cache.get(channelId);
  if (
    !ch ||
    (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement) ||
    ch.isThread?.()
  ) {
    await safeReply(interaction, "Нужен текстовый канал (укажи в команде или вызови из канала).");
    return;
  }
  drafts.set(draftKey(interaction), { kind, roleId: role.id, channelId: ch.id });
  await interaction.showModal(sborModal());
}

export async function handleSborInteraction(interaction) {
  const id = interaction.customId || "";
  if (!id.startsWith("c:sbor:")) return false;

  if (interaction.isStringSelectMenu() && id === "c:sbor:kind") {
    drafts.set(draftKey(interaction), { kind: interaction.values[0] });
    await interaction.update({
      content: `Тип: **${interaction.values[0]}**. Выберите роль для пинга.`,
      components: sborRoleRows(),
    });
    return true;
  }

  if (interaction.isRoleSelectMenu() && id === "c:sbor:role") {
    const draft = patchSborDraft(interaction, { roleId: interaction.values[0] });
    if (!draft.kind) {
      await safeReply(interaction, "Сначала выбери тип через **/сбор**.");
      return true;
    }
    await interaction.showModal(openSborModal());
    return true;
  }

  if (interaction.isModalSubmit() && id === "c:sbor:form") {
    const draft = getSborDraft(interaction);
    if (!draft?.kind || !draft.roleId) {
      await safeReply(interaction, "Сначала вызови **/сбор** с типом и ролью.");
      return true;
    }
    const maxMain = Number(interaction.fields.getTextInputValue("main"));
    const maxReserve = Number(interaction.fields.getTextInputValue("res"));
    if (!Number.isInteger(maxMain) || maxMain < 1 || maxMain > 100) {
      await safeReply(interaction, "Мест в основе: целое число 1–100.");
      return true;
    }
    if (!Number.isInteger(maxReserve) || maxReserve < 0 || maxReserve > 100) {
      await safeReply(interaction, "Мест на замене: целое число 0–100.");
      return true;
    }
    const parsed = parseStart(interaction.fields.getTextInputValue("when"));
    if (parsed.error) {
      await safeReply(interaction, parsed.error);
      return true;
    }
    const channelId = draft.channelId || interaction.channelId;
    const ch = interaction.guild.channels.cache.get(String(channelId));
    if (!ch?.isTextBased?.() || ch.isThread?.()) {
      await safeReply(interaction, "Укажи текстовый канал в **/сбор** или вызови команду из канала.");
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    const role = interaction.guild.roles.cache.get(draft.roleId);
    const msg = await ch.send({
      content: role ? role.toString() : undefined,
      embeds: [new EmbedBuilder().setTitle("Сбор участников").setColor(COLOR_DARK)],
      components: publicRows(true),
      allowedMentions: role ? { roles: [role.id] } : { parse: [] },
    });
    const state = {
      guildId: interaction.guild.id,
      roleId: draft.roleId,
      messageId: msg.id,
      channelId: ch.id,
      kind: draft.kind,
      maxMain,
      maxReserve,
      startAt: parsed.startAt.toISOString(),
      open: true,
      mainIds: [],
      reserveIds: [],
    };
    setSbor(msg.id, state);
    await refreshSbor(interaction.client, msg.id);
    startCountdown(interaction.client, msg.id);
    if (draft.kind === "ВЗХ" && role) {
      notifyRoleDm(interaction.guild, role, ch, draft.kind, parsed.startAt, msg.url).catch(() => null);
    }
    drafts.delete(draftKey(interaction));
    await interaction.editReply(`Сбор опубликован в ${ch}.`);
    return true;
  }

  if (interaction.isButton() && (id === "c:sbor:main" || id === "c:sbor:res")) {
    const msg = interaction.message;
    await interaction.deferReply({ ephemeral: true });
    const target = id === "c:sbor:main" ? "main" : "reserve";
    const result = await withLock(`sbor:${msg.id}`, async () => {
      const state = getSbor(msg.id);
      if (!state) return { ok: false, text: "Этот сбор уже не активен." };
      if (!isOpen(state)) {
        state.open = false;
        setSbor(msg.id, state);
        return { ok: false, text: "Запись на этот сбор уже закрыта.", refresh: true };
      }
      if (target === "main" && (state.mainIds || []).includes(interaction.user.id)) {
        return { ok: false, text: "Вы уже в основе." };
      }
      if (target === "reserve" && (state.reserveIds || []).includes(interaction.user.id)) {
        return { ok: false, text: "Вы уже на замене." };
      }
      const inMain = (state.mainIds || []).includes(interaction.user.id);
      const inRes = (state.reserveIds || []).includes(interaction.user.id);
      if (target === "main" && !inMain && (state.mainIds || []).length >= state.maxMain) {
        return { ok: false, text: "Все места в основе уже заняты." };
      }
      if (target === "reserve" && !inRes && (state.reserveIds || []).length >= state.maxReserve) {
        return { ok: false, text: "Все места на замене уже заняты." };
      }
      join(state, interaction.user.id, target);
      setSbor(msg.id, state);
      return { ok: true, text: `Вы записаны в **${target === "main" ? "основу" : "замену"}**.`, refresh: true };
    });
    if (result.refresh) await refreshSbor(interaction.client, msg.id);
    await interaction.editReply(result.text);
    return true;
  }

  if (interaction.isButton() && id === "c:sbor:leave") {
    const msg = interaction.message;
    await interaction.deferReply({ ephemeral: true });
    const result = await withLock(`sbor:${msg.id}`, async () => {
      const state = getSbor(msg.id);
      if (!state) return { ok: false, text: "Этот сбор уже не активен." };
      const changed = removeUser(state, interaction.user.id);
      setSbor(msg.id, state);
      return {
        ok: true,
        text: changed ? "Вы выписаны из сбора." : "Вы не были записаны в этот сбор.",
        refresh: true,
      };
    });
    if (result.refresh) await refreshSbor(interaction.client, msg.id);
    await interaction.editReply(result.text);
    return true;
  }

  if (interaction.isButton() && (id === "c:sbor:mod" || id === "c:sbor:modc")) {
    if (!(await canModerate(interaction))) {
      await safeReply(interaction, "Только модераторы могут открыть модерацию.");
      return true;
    }
    const state = getSbor(interaction.message.id);
    if (!state) {
      await safeReply(interaction, "Этот сбор уже не активен.");
      return true;
    }
    await interaction.reply({
      content: "Панель модерации сбора:",
      components: moderationRows(state, interaction.guild),
      ephemeral: true,
    });
    return true;
  }

  const ok = id.match(/^c:sbor:ok:(\d+)$/);
  if (interaction.isStringSelectMenu() && ok) {
    if (!(await canModerate(interaction))) {
      await safeReply(interaction, "Нет прав.");
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    const state = getSbor(ok[1]);
    if (!state) {
      await interaction.editReply("Сбор не найден.");
      return true;
    }
    const selected = new Set(interaction.values.filter((v) => v !== "0"));
    const registered = [...new Set([...(state.mainIds || []), ...(state.reserveIds || [])])];
    const newMain = [];
    for (const uid of registered) {
      if (selected.has(uid) && newMain.length < state.maxMain) newMain.push(uid);
    }
    const newReserve = [];
    for (const uid of registered) {
      if (!selected.has(uid) && newReserve.length < state.maxReserve) newReserve.push(uid);
    }
    state.mainIds = newMain;
    state.reserveIds = newReserve;
    setSbor(ok[1], state);
    await refreshSbor(interaction.client, ok[1]);
    await interaction.editReply("Список основы и замен обновлён.");
    return true;
  }

  const kick = id.match(/^c:sbor:kick:(\d+)$/);
  if (interaction.isStringSelectMenu() && kick) {
    if (!(await canModerate(interaction))) {
      await safeReply(interaction, "Нет прав.");
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    const uid = interaction.values[0];
    if (uid === "0") {
      await interaction.editReply("Выписывать некого.");
      return true;
    }
    const state = getSbor(kick[1]);
    if (!state) {
      await interaction.editReply("Сбор не найден.");
      return true;
    }
    const removed = removeUser(state, uid);
    setSbor(kick[1], state);
    await refreshSbor(interaction.client, kick[1]);
    await interaction.editReply(removed ? `<@${uid}> выписан(а) из списков.` : "Участник не найден в списках.");
    return true;
  }

  const toggle = id.match(/^c:sbor:toggle:(\d+)$/);
  if (interaction.isButton() && toggle) {
    if (!(await canModerate(interaction))) {
      await safeReply(interaction, "Нет прав.");
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    const result = await withLock(`sbor:${toggle[1]}`, async () => {
      const state = getSbor(toggle[1]);
      if (!state) return { ok: false, text: "Сбор не найден." };
      const wasOpen = state.open;
      state.open = !state.open;
      setSbor(toggle[1], state);
      return {
        ok: true,
        text: state.open ? "Запись открыта." : "Запись закрыта.",
        wasOpen,
        open: state.open,
        state,
      };
    });
    if (!result.ok) {
      await interaction.editReply(result.text);
      return true;
    }
    await refreshSbor(interaction.client, toggle[1]);
    if (result.wasOpen && !result.open) await announceStart(interaction.client, result.state);
    if (!result.wasOpen && result.open) startCountdown(interaction.client, toggle[1]);
    await interaction.editReply(result.text);
    return true;
  }

  return true;
}
