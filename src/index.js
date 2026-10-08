import "dotenv/config";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
} from "discord.js";
import { handlePanelCommand, handleAdminInteraction } from "./adminPanel.js";
import {
  handleActivityAdmin,
  trackMessageActivity,
  trackReactionActivity,
  trackVoiceActivity,
} from "./activity.js";
import { handleTicketInteraction } from "./tickets.js";
import { handleMapsInteraction } from "./maps.js";
import { handleKontraktInteraction } from "./kontrakt.js";
import { handleAutoparkInteraction, autoparkExpireLoop } from "./autopark.js";
import { handleSpamInteraction } from "./spam.js";
import { handleTempVoiceInteraction, onTempVoiceState } from "./tempVoice.js";
import { handleArchiveInteraction } from "./archive.js";
import {
  handleAfkInteraction,
  afkExpireLoop,
  onAfkMemberRemove,
} from "./afk.js";
import {
  handleSborCommand,
  handleSborInteraction,
  onSborMessage,
  onSborMessageDelete,
  onSborMessageUpdate,
  onSborReaction,
} from "./sbor.js";
import { onMemberRemove } from "./modLogs.js";
import { onAntinukeChannelDelete } from "./antinuke.js";
import { logBotAction, startHealthServerIfNeeded } from "./schedulers.js";
import { isStale, logJson, safeReply } from "./util.js";

const token = (process.env.DISCORD_TOKEN || "").trim().replace(/^['"]|['"]$/g, "");
if (!token) {
  console.error("Задайте DISCORD_TOKEN в .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
});

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName("panel")
      .setDescription("Панель управления Consume: публикация и привязки ролей/каналов")
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName("sbor")
      .setNameLocalizations({ ru: "сбор" })
      .setDescription("Создать сбор / мероприятие с записью через + в ветке")
      .setDMPermission(false)
      .addStringOption((o) =>
        o
          .setName("when")
          .setNameLocalizations({ ru: "время" })
          .setDescription("15 | 15:00 | 15 00 | 26.09 15:00 | 26.09.2026 14:11")
          .setRequired(true),
      )
      .addRoleOption((o) =>
        o
          .setName("role")
          .setNameLocalizations({ ru: "роль" })
          .setDescription("Роль для пинга и ЛС (можно выбрать @everyone)")
          .setRequired(true),
      )
      .addIntegerOption((o) =>
        o
          .setName("main")
          .setNameLocalizations({ ru: "основа" })
          .setDescription("Слотов в основе")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(50),
      ),
  ].map((c) => c.toJSON());
}

async function syncCommands(readyClient) {
  const body = buildCommands();
  // Глобальные сбрасываем — иначе /panel и /сбор двоятся (guild + global).
  try {
    await readyClient.application.commands.set([]);
  } catch (err) {
    logJson("ERROR", "Не удалось сбросить глобальные команды", { error: String(err) });
  }
  let guildOk = 0;
  for (const guild of readyClient.guilds.cache.values()) {
    try {
      await guild.commands.set(body);
      guildOk += 1;
    } catch (err) {
      logJson("ERROR", "Не удалось синхронизировать команды на сервере", {
        guildId: guild.id,
        error: String(err),
      });
    }
  }
  logJson("INFO", "Команды синхронизированы (только сервер)", {
    guilds: guildOk,
    names: body.map((c) => c.name),
  });
}

client.once(Events.ClientReady, async (readyClient) => {
  await syncCommands(readyClient);
  autoparkExpireLoop(readyClient).catch((err) => logJson("ERROR", "autopark loop", { error: String(err) }));
  afkExpireLoop(readyClient).catch((err) => logJson("ERROR", "afk loop", { error: String(err) }));
  logJson("INFO", `Бот запущен: ${readyClient.user.tag} (${readyClient.user.id})`);
});

client.on(Events.MessageCreate, (message) => {
  trackMessageActivity(message);
  onSborMessage(message).catch((err) => logJson("ERROR", "sbor message", { error: String(err) }));
});

client.on(Events.MessageDelete, (message) => {
  onSborMessageDelete(message).catch((err) => logJson("ERROR", "sbor delete", { error: String(err) }));
});

client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
  onSborMessageUpdate(oldMessage, newMessage).catch((err) =>
    logJson("ERROR", "sbor edit", { error: String(err) }),
  );
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  try {
    trackVoiceActivity(oldState, newState);
  } catch (err) {
    logJson("ERROR", "voice activity", { error: String(err) });
  }
  onTempVoiceState(oldState, newState).catch((err) =>
    logJson("ERROR", "temp voice", { error: String(err) }),
  );
});

client.on(Events.GuildMemberRemove, (member) => {
  onMemberRemove(member).catch((err) => logJson("ERROR", "leave log", { error: String(err) }));
  onAfkMemberRemove(member).catch((err) => logJson("ERROR", "afk leave", { error: String(err) }));
});

client.on(Events.ChannelDelete, (channel) => {
  onAntinukeChannelDelete(channel).catch((err) =>
    logJson("ERROR", "antinuke channel", { error: String(err) }),
  );
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (reaction.partial) await reaction.fetch().catch(() => null);
    if (user.partial) await user.fetch().catch(() => null);
    trackReactionActivity(reaction, user);
    await onSborReaction(reaction, user, true);
  } catch (err) {
    logJson("ERROR", "reaction activity", { error: String(err) });
  }
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  try {
    if (reaction.partial) await reaction.fetch().catch(() => null);
    if (user.partial) await user.fetch().catch(() => null);
    await onSborReaction(reaction, user, false);
  } catch (err) {
    logJson("ERROR", "reaction remove", { error: String(err) });
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  logBotAction(interaction).catch(() => null);
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "panel") {
      await handlePanelCommand(interaction);
      return;
    }
    if (interaction.isChatInputCommand() && (interaction.commandName === "sbor" || interaction.commandName === "сбор")) {
      await handleSborCommand(interaction);
      return;
    }

    const handlers = [
      handleTempVoiceInteraction,
      handleArchiveInteraction,
      handleAfkInteraction,
      handleActivityAdmin,
      handleAdminInteraction,
      handleTicketInteraction,
      handleMapsInteraction,
      handleKontraktInteraction,
      handleSborInteraction,
      handleAutoparkInteraction,
      handleSpamInteraction,
    ];
    for (const fn of handlers) {
      const handled = await fn(interaction);
      if (handled) return;
    }
  } catch (err) {
    if (isStale(err)) {
      logJson("WARN", "Устаревшее взаимодействие", { error: String(err) });
      return;
    }
    logJson("ERROR", "Ошибка interaction", { error: String(err), stack: err?.stack });
    await safeReply(interaction, "Взаимодействие не удалось обработать. Попробуйте снова через пару секунд.");
  }
});

startHealthServerIfNeeded();
client.login(token).catch((err) => {
  logJson("ERROR", "Не удалось войти в Discord", { error: String(err) });
  process.exit(1);
});
