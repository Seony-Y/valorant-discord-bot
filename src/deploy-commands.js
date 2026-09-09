import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commandsDir = path.join(__dirname, 'commands');
const commandFiles = readdirSync(commandsDir).filter((f) => f.endsWith('.js'));

const commands = [];
for (const file of commandFiles) {
  const mod = await import(pathToFileURL(path.join(commandsDir, file)).href);
  commands.push(mod.data.toJSON());
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

// Global registration so the bot can expose commands in every invited server.
await rest.put(
  Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
  { body: commands }
);

console.log(`${commands.length}개의 명령어가 등록되었습니다.`);
