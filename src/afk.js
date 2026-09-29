import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { getConfig } from "./config.js";
import { kvGet, kvSet } from "./db.js";
import { parseWhen } from "./sbor.js";
import { COLOR_DARK, logJson, resolveMember, safeReply, withLock, MSK } from "./util.js";

const V2 = MessageFlags.IsComponentsV2;
const V2_EPH = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;
const MAX_UNTIL_MS = 90 * 24 * 60 * 60_000;

function store() {
  const data = kvGet("afkStatus") || {};
  data.byGuild = data.byGuild && typeof data.byGuild === "object" ? data.byGuild : {};
  return data;
}

function saveStore(data) {
  kvSet("afkStatus", { byGuild: data.byGuild });
}

function guildBag(guildId) {
  const data = store();
  const gid = String(guildId);
  if (!data.byGuild[gid] || typeof data.byGuild[gid] !== "object") {
    data.byGuild[gid] = { entries: {}, panels: [] };
  }
  const g = data.byGuild[gid];
  g.entries = g.entries && typeof g.entries === "object" ? g.entries : {};
  g.panels = Array.isArray(g.panels) ? g.panels : [];
  return { data, g };
}

function getEntry(guildId, userId) {
  return guildBag(guildId).g.entries[String(userId)] || null;
}

function setEntry(guildId, userId, entry) {
  const { data, g } = guildBag(guildId);
  g.entries[String(userId)] = entry;
  saveStore(data);
}

function deleteEntry(guildId, userId) {
  const { data, g } = guildBag(guildId);
  delete g.entries[String(userId)];
  saveStore(data);
}

export function registerAfkPanel(guildId, channelId, messageId) {
  const { data, g } = guildBag(guildId);
  const mid = String(messageId);
  g.panels = g.panels.filter((p) => String(p.messageId) !== mid);
  g.panels.push({ channelId: String(channelId), messageId: mid });
  if (g.panels.length > 20) g.panels = g.panels.slice(-20);
  saveStore(data);
}

function removeAfkPanel(guildId, messageId) {
  const { data, g } = guildBag(guildId);
  g.panels = g.panels.filter((p) => String(p.messageId) !== String(messageId));
  saveStore(data);
}

function fmtUntilShort(ts) {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: MSK,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ts));
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return `${get("day")}.${get("month")} ${get("hour")}:${get("minute")}`;
}

function nickFromUntil(ts) {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: MSK,
    day: "2-digit",
    month: "2-digit",
  }).formatToParts(new Date(ts));
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return `до ${get("day")}.${get("month")}`.slice(0, 32);
}

function parseAfkWhen(input) {
  const raw = String(input || "").trim().replace(/\s+/g, " ");
  if (!raw) return null;

  let m = raw.match(/^(\d{1,3})\s*(д|днь|дня|дней|d|day|days)$/i);
  if (m) {
    const n = Number(m[1]);
    if (n < 1 || n > 90) return null;
    return new Date(Date.now() + n * 24 * 60 * 60_000);
  }
  m = raw.match(/^(\d{1,3})\s*(ч|час|часа|часов|h|hr|hrs|hour|hours)$/i);
  if (m) {
    const n = Number(m[1]);
    if (n < 1 || n > 90 * 24) return null;
    return new Date(Date.now() + n * 60 * 60_000);
  }

  const dt = parseWhen(raw);
  if (!dt) return null;
  return dt;
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

function listBlock(entries, empty) {
  if (!entries.length) return empty;
  return entries
    .map((e, i) => {
      const reason = String(e.reason || "без причины").slice(0, 80);
      const until = fmtUntilShort(e.untilTs);
      const rel = `<t:${Math.floor(e.untilTs / 1000)}:R>`;
      return `${i + 1}. <@${e.userId}> — ${reason} - до ${until} · ${rel}`;
    })
    .join("\n");
}

export function afkPanelPayload(guildId) {
  const { g } = guildBag(guildId);
  const now = Date.now();
  const rows = Object.entries(g.entries)
    .map(([userId, e]) => ({ ...e, userId }))
    .filter((e) => e && Number(e.untilTs) > now)
    .sort((a, b) => a.untilTs - b.untilTs);

  const afk = rows.filter((e) => e.mode === "afk");
  const inactive = rows.filter((e) => e.mode === "inactive");

  const body =
    `## AFK / Инактив\n` +
    `Уйдите в AFK или инактив с указанием причины и времени. По истечении срока вы автоматически пропадёте из списка.\n\n` +
    `**AFK**\n${listBlock(afk, "Никого нет.")}\n\n` +
    `**Инактив**\n${listBlock(inactive, "Никого нет.")}`;

  const container = new ContainerBuilder()
    .setAccentColor(COLOR_DARK)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body.slice(0, 3900)))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("c:afk:go").setLabel("Уйти в AFK").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("c:afk:inactive").setLabel("Уйти в инактив").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("c:afk:leave").setLabel("Выйти").setStyle(ButtonStyle.Secondary),
      ),
    );

  return { components: [container], flags: V2 };
}

export async function refreshAfkPanels(client, guildId) {
  const guild = client.guilds.cache.get(String(guildId));
  if (!guild) return;
  const { data, g } = guildBag(guildId);
  const payload = afkPanelPayload(guildId);
  let changed = false;
  for (const panel of [...g.panels]) {
    const ch = guild.channels.cache.get(panel.channelId);
    if (!ch?.isTextBased?.()) {
      g.panels = g.panels.filter((p) => p.messageId !== panel.messageId);
      changed = true;
      continue;
    }
    try {
      const msg = await ch.messages.fetch(panel.messageId);
      await msg.edit(payload);
    } catch (err) {
      if (err?.code === 10008 || err?.code === 50001) {
        g.panels = g.panels.filter((p) => p.messageId !== panel.messageId);
        changed = true;
      }
    }
  }
  if (changed) saveStore(data);
}

function removableRoles(member) {
  return member.roles.cache.filter(
    (r) => r.id !== member.guild.id && !r.managed && r.editable,
  );
}

async function applyInactive(member, inactiveRoleId, untilTs) {
  const savedRoleIds = removableRoles(member)
    .map((r) => r.id)
    .filter((id) => id !== String(inactiveRoleId));
  const savedNick = member.nickname ?? null;

  const keep = member.roles.cache
    .filter((r) => r.id === member.guild.id || r.managed || !r.editable)
    .map((r) => r.id);
  const nextIds = [...new Set([...keep, String(inactiveRoleId)])];

  await member.roles.set(nextIds, "Consume: уход в инактив");
  try {
    if (member.manageable) await member.setNickname(nickFromUntil(untilTs), "Consume: уход в инактив");
  } catch (err) {
    logJson("WARN", "afk nick set", { error: String(err), userId: member.id });
  }

  return { savedRoleIds, savedNick };
}

async function restoreInactive(member, entry) {
  const cfg = getConfig(member.guild.id);
  const inactiveRoleId = cfg.afkInactiveRoleId ? String(cfg.afkInactiveRoleId) : null;
  const saved = Array.isArray(entry.savedRoleIds) ? entry.savedRoleIds.map(String) : [];

  const keep = member.roles.cache
    .filter((r) => {
      if (r.id === member.guild.id) return true;
      if (r.managed) return true;
      if (!r.editable) return true;
      if (inactiveRoleId && r.id === inactiveRoleId) return false;
      return false;
    })
    .map((r) => r.id);

  const restore = saved.filter((id) => {
    const role = member.guild.roles.cache.get(id);
    return role && !role.managed && role.editable && id !== inactiveRoleId;
  });

  await member.roles.set([...new Set([...keep, ...restore])], "Consume: выход из инактива");

  try {
    if (member.manageable) {
      const nick = entry.savedNick == null ? null : String(entry.savedNick).slice(0, 32);
      await member.setNickname(nick, "Consume: выход из инактива");
    }
  } catch (err) {
    logJson("WARN", "afk nick restore", { error: String(err), userId: member.id });
  }
}

function goModal(mode) {
  const title = mode === "inactive" ? "Уйти в инактив" : "Уйти в AFK";
  return new ModalBuilder()
    .setCustomId(mode === "inactive" ? "c:afk:m:inactive" : "c:afk:m:afk")
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Причина")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(80)
          .setRequired(true)
          .setPlaceholder("поездка / дела / отдых"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("until")
          .setLabel("До когда")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(40)
          .setRequired(true)
          .setPlaceholder("3д | 12ч | 01.10 23:00 | +120"),
      ),
    );
}

async function startStatus(interaction, mode) {
  const member = await resolveMember(interaction);
  if (!member) {
    await safeReply(interaction, "Участник не найден.");
    return;
  }

  const reason = String(interaction.fields.getTextInputValue("reason") || "").trim().slice(0, 80);
  const untilRaw = String(interaction.fields.getTextInputValue("until") || "").trim();
  const until = parseAfkWhen(untilRaw);
  if (!until || Number.isNaN(until.getTime())) {
    await interaction.reply(
      eph("Не понял срок. Примеры: `3д`, `12ч`, `01.10 23:00`, `+120` (минуты)."),
    );
    return;
  }
  const untilTs = until.getTime();
  if (untilTs <= Date.now() + 60_000) {
    await interaction.reply(eph("Срок должен быть хотя бы на минуту вперёд."));
    return;
  }
  if (untilTs - Date.now() > MAX_UNTIL_MS) {
    await interaction.reply(eph("Максимум **90 дней**."));
    return;
  }

  const cfg = getConfig(interaction.guildId);
  if (mode === "inactive") {
    if (!cfg.afkInactiveRoleId) {
      await interaction.reply(eph("Роль инактива не настроена. Откройте **/panel → AFK**."));
      return;
    }
    const role = interaction.guild.roles.cache.get(String(cfg.afkInactiveRoleId));
    if (!role) {
      await interaction.reply(eph("Роль инактива не найдена на сервере. Проверьте **/panel → AFK**."));
      return;
    }
    if (!role.editable) {
      await interaction.reply(eph("Бот не может выдать роль инактива (она выше бота или управляемая)."));
      return;
    }
  }

  await interaction.deferReply({ ephemeral: true });

  await withLock(`afk:${interaction.guildId}:${member.id}`, async () => {
    const prev = getEntry(interaction.guildId, member.id);
    if (prev?.mode === "inactive") {
      await restoreInactive(member, prev);
    }

    let savedRoleIds = [];
    let savedNick = null;
    if (mode === "inactive") {
      const applied = await applyInactive(member, cfg.afkInactiveRoleId, untilTs);
      savedRoleIds = applied.savedRoleIds;
      savedNick = applied.savedNick;
    }

    setEntry(interaction.guildId, member.id, {
      mode,
      reason: reason || "без причины",
      untilTs,
      savedRoleIds,
      savedNick,
      startedAt: Date.now(),
    });
  });

  await refreshAfkPanels(interaction.client, interaction.guildId);
  const label = mode === "inactive" ? "инактив" : "AFK";
  await interaction.editReply(
    eph(`Готово: **${label}** до **${fmtUntilShort(untilTs)}** МСК (<t:${Math.floor(untilTs / 1000)}:R>).`),
  );
}

async function leaveStatus(interaction) {
  const member = await resolveMember(interaction);
  if (!member) {
    await safeReply(interaction, "Участник не найден.");
    return;
  }

  const entry = getEntry(interaction.guildId, member.id);
  if (!entry) {
    await interaction.reply(eph("Тебя нет в списке AFK / инактив."));
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  await withLock(`afk:${interaction.guildId}:${member.id}`, async () => {
    const cur = getEntry(interaction.guildId, member.id);
    if (!cur) return;
    if (cur.mode === "inactive") await restoreInactive(member, cur);
    deleteEntry(interaction.guildId, member.id);
  });

  await refreshAfkPanels(interaction.client, interaction.guildId);
  await interaction.editReply(eph("Вышел из списка. Роли и ник восстановлены (если был инактив)."));
}

export async function handleAfkInteraction(interaction) {
  const id = interaction.customId || "";
  if (!id.startsWith("c:afk:")) return false;
  if (!interaction.guild) {
    await safeReply(interaction, "Только на сервере.");
    return true;
  }

  if (interaction.isButton() && id === "c:afk:go") {
    await interaction.showModal(goModal("afk"));
    return true;
  }
  if (interaction.isButton() && id === "c:afk:inactive") {
    await interaction.showModal(goModal("inactive"));
    return true;
  }
  if (interaction.isButton() && id === "c:afk:leave") {
    await leaveStatus(interaction);
    return true;
  }
  if (interaction.isModalSubmit() && id === "c:afk:m:afk") {
    await startStatus(interaction, "afk");
    return true;
  }
  if (interaction.isModalSubmit() && id === "c:afk:m:inactive") {
    await startStatus(interaction, "inactive");
    return true;
  }

  await safeReply(interaction, "Неизвестное действие AFK.");
  return true;
}

export async function expireAfkEntries(client) {
  const data = store();
  const now = Date.now();
  const touched = new Set();

  for (const [guildId, g] of Object.entries(data.byGuild || {})) {
    if (!g?.entries) continue;
    const guild = client.guilds.cache.get(String(guildId));
    for (const [userId, entry] of Object.entries(g.entries)) {
      if (!entry || Number(entry.untilTs) > now) continue;
      touched.add(String(guildId));
      try {
        if (guild && entry.mode === "inactive") {
          const member = await guild.members.fetch(userId).catch(() => null);
          if (member) await restoreInactive(member, entry);
        }
      } catch (err) {
        logJson("WARN", "afk expire restore", { guildId, userId, error: String(err) });
      }
      delete g.entries[userId];
    }
  }

  if (touched.size) {
    saveStore(data);
    for (const guildId of touched) {
      await refreshAfkPanels(client, guildId).catch((err) =>
        logJson("WARN", "afk panel refresh", { guildId, error: String(err) }),
      );
    }
  }
}

export async function afkExpireLoop(client) {
  while (true) {
    try {
      await expireAfkEntries(client);
    } catch (err) {
      logJson("ERROR", "afk expire loop", { error: String(err) });
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

export async function onAfkMemberRemove(member) {
  if (!member?.guild?.id || !member.id) return;
  const entry = getEntry(member.guild.id, member.id);
  if (!entry) return;
  deleteEntry(member.guild.id, member.id);
  await refreshAfkPanels(member.client, member.guild.id).catch(() => null);
}
