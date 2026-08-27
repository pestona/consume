import {
  ActionRowBuilder,
  ModalBuilder,
  RoleSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { broadcastDms } from "./dmBroadcast.js";
import { canSpam } from "./perms.js";
import { logJson, safeReply } from "./util.js";

const drafts = new Map();

function formatSpamDm(text) {
  const raw = String(text || "")
    .trim()
    .replaceAll("\r\n", "\n")
    .slice(0, 1600);
  if (!raw) return "> #";
  const lines = raw.split("\n").map((line, i) => {
    if (i === 0) return line ? `> # ${line}` : "> #";
    return line ? `> ${line}` : ">";
  });
  return lines.join("\n").slice(0, 1990);
}

async function broadcast(guild, role, content) {
  try {
    await guild.members.fetch();
  } catch {
    logJson("WARN", "guild.members.fetch не удался, спам по кэшу");
  }
  const targets = [...role.members.values()].filter((m) => !m.user.bot && m.id !== guild.members.me?.id);
  return broadcastDms(targets, content);
}

export function spamRoleRows() {
  return [
    new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId("c:spam:role")
        .setPlaceholder("Роль получателей спама")
        .setMinValues(1)
        .setMaxValues(1),
    ),
  ];
}

function spamModal() {
  return new ModalBuilder()
    .setCustomId("c:spam:form")
    .setTitle("Текст спама в ЛС")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("text")
          .setLabel("Текст сообщения")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1600)
          .setRequired(true),
      ),
    );
}

export async function handleSpamInteraction(interaction) {
  const id = interaction.customId || "";
  if (!id.startsWith("c:spam:")) return false;

  if (!(await canSpam(interaction))) {
    await safeReply(
      interaction,
      "Нет прав на спам. Нужны Администратор / Управлять сервером или роль из **/panel → Спам**.",
    );
    return true;
  }

  if (interaction.isRoleSelectMenu() && id === "c:spam:role") {
    const role = interaction.guild.roles.cache.get(interaction.values[0]);
    if (!role || role.id === interaction.guild.id) {
      await safeReply(interaction, "Нельзя выбрать роль @everyone.");
      return true;
    }
    const member = interaction.member;
    if (member && member.id !== interaction.guild.ownerId && !member.permissions?.has("Administrator")) {
      if (role.comparePositionTo(member.roles.highest) >= 0) {
        await safeReply(interaction, "Нельзя спамить по роли выше или равной вашей высшей роли.");
        return true;
      }
    }
    drafts.set(`${interaction.guildId}:${interaction.user.id}`, role.id);
    await interaction.showModal(spamModal());
    return true;
  }

  if (interaction.isModalSubmit() && id === "c:spam:form") {
    const roleId = drafts.get(`${interaction.guildId}:${interaction.user.id}`);
    drafts.delete(`${interaction.guildId}:${interaction.user.id}`);
    const role = roleId ? interaction.guild.roles.cache.get(roleId) : null;
    if (!role) {
      await safeReply(interaction, "Сначала выберите роль в панели.");
      return true;
    }
    const text = interaction.fields.getTextInputValue("text");
    if (!text.trim()) {
      await safeReply(interaction, "Текст не может быть пустым.");
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply(`Спам по роли ${role} запущен (медленно, чтобы не упереться в лимит Discord)…`);
    const { ok, fail } = await broadcast(interaction.guild, role, formatSpamDm(text));
    await interaction.editReply(
      `Спам по роли ${role}: **${ok}** доставлено, **${fail}** не удалось (ЛС закрыты и т.п.).`,
    );
    return true;
  }

  return true;
}
