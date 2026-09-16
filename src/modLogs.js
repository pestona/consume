import { AuditLogEvent, EmbedBuilder } from "discord.js";
import { trackAntinukeBan } from "./antinuke.js";
import { getConfig } from "./config.js";
import { COLOR_DARK, COLOR_RED, logJson, sleep } from "./util.js";

const recent = new Map();

function dedupe(key, ms = 5000) {
  const now = Date.now();
  const prev = recent.get(key) || 0;
  if (now - prev < ms) return false;
  recent.set(key, now);
  if (recent.size > 500) {
    for (const [k, t] of recent) {
      if (now - t > 60_000) recent.delete(k);
    }
  }
  return true;
}

function avatarUrl(user) {
  try {
    return user.displayAvatarURL({ size: 128, extension: "png" });
  } catch {
    return null;
  }
}

function cleanReason(raw) {
  const r = String(raw || "").trim();
  if (!r) return null;
  const low = r.toLowerCase();
  if (low === "не указана" || low === "none" || low === "null" || low === "-") return null;
  return r.slice(0, 500);
}

/** Классический embed как у KAI HELPER: title + description + inline fields + thumbnail */
function buildModEmbed({ color, title, description, fields, thumb }) {
  const emb = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description);
  for (const f of fields || []) {
    if (!f?.name || f.value == null || f.value === "") continue;
    emb.addFields({ name: f.name, value: String(f.value).slice(0, 1024), inline: f.inline !== false });
  }
  if (thumb) emb.setThumbnail(thumb);
  return emb;
}

async function resolveChannel(guild, channelId) {
  if (!channelId) return null;
  const id = String(channelId);
  return guild.channels.cache.get(id) || (await guild.channels.fetch(id).catch(() => null));
}

async function sendEmbed(guild, channelId, embed, content, mentionRoleId) {
  if (!channelId) {
    logJson("WARN", "mod log: канал не задан", { guildId: guild.id });
    return false;
  }
  const ch = await resolveChannel(guild, channelId);
  if (!ch?.isTextBased?.()) {
    logJson("WARN", "mod log: канал не найден / не текстовый", { guildId: guild.id, channelId });
    return false;
  }
  try {
    await ch.send({
      embeds: [embed],
      content: content || undefined,
      allowedMentions: mentionRoleId ? { roles: [String(mentionRoleId)] } : { parse: [] },
    });
    return true;
  } catch (err) {
    logJson("ERROR", "mod log send failed", { guildId: guild.id, error: String(err) });
    return false;
  }
}

async function findAudit(guild, type, targetId, maxAgeMs = 30_000) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 10 });
    return (
      [...logs.entries.values()].find((e) => {
        const tid = String(e.target?.id || e.targetId || "");
        if (tid !== String(targetId)) return false;
        return Date.now() - e.createdTimestamp <= maxAgeMs;
      }) || null
    );
  } catch (err) {
    logJson("WARN", "mod log: нет доступа к audit log (нужно View Audit Log)", {
      guildId: guild.id,
      error: String(err),
    });
    return null;
  }
}

async function findAuditWithRetry(guild, type, targetId) {
  for (const d of [0, 400, 1000, 2000, 3500]) {
    if (d) await sleep(d);
    const entry = await findAudit(guild, type, targetId);
    if (entry) return entry;
  }
  return null;
}

async function isBanned(guild, userId) {
  try {
    await guild.bans.fetch(userId);
    return true;
  } catch {
    return false;
  }
}

function roleList(member) {
  const roles = [...(member.roles?.cache?.values?.() || [])]
    .filter((r) => r && r.id !== member.guild.id)
    .sort((a, b) => b.position - a.position);
  if (!roles.length) return "—";
  const text = roles.map((r) => `<@&${r.id}>`).join(" ");
  return text.length > 900 ? `${text.slice(0, 900)}…` : text;
}

export async function onMemberRemove(member) {
  try {
    if (member.partial) {
      try {
        member = await member.fetch();
      } catch {
        /* ok */
      }
    }
  } catch {
    /* ignore */
  }

  const guild = member.guild;
  const user = member.user;
  if (!guild || !user || user.bot) return;
  if (!dedupe(`rm:${guild.id}:${user.id}`)) return;

  const cfg = getConfig(guild.id);
  const modChannelId = cfg.modLogChannelId || cfg.botActionLogChannelId || null;
  const leaveCh = cfg.leaveLogChannelId || null;
  const name = member.displayName || user.username || user.id;
  const thumb = avatarUrl(user);

  logJson("INFO", "member remove", { guildId: guild.id, userId: user.id, modChannelId, leaveCh });

  let banEntry = await findAuditWithRetry(guild, AuditLogEvent.MemberBanAdd, user.id);
  const banned = Boolean(banEntry) || (await isBanned(guild, user.id));
  if (banned && !banEntry) {
    banEntry = await findAudit(guild, AuditLogEvent.MemberBanAdd, user.id, 60_000);
  }

  if (banned) {
    if (modChannelId) {
      const reason = cleanReason(banEntry?.reason);
      const mod = banEntry?.executor;
      const fields = [{ name: "Забанил", value: mod ? `<@${mod.id}>` : "неизвестно", inline: true }];
      if (reason) fields.push({ name: "Причина", value: reason, inline: true });

      await sendEmbed(
        guild,
        modChannelId,
        buildModEmbed({
          color: COLOR_RED,
          title: `Пользователь был забанен ${name}`,
          description: `Пользователь был забанен. <@${user.id}>`,
          fields,
          thumb,
        }),
      );
    } else {
      logJson("WARN", "бан без канала лога — задай Логи → Баны/кики", { guildId: guild.id });
    }
    const mod = banEntry?.executor;
    if (mod) {
      trackAntinukeBan(guild, mod).catch((err) =>
        logJson("ERROR", "antinuke", { error: String(err) }),
      );
    }
    return;
  }

  const kickEntry = await findAuditWithRetry(guild, AuditLogEvent.MemberKick, user.id);
  if (kickEntry) {
    if (!modChannelId) {
      logJson("WARN", "кик без канала лога — задай Логи → Баны/кики", { guildId: guild.id });
      return;
    }
    const reason = cleanReason(kickEntry.reason);
    const mod = kickEntry.executor;
    const fields = [{ name: "Выгнал", value: mod ? `<@${mod.id}>` : "неизвестно", inline: true }];
    if (reason) fields.push({ name: "Причина", value: reason, inline: true });

    await sendEmbed(
      guild,
      modChannelId,
      buildModEmbed({
        color: COLOR_RED,
        title: `Пользователь был выгнан ${name}`,
        description: `Пользователь был выгнан. <@${user.id}>`,
        fields,
        thumb,
      }),
    );
    return;
  }

  const channelId = leaveCh || modChannelId;
  if (!channelId) {
    logJson("WARN", "выход без канала лога — задай Логи → Выход", { guildId: guild.id });
    return;
  }
  const ping = leaveCh && cfg.leaveLogPingRoleId ? `<@&${cfg.leaveLogPingRoleId}>` : null;
  await sendEmbed(
    guild,
    channelId,
    buildModEmbed({
      color: COLOR_DARK,
      title: `Пользователь покинул ${name}`,
      description: `Пользователь покинул сервер. <@${user.id}>`,
      fields: [{ name: "Роли пользователя", value: roleList(member), inline: false }],
      thumb,
    }),
    ping,
    leaveCh ? cfg.leaveLogPingRoleId : null,
  );
}
