import { EmbedBuilder } from "discord.js";

export const COLOR_DARK = 0x2b2d31;
export const COLOR_ORANGE = 0xe67e22;
export const COLOR_RED = 0xe74c3c;
export const COLOR_GREEN = 0x2ecc71;
export const COLOR_BLUE = 0x3498db;
export const COLOR_GOLD = 0xf1c40f;
export const MSK = "Europe/Moscow";

const STALE_CODES = new Set([10003, 10015, 10062]);
const locks = new Map();

/** Очередь на ключ: второй клик ждёт первый (анти-гонка). */
export function withLock(key, fn) {
  const k = String(key);
  const prev = locks.get(k) || Promise.resolve();
  const run = prev.then(
    () => fn(),
    () => fn(),
  );
  locks.set(
    k,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export function logJson(level, message, extra = {}) {
  const ts = new Date().toLocaleString("ru-RU", { timeZone: MSK, hour12: false });
  const bits = Object.entries(extra)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ");
  const line = bits ? `[${level}] ${ts} | ${message} | ${bits}` : `[${level}] ${ts} | ${message}`;
  if (level === "ERROR") console.error(line);
  else console.log(line);
}

export function isStale(err) {
  const code = err?.code ?? err?.rawError?.code;
  return STALE_CODES.has(Number(code)) || Number(code) === 40060;
}

export async function safeReply(interaction, options) {
  const payload = typeof options === "string" ? { content: options, ephemeral: true } : { ephemeral: true, ...options };
  try {
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply(payload);
    } else if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
    return true;
  } catch (err) {
    if (isStale(err)) {
      logJson("WARN", "Не удалось ответить на взаимодействие", { error: String(err) });
      return false;
    }
    logJson("ERROR", "Ошибка ответа на взаимодействие", { error: String(err) });
    return false;
  }
}

export function memberFrom(interaction) {
  if (interaction.member && typeof interaction.member.permissions?.has === "function") {
    return interaction.member;
  }
  return interaction.guild?.members.cache.get(interaction.user.id) ?? null;
}

export async function resolveMember(interaction) {
  const cached = memberFrom(interaction);
  if (cached) return cached;
  if (!interaction.guild) return null;
  try {
    return await interaction.guild.members.fetch(interaction.user.id);
  } catch {
    return null;
  }
}

export function isGuildManager(member) {
  if (!member?.guild) return false;
  if (member.id === member.guild.ownerId) return true;
  const perms = member.permissions;
  return Boolean(perms?.has("Administrator") || perms?.has("ManageGuild"));
}

export function hasAnyRole(member, ids) {
  if (!member || !ids?.length) return false;
  const set = new Set(ids.map(String));
  return member.roles.cache.some((r) => set.has(r.id));
}

export function mentionRoles(ids) {
  if (!ids?.length) return "—";
  return ids.map((id) => `<@&${id}>`).join(" ");
}

export function mentionChannels(ids) {
  if (!ids?.length) return "—";
  return ids.map((id) => `<#${id}>`).join(" ");
}

export function mentionUsers(ids) {
  if (!ids?.length) return "—";
  return [...ids].map((id) => `<@${id}>`).join("\n");
}

export function statusLine(on) {
  return on ? "✅ Включено" : "❌ Выключено";
}

export function formatDateRu(date = new Date(), timeZone = MSK) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

export function formatDateTimeRu(date = new Date(), timeZone = MSK) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function embedFieldCodeblock(text) {
  let raw = String(text || "—").trim().replaceAll("```", "'''");
  const maxInner = 1016;
  if (raw.length > maxInner) raw = `${raw.slice(0, maxInner - 1)}…`;
  return `\`\`\`${raw}\`\`\``;
}

export function embedLinesValue(lines, empty = "—", limit = 1024) {
  if (!lines?.length) return empty;
  const out = [];
  let used = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const chunk = (out.length ? "\n" : "") + lines[i];
    if (used + chunk.length > limit) {
      const more = `\n… ещё ${lines.length - i}`;
      if (used + more.length <= limit) out.push(more);
      break;
    }
    out.push(chunk);
    used += chunk.length;
  }
  return out.join("") || empty;
}

export function channelSlug(name, ticketNo, kind) {
  const base =
    String(name || "user")
      .toLowerCase()
      .replaceAll(" ", "-")
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 60) || "user";
  return `${kind}-${base}-${ticketNo}`.slice(0, 100);
}

export function reasonInCodeBlock(reason) {
  let r = String(reason || "").trim().replaceAll("```", "'''");
  if (r.length > 900) r = `${r.slice(0, 897)}…`;
  return `\`\`\`${r}\`\`\``;
}

export async function safeDm(user, options) {
  try {
    await user.send(options);
    return true;
  } catch (err) {
    logJson("WARN", `DM не доставлено ${user?.id}`, { error: String(err) });
    return false;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function textChannelOf(guild, channelId) {
  if (!guild || !channelId) return null;
  const ch = guild.channels.cache.get(String(channelId));
  if (ch && (ch.isTextBased?.() && !ch.isVoiceBased?.() || ch.isThread?.())) {
    if (ch.isDMBased?.()) return null;
    return ch;
  }
  return ch?.isTextBased?.() ? ch : null;
}

export function toIdList(values) {
  return [...new Set((values || []).map(String).filter(Boolean))];
}

export function parsePeopleCap(raw) {
  const s = String(raw || "").trim();
  const note = s.length > 100 ? `${s.slice(0, 100)}...` : s || "—";
  if (!s) return { cap: 6, note: "—" };
  const range = s.match(/(?:от\s)?(\d+)\s*[-–]\s*(\d+)/i);
  if (range) {
    const cap = Math.min(40, Math.max(1, Math.max(Number(range[1]), Number(range[2]))));
    return { cap, note };
  }
  const one = s.match(/\d+/);
  if (one) return { cap: Math.min(40, Math.max(1, Number(one[0]))), note };
  return { cap: 6, note };
}

export function buildErrorEmbed(title, description) {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(COLOR_RED);
}
