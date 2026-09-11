import 'dotenv/config';
import { Client, Collection, GatewayIntentBits, MessageFlags } from 'discord.js';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { getValorantActs } from './services/henrik.js';
import { startStoreNotificationScheduler } from './services/storeNotifications.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});
client.commands = new Collection();

const commandsDir = path.join(__dirname, 'commands');
const commandFiles = readdirSync(commandsDir).filter((f) => f.endsWith('.js'));

for (const file of commandFiles) {
  const mod = await import(pathToFileURL(path.join(commandsDir, file)).href);
  client.commands.set(mod.data.name, mod);
}

client.once('clientReady', () => {
  console.log(`로그인 완료: ${client.user.tag}`);
  startStoreNotificationScheduler(client);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (command?.autocomplete) {
      try {
        await command.autocomplete(interaction);
      } catch (error) {
        if (error?.code !== 10062) console.error(error);
      }
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('store-view:')) {
    const command = client.commands.get('상점');
    try {
      await command.handleComponent(interaction);
    } catch (error) {
      console.error(error);
      if (!interaction.replied) {
        await interaction.reply({ content: '상점 화면을 전환하지 못했습니다. `/상점`을 다시 실행해주세요.', flags: MessageFlags.Ephemeral });
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    if (err?.code === 10062) {
      console.warn('만료된 Discord 상호작용을 무시했습니다. 명령어를 다시 실행해주세요.');
      return;
    }

    console.error(err);
    const payload = { content: '명령어 처리 중 오류가 발생했습니다.', flags: MessageFlags.Ephemeral };
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch (responseError) {
      if (responseError?.code !== 10062 && responseError?.code !== 40060) {
        console.error(responseError);
      }
    }
  }
});

try {
  await getValorantActs();
} catch (error) {
  console.error('시즌 목록 캐시 실패:', error.message);
}

client.login(process.env.DISCORD_TOKEN);
