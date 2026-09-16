import "dotenv/config";
import {
  ChannelType,
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
import { handleSborCommand, handleSborInteraction, restoreSborCountdowns } from "./sbor.js";
import { handleAutoparkInteraction, autoparkExpireLoop } from "./autopark.js";
import { handleSpamInteraction } from "./spam.js";
import { handleTempVoiceInteraction, onTempVoiceState } from "./tempVoice.js";
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
      .setDescription("Создать сбор участников (ВЗХ / МП / Поставка)")
      .setDMPermission(false)
      .addStringOption((o) =>
        o
          .setName("type")
          .setNameLocalizations({ ru: "тип" })
          .setDescription("Тип сбора")
          .setRequired(true)
          .addChoices(
            { name: "ВЗХ", value: "ВЗХ" },
            { name: "МП", value: "МП" },
            { name: "Поставка", value: "Поставка" },
          ),
      )
      .addRoleOption((o) =>
        o
          .setName("role")
          .setNameLocalizations({ ru: "роль" })
          .setDescription("Роль для пинга")
          .setRequired(true),
      )
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setNameLocalizations({ ru: "канал" })
          .setDescription("Куда отправить сбор (по умолчанию — текущий канал)")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  ].map((c) => c.toJSON());
}

async function syncCommands(readyClient) {
  const body = buildCommands();
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
  try {
    await readyClient.application.commands.set(body);
  } catch (err) {
    logJson("ERROR", "Не удалось синхронизировать глобальные команды", { error: String(err) });
  }
  logJson("INFO", "Команды синхронизированы", {
    guilds: guildOk,
    names: body.map((c) => c.name),
  });
}

client.once(Events.ClientReady, async (readyClient) => {
  await syncCommands(readyClient);
  restoreSborCountdowns(readyClient);
  autoparkExpireLoop(readyClient).catch((err) => logJson("ERROR", "autopark loop", { error: String(err) }));
  logJson("INFO", `Бот запущен: ${readyClient.user.tag} (${readyClient.user.id})`);
});

client.on(Events.MessageCreate, (message) => {
  trackMessageActivity(message);
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
  } catch (err) {
    logJson("ERROR", "reaction activity", { error: String(err) });
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
