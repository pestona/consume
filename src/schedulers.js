import http from "node:http";
import { ChannelType, EmbedBuilder } from "discord.js";
import { getConfig, parseDailyTimes } from "./config.js";
import { canTriggerRoleMentionDm, mentionWatchMatchesChannel } from "./perms.js";
import { COLOR_DARK, logJson, safeDm, sleep } from "./util.js";

const lastPingMessage = new Map();

export function startHealthServerIfNeeded() {
  if (!process.env.FLY_APP_NAME && !process.env.PORT) return;
  const port = Number(process.env.PORT || 8080) || 8080;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  server.listen(port, "0.0.0.0", () => {
    logJson("INFO", `health-check на порту ${port}`);
  });
}

function nextFire(timeZone, times) {
  const now = new Date();
  const candidates = [];
  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    for (const [h, m] of times) {
      const local = zonedTimeToUtc(now, timeZone, h, m, dayOffset);
      if (local.getTime() > now.getTime()) candidates.push(local);
    }
  }
  candidates.sort((a, b) => a - b);
  return candidates[0];
}

function zonedTimeToUtc(ref, timeZone, hour, minute, dayOffset) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, mo, d] = fmt.format(new Date(ref.getTime() + dayOffset * 86400000)).split("-").map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, hour, minute, 0);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const probe = new Date(asUtc);
  const p = Object.fromEntries([...dtf.formatToParts(probe)].map((x) => [x.type, x.value]));
  const shown = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
  return new Date(asUtc - (shown - asUtc));
}

async function sendRolePing(client, guild, cfg) {
  const ch = guild.channels.cache.get(String(cfg.dailyRolePingChannelId));
  if (!ch?.isTextBased?.()) return null;
  const role = guild.roles.cache.get(String(cfg.dailyRolePingRoleId));
  if (!role) {
    logJson("WARN", "daily_role_ping: роль не найдена", { roleId: cfg.dailyRolePingRoleId, guildId: guild.id });
    return null;
  }
  const body = cfg.dailyRolePingMessage || "Напоминание.";
  return ch.send({
    content: `${role}\n${body}`,
    allowedMentions: { roles: [role.id] },
  });
}

async function deleteBotMessage(client, guild, channelId, messageId) {
  const ch = guild.channels.cache.get(String(channelId));
  if (!ch?.isTextBased?.()) return;
  try {
    const old = await ch.messages.fetch(messageId);
    if (old.author.id === client.user.id) await old.delete();
  } catch {
    /* ignore */
  }
}

export async function dailyRolePingLoop(client) {
  await sleep(3000);
  const guildMeta = new Map();

  while (true) {
    try {
      for (const guild of client.guilds.cache.values()) {
        const cfg = getConfig(guild.id);
        if (!cfg.dailyRolePingChannelId || !cfg.dailyRolePingRoleId) continue;
        const times = parseDailyTimes(cfg.dailyRolePingTimes);
        const meta = guildMeta.get(guild.id) || { lastId: lastPingMessage.get(guild.id) || null, nextAt: 0 };
        const now = Date.now();

        if (times.length) {
          if (!meta.nextAt || now >= meta.nextAt) {
            if (now >= (meta.nextAt || 0) && meta.nextAt) {
              if (meta.lastId) await deleteBotMessage(client, guild, cfg.dailyRolePingChannelId, meta.lastId);
              const msg = await sendRolePing(client, guild, cfg);
              meta.lastId = msg?.id || null;
              lastPingMessage.set(guild.id, meta.lastId);
            }
            const nxt = nextFire(cfg.dailyRolePingTimezone || "Europe/Moscow", times);
            meta.nextAt = nxt ? nxt.getTime() : now + 60_000;
            guildMeta.set(guild.id, meta);
          }
        } else {
          const intervalMs = Math.max(1, Math.min(168, Number(cfg.dailyRolePingIntervalHours) || 23)) * 3600_000;
          if (!meta.nextAt) {
            const msg = await sendRolePing(client, guild, cfg);
            meta.lastId = msg?.id || null;
            lastPingMessage.set(guild.id, meta.lastId);
            meta.nextAt = now + intervalMs;
            guildMeta.set(guild.id, meta);
          } else if (now >= meta.nextAt) {
            if (meta.lastId) await deleteBotMessage(client, guild, cfg.dailyRolePingChannelId, meta.lastId);
            const msg = await sendRolePing(client, guild, cfg);
            meta.lastId = msg?.id || null;
            lastPingMessage.set(guild.id, meta.lastId);
            meta.nextAt = now + intervalMs;
            guildMeta.set(guild.id, meta);
          }
        }
      }
    } catch (err) {
      logJson("ERROR", "daily_role_ping_loop", { error: String(err) });
    }
    await sleep(15_000);
  }
}

export async function onGuildMessage(message) {
  if (message.author.bot || message.webhookId || !message.guild) return;
  const ch = message.channel;
  if (
    ![
      ChannelType.GuildText,
      ChannelType.GuildVoice,
      ChannelType.GuildStageVoice,
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread,
    ].includes(ch.type)
  ) {
    return;
  }
  const cfg = getConfig(message.guild.id);
  if (!cfg.roleMentionDmTargetRoleIds?.length) return;
  if (!cfg.roleMentionDmCategoryIds?.length && !cfg.roleMentionDmChannelIds?.length) return;
  if (!mentionWatchMatchesChannel(ch, cfg)) return;
  if (!message.mentions.roles.size) return;
  const targetRoles = [...message.mentions.roles.values()].filter((r) =>
    cfg.roleMentionDmTargetRoleIds.map(String).includes(r.id),
  );
  if (!targetRoles.length) return;
  const member = message.member;
  if (!member) return;
  if (!canTriggerRoleMentionDm(member, cfg)) return;
  dmRoleMentionBroadcast(message, targetRoles).catch((err) =>
    logJson("ERROR", "role mention dm", { error: String(err) }),
  );
}

async function dmRoleMentionBroadcast(message, targetRoles) {
  let content = (message.content || "").trim();
  for (const role of targetRoles) content = content.replaceAll(role.toString(), " ");
  content = content.replace(/\s+/g, " ").trim();
  const body = `> ## ${(content ? content.slice(0, 1700) : "(без текста)")}`;
  const authorLabel = message.member?.displayName || String(message.author);
  const dmContent = `**${authorLabel}** · сообщение в <#${message.channel.id}>:\n\n${body}\n\n${message.url}`.slice(
    0,
    2000,
  );

  if (!message.guild.members.cache.size) {
    await message.guild.members.fetch().catch(() => null);
  }
  const recipients = new Map();
  for (const role of targetRoles) {
    for (const m of role.members.values()) {
      if (m.user.bot || m.id === message.author.id) continue;
      recipients.set(m.id, m);
    }
  }
  for (const member of recipients.values()) {
    await safeDm(member.user, dmContent);
    await sleep(350);
  }
}

export async function logBotAction(interaction) {
  if (!interaction.guildId) return;
  const cfg = getConfig(interaction.guildId);
  if (!cfg.botActionLogChannelId) return;
  const action = actionName(interaction);
  if (!action) return;
  if (interaction.user?.bot) return;

  const guild = interaction.guild;
  const logCh = guild?.channels.cache.get(String(cfg.botActionLogChannelId));
  if (!logCh?.isTextBased?.()) return;

  const who = `${interaction.user} (\`${interaction.user.tag}\` · \`${interaction.user.id}\`)`;
  const where = interaction.channelId ? `<#${interaction.channelId}>` : "—";
  const detail = actionDetail(interaction);

  const emb = new EmbedBuilder()
    .setColor(COLOR_DARK)
    .setTitle(action)
    .addFields(
      { name: "Кто", value: who, inline: false },
      { name: "Где", value: where, inline: true },
      { name: "Сервер", value: guild?.name || interaction.guildId, inline: true },
    )
    .setTimestamp(new Date())
    .setFooter({ text: "Лог действий бота" });
  if (detail) emb.addFields({ name: "Детали", value: detail.slice(0, 1000), inline: false });

  try {
    await logCh.send({ embeds: [emb] });
  } catch (err) {
    logJson("WARN", "Не удалось отправить лог действия", { error: String(err) });
  }
}

function actionDetail(interaction) {
  if (interaction.isChatInputCommand?.()) {
    const opts = interaction.options?.data || [];
    if (!opts.length) return null;
    return opts
      .map((o) => {
        const v = o.user || o.role || o.channel || o.value;
        const shown = v?.toString?.() ?? String(v ?? "—");
        return `• **${o.name}:** ${shown}`;
      })
      .join("\n");
  }
  if (interaction.isStringSelectMenu?.()) {
    const vals = interaction.values || [];
    return vals.length ? `Выбрано: ${vals.map((v) => `\`${v}\``).join(", ")}` : null;
  }
  if (interaction.isRoleSelectMenu?.()) {
    return `Роли: ${interaction.values.map((id) => `<@&${id}>`).join(" ")}`;
  }
  if (interaction.isChannelSelectMenu?.()) {
    return `Каналы: ${interaction.values.map((id) => `<#${id}>`).join(" ")}`;
  }
  if (interaction.isUserSelectMenu?.()) {
    return `Юзеры: ${interaction.values.map((id) => `<@${id}>`).join(" ")}`;
  }
  return null;
}

function actionName(interaction) {
  const labels = {
    "c:mod:rp": "Модерация: приём РП",
    "c:mod:vzp": "Модерация: приём VZP",
    "c:app:select": "Заявки: выбор типа",
    "c:map:select": "Карты VZP: выбор карты",
    "c:k:propose": "Контракты: форма предложения",
    "c:k:form": "Контракты: отправил предложение",
    "c:k:join": "Контракты: записался",
    "c:k:pinged": "Контракты: Пикнул",
    "c:k:reject": "Контракты: отказ",
    "c:sbor:main": "Сбор: в основу",
    "c:sbor:res": "Сбор: на замену",
    "c:sbor:leave": "Сбор: вышел",
    "c:sbor:mod": "Сбор: модерация списка",
    "c:sbor:modc": "Сбор: модерация списка",
    "c:sbor:form": "Сбор: создал сбор",
    "c:ap:take": "Автопарк: бронь",
    "c:ap:rel": "Автопарк: освободить",
    "c:ap:edit": "Автопарк: редактор",
    "c:app:rp": "Заявки: отправил РП",
    "c:app:vzp": "Заявки: отправил VZP",
    "c:spam:role": "Спам: выбрал роль",
    "c:spam:form": "Спам: отправил текст",
  };
  if (interaction.isChatInputCommand?.()) {
    const name = interaction.commandName === "sbor" ? "сбор" : interaction.commandName;
    return `Команда /${name}`;
  }
  const cid = String(interaction.customId || "");
  if (labels[cid]) return labels[cid];
  if (cid.startsWith("c:adm:tab:")) return `Админка: раздел ${cid.slice("c:adm:tab:".length)}`;
  if (cid.startsWith("c:adm:send:")) return `Админка: отправил панель (${cid.slice("c:adm:send:".length)})`;
  if (cid.startsWith("c:adm:cfg:")) return `Админка: настройка (${cid.slice("c:adm:cfg:".length)})`;
  if (cid.startsWith("c:adm:back:")) return `Админка: назад`;
  if (cid.startsWith("c:cfg:r:")) return `Админка: выбрал роли`;
  if (cid.startsWith("c:cfg:c:")) return `Админка: выбрал каналы`;
  if (cid.startsWith("c:cfg:m:")) return `Админка: сохранил форму`;
  if (cid.startsWith("c:sbor:ok:")) return "Сбор: отметил основу";
  if (cid.startsWith("c:sbor:kick:")) return "Сбор: выписал";
  if (cid.startsWith("c:sbor:toggle:")) return "Сбор: открыл/закрыл запись";
  if (cid.startsWith("c:ticket:") || cid.startsWith("c:t:")) return `Тикет: ${cid}`;
  if (interaction.isButton?.()) return `Кнопка`;
  if (interaction.isAnySelectMenu?.()) return `Выбор в меню`;
  if (interaction.isModalSubmit?.()) return `Форма`;
  return null;
}
