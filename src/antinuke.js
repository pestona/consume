import { AuditLogEvent, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { getConfig } from "./config.js";
import { COLOR_RED, hasAnyRole, logJson, sleep } from "./util.js";

/** guildId -> executorId -> timestamps[] */
const banHits = new Map();
const channelHits = new Map();

function hitsFor(store, guildId, executorId) {
  const g = String(guildId);
  const u = String(executorId);
  if (!store.has(g)) store.set(g, new Map());
  const map = store.get(g);
  if (!map.has(u)) map.set(u, []);
  return map.get(u);
}

function isWhitelisted(member, cfg, userId) {
  if (!member && !userId) return false;
  const uid = String(userId || member?.id || "");
  const users = (cfg.antinukeWhitelistUserIds || []).map(String);
  if (users.includes(uid)) return true;
  if (member && hasAnyRole(member, cfg.antinukeWhitelistRoleIds || [])) return true;
  return false;
}

async function alert(guild, cfg, embed) {
  const channelId = cfg.modLogChannelId || cfg.botActionLogChannelId;
  if (!channelId) return;
  const ch =
    guild.channels.cache.get(String(channelId)) ||
    (await guild.channels.fetch(String(channelId)).catch(() => null));
  if (!ch?.isTextBased?.()) return;
  await ch.send({ embeds: [embed] }).catch((err) =>
    logJson("WARN", "antinuke alert failed", { error: String(err) }),
  );
}

async function stripAllRoles(member, reason) {
  const me = member.guild.members.me;
  if (!me?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) {
    logJson("WARN", "antinuke: нет Manage Roles", { guildId: member.guild.id });
    return { ok: false, removed: 0, reason: "нет права Manage Roles" };
  }

  const removable = [...member.roles.cache.values()].filter((r) => {
    if (r.id === member.guild.id) return false;
    if (r.managed) return false;
    if (me.roles.highest.comparePositionTo(r) <= 0) return false;
    return true;
  });

  if (!removable.length) {
    return { ok: false, removed: 0, reason: "нечего снимать (роли выше бота / managed)" };
  }

  try {
    await member.roles.remove(
      removable.map((r) => r.id),
      reason || "Consume antinuke",
    );
    return { ok: true, removed: removable.length };
  } catch (err) {
    logJson("ERROR", "antinuke strip roles", { error: String(err) });
    return { ok: false, removed: 0, reason: String(err) };
  }
}

async function resolveExecutorMember(guild, executor) {
  if (!executor || executor.bot) return null;
  if (String(executor.id) === String(guild.ownerId)) return null;
  let member = guild.members.cache.get(executor.id);
  if (!member) member = await guild.members.fetch(executor.id).catch(() => null);
  return member;
}

async function punish(guild, member, executor, cfg, titleLine) {
  const result = await stripAllRoles(member, titleLine);
  const emb = new EmbedBuilder()
    .setColor(COLOR_RED)
    .setTitle("Антислив сработал")
    .setDescription(
      `${titleLine}\n` +
        (result.ok
          ? `Снято ролей с <@${executor.id}>: **${result.removed}**.`
          : `Не удалось снять роли: ${result.reason}`),
    )
    .setTimestamp(new Date());
  await alert(guild, cfg, emb);
  logJson("WARN", "antinuke triggered", {
    guildId: guild.id,
    executorId: executor.id,
    stripped: result.removed,
    ok: result.ok,
    titleLine,
  });
}

/**
 * Учёт бана. 10 банов / 60 сек → снять роли (если не whitelist).
 */
export async function trackAntinukeBan(guild, executor) {
  if (!guild || !executor || executor.bot) return;
  const cfg = getConfig(guild.id);
  if (cfg.antinukeEnabled === false) return;

  const limit = Math.max(1, Number(cfg.antinukeBanLimit) || 10);
  const windowMs = Math.max(5, Number(cfg.antinukeBanWindowSec) || 60) * 1000;

  const member = await resolveExecutorMember(guild, executor);
  if (!member) return;
  if (isWhitelisted(member, cfg, executor.id)) return;

  const now = Date.now();
  const arr = hitsFor(banHits, guild.id, executor.id);
  arr.push(now);
  while (arr.length && now - arr[0] > windowMs) arr.shift();

  logJson("INFO", "antinuke ban tick", {
    guildId: guild.id,
    executorId: executor.id,
    count: arr.length,
    limit,
  });

  if (arr.length < limit) return;
  arr.length = 0;
  await punish(
    guild,
    member,
    executor,
    cfg,
    `<@${executor.id}> забанил **${limit}+** человек за **${Math.round(windowMs / 1000)} сек**.`,
  );
}

async function findChannelDeleteExecutor(guild, channelId) {
  const delays = [0, 350, 900, 1800];
  for (const d of delays) {
    if (d) await sleep(d);
    try {
      const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 8 });
      const entry = [...logs.entries.values()].find((e) => {
        const tid = String(e.target?.id || e.targetId || "");
        if (tid !== String(channelId)) return false;
        return Date.now() - e.createdTimestamp < 20_000;
      });
      if (entry?.executor) return entry.executor;
    } catch (err) {
      logJson("WARN", "antinuke channel audit", { error: String(err), guildId: guild.id });
      return null;
    }
  }
  return null;
}

/**
 * Учёт удаления канала. 8 удалений / 60 сек → снять роли.
 */
export async function onAntinukeChannelDelete(channel) {
  try {
    const guild = channel.guild;
    if (!guild) return;
    const cfg = getConfig(guild.id);
    if (cfg.antinukeEnabled === false) return;

    const limit = Math.max(1, Number(cfg.antinukeChannelDeleteLimit) || 8);
    const windowMs = Math.max(5, Number(cfg.antinukeChannelDeleteWindowSec) || 60) * 1000;

    const executor = await findChannelDeleteExecutor(guild, channel.id);
    if (!executor || executor.bot) return;

    const member = await resolveExecutorMember(guild, executor);
    if (!member) return;
    if (isWhitelisted(member, cfg, executor.id)) return;

    const now = Date.now();
    const arr = hitsFor(channelHits, guild.id, executor.id);
    arr.push(now);
    while (arr.length && now - arr[0] > windowMs) arr.shift();

    logJson("INFO", "antinuke channel tick", {
      guildId: guild.id,
      executorId: executor.id,
      channel: channel.name,
      count: arr.length,
      limit,
    });

    if (arr.length < limit) return;
    arr.length = 0;
    await punish(
      guild,
      member,
      executor,
      cfg,
      `<@${executor.id}> удалил **${limit}+** каналов за **${Math.round(windowMs / 1000)} сек**.`,
    );
  } catch (err) {
    logJson("ERROR", "antinuke channel delete", { error: String(err) });
  }
}
