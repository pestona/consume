import fs from "node:fs";
import path from "node:path";
import { ChannelType, OverwriteType } from "discord.js";
import { DATA_DIR } from "./db.js";
import { logJson, withLock } from "./util.js";

function backupPath(guildId) {
  return path.join(DATA_DIR, `channels-${guildId}.json`);
}

function serializeOverwrite(ow) {
  return {
    id: String(ow.id),
    type: ow.type === OverwriteType.Member || ow.type === 1 ? 1 : 0,
    allow: ow.allow?.bitfield?.toString?.() ?? String(ow.allow ?? "0"),
    deny: ow.deny?.bitfield?.toString?.() ?? String(ow.deny ?? "0"),
  };
}

function serializeChannel(ch) {
  return {
    id: String(ch.id),
    name: ch.name,
    type: ch.type,
    parentId: ch.parentId ? String(ch.parentId) : null,
    position: ch.rawPosition ?? ch.position ?? 0,
    topic: ch.topic || null,
    nsfw: Boolean(ch.nsfw),
    rateLimitPerUser: ch.rateLimitPerUser || 0,
    bitrate: ch.bitrate || null,
    userLimit: ch.userLimit || 0,
    permissionOverwrites: [...(ch.permissionOverwrites?.cache?.values?.() || [])].map(serializeOverwrite),
  };
}

export function getChannelBackupMeta(guildId) {
  const p = backupPath(guildId);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return {
      savedAt: raw.savedAt || null,
      count: Array.isArray(raw.channels) ? raw.channels.length : 0,
      path: p,
    };
  } catch {
    return null;
  }
}

export async function createChannelBackup(guild) {
  return withLock(`chbak:${guild.id}`, async () => {
    await guild.channels.fetch().catch(() => null);
    const channels = [...guild.channels.cache.values()]
      .filter((ch) =>
        [
          ChannelType.GuildCategory,
          ChannelType.GuildText,
          ChannelType.GuildVoice,
          ChannelType.GuildAnnouncement,
          ChannelType.GuildForum,
          ChannelType.GuildStageVoice,
        ].includes(ch.type),
      )
      .map(serializeChannel)
      .sort((a, b) => {
        if (a.type === ChannelType.GuildCategory && b.type !== ChannelType.GuildCategory) return -1;
        if (b.type === ChannelType.GuildCategory && a.type !== ChannelType.GuildCategory) return 1;
        return a.position - b.position;
      });

    const payload = {
      guildId: String(guild.id),
      savedAt: Date.now(),
      channels,
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${backupPath(guild.id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, backupPath(guild.id));
    logJson("INFO", "channel backup saved", { guildId: guild.id, count: channels.length });
    return { ok: true, count: channels.length, savedAt: payload.savedAt };
  });
}

function loadBackup(guildId) {
  const p = backupPath(guildId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    logJson("ERROR", "channel backup read", { error: String(err) });
    return null;
  }
}

function findExisting(guild, snap, parentMap) {
  const parentId = snap.parentId ? parentMap.get(snap.parentId) || snap.parentId : null;
  return [...guild.channels.cache.values()].find((ch) => {
    if (ch.type !== snap.type) return false;
    if (ch.name !== snap.name) return false;
    const p = ch.parentId || null;
    const want = parentId || null;
    return String(p || "") === String(want || "");
  });
}

function overwritesForCreate(guild, list) {
  const out = [];
  for (const ow of list || []) {
    if (ow.type === 0 && ow.id !== guild.id && !guild.roles.cache.has(ow.id)) continue;
    out.push({
      id: ow.id,
      type: ow.type === 1 ? OverwriteType.Member : OverwriteType.Role,
      allow: BigInt(ow.allow || "0"),
      deny: BigInt(ow.deny || "0"),
    });
  }
  return out;
}

/**
 * Восстанавливает отсутствующие каналы/категории из бэкапа (по имени + типу + родителю).
 * Существующие не трогает.
 */
export async function restoreChannelBackup(guild) {
  return withLock(`chres:${guild.id}`, async () => {
    const data = loadBackup(guild.id);
    if (!data?.channels?.length) {
      return { ok: false, error: "Бэкап не найден. Сначала «Создать бэкап»." };
    }

    await guild.channels.fetch().catch(() => null);
    const parentMap = new Map(); // oldId -> newId
    let created = 0;
    let skipped = 0;
    const errors = [];

    const cats = data.channels.filter((c) => c.type === ChannelType.GuildCategory);
    const rest = data.channels.filter((c) => c.type !== ChannelType.GuildCategory);

    for (const snap of cats) {
      const existing = findExisting(guild, snap, parentMap);
      if (existing) {
        parentMap.set(snap.id, existing.id);
        skipped += 1;
        continue;
      }
      try {
        const ch = await guild.channels.create({
          name: snap.name,
          type: ChannelType.GuildCategory,
          position: snap.position,
          permissionOverwrites: overwritesForCreate(guild, snap.permissionOverwrites),
          reason: "Consume: восстановление каналов из бэкапа",
        });
        parentMap.set(snap.id, ch.id);
        created += 1;
      } catch (err) {
        errors.push(`${snap.name}: ${String(err).slice(0, 120)}`);
      }
    }

    // существующие категории тоже в map по старому id если имя совпало
    for (const snap of cats) {
      if (parentMap.has(snap.id)) continue;
      const existing = [...guild.channels.cache.values()].find(
        (c) => c.type === ChannelType.GuildCategory && c.name === snap.name,
      );
      if (existing) parentMap.set(snap.id, existing.id);
    }

    for (const snap of rest) {
      const existing = findExisting(guild, snap, parentMap);
      if (existing) {
        skipped += 1;
        continue;
      }
      const parentId = snap.parentId ? parentMap.get(snap.parentId) || null : null;
      try {
        const opts = {
          name: snap.name,
          type: snap.type,
          parent: parentId || undefined,
          position: snap.position,
          permissionOverwrites: overwritesForCreate(guild, snap.permissionOverwrites),
          reason: "Consume: восстановление каналов из бэкапа",
        };
        if (
          snap.type === ChannelType.GuildText ||
          snap.type === ChannelType.GuildAnnouncement ||
          snap.type === ChannelType.GuildForum
        ) {
          if (snap.topic) opts.topic = String(snap.topic).slice(0, 1024);
          opts.nsfw = Boolean(snap.nsfw);
          opts.rateLimitPerUser = Number(snap.rateLimitPerUser) || 0;
        }
        if (snap.type === ChannelType.GuildVoice || snap.type === ChannelType.GuildStageVoice) {
          if (snap.bitrate) opts.bitrate = snap.bitrate;
          opts.userLimit = Number(snap.userLimit) || 0;
        }
        await guild.channels.create(opts);
        created += 1;
      } catch (err) {
        errors.push(`${snap.name}: ${String(err).slice(0, 120)}`);
      }
    }

    logJson("INFO", "channel backup restore", {
      guildId: guild.id,
      created,
      skipped,
      errors: errors.length,
    });
    return { ok: true, created, skipped, errors: errors.slice(0, 5), total: data.channels.length, savedAt: data.savedAt };
  });
}
