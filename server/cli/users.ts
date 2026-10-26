// Manage MomExpress accounts. There is deliberately no public sign-up: whoever
// runs the server creates the family's accounts here.
//
//   npm run users -- add                      (asks for everything)
//   npm run users -- add --username mom --name "Mom" --role mom
//   npm run users -- list
//   npm run users -- passwd <username>
//   npm run users -- rename <username> <display name>
//   npm run users -- disable <username>       (signs them out everywhere)
//   npm run users -- enable <username>
//
// Passwords are prompted for without echoing. For scripts, set
// MOMEXPRESS_PASSWORD instead.

import readline from 'node:readline';
import { LIMITS } from '../../shared/constants.js';
import type { Role } from '../../shared/types.js';
import { loadEnvFile, readConfig } from '../config.js';
import { openDatabase } from '../db.js';
import { UserStore } from '../users.js';

loadEnvFile();
const config = readConfig();
const db = openDatabase(config.databaseFile);
const users = new UserStore(db);

const [command, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    }),
  );
}

function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(question);
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') process.exit(130); // Ctrl+C
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function newPassword(): Promise<string> {
  const fromEnv = process.env.MOMEXPRESS_PASSWORD;
  if (fromEnv) {
    if (fromEnv.length < LIMITS.passwordMin) fail(`MOMEXPRESS_PASSWORD must be at least ${LIMITS.passwordMin} characters.`);
    return fromEnv;
  }
  for (;;) {
    const first = await askHidden(`Password (at least ${LIMITS.passwordMin} characters): `);
    if (first.length < LIMITS.passwordMin) {
      console.log('That’s too short.');
      continue;
    }
    const second = await askHidden('Repeat password: ');
    if (first !== second) {
      console.log('Those didn’t match. Let’s try again.');
      continue;
    }
    return first;
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function findUser(username: string | undefined) {
  if (!username) fail('Which username?');
  return users.byUsername(username) ?? fail(`No account called "${username}".`);
}

async function main() {
  switch (command) {
    case 'add': {
      const username = flag('username') ?? (await ask('Username (used to sign in): '));
      if (!/^[A-Za-z0-9._-]{2,32}$/.test(username)) fail('Usernames are 2–32 letters, numbers, dots, dashes or underscores.');
      if (users.byUsername(username)) fail(`There's already an account called "${username}".`);
      const roleInput = (flag('role') ?? (await ask('Role — "mom" (asks for things) or "runner" (delivers them): '))).toLowerCase();
      if (roleInput !== 'mom' && roleInput !== 'runner') fail('Role must be "mom" or "runner".');
      const role = roleInput as Role;
      const displayName = flag('name') ?? ((await ask(`Display name [${role === 'mom' ? 'Mom' : username}]: `)) || (role === 'mom' ? 'Mom' : username));
      if (displayName.length > LIMITS.displayName) fail(`Display names are at most ${LIMITS.displayName} characters.`);
      const password = await newPassword();
      const user = await users.create({ username, displayName, role, password });
      console.log(`Created ${role} account "${user.username}" (${user.display_name}).`);
      break;
    }
    case 'list': {
      const all = users.all();
      if (all.length === 0) console.log('No accounts yet. Add one with: npm run users -- add');
      for (const u of all) {
        console.log(`${u.username.padEnd(20)} ${u.role.padEnd(7)} ${u.display_name}${u.disabled_at ? '  (disabled)' : ''}`);
      }
      break;
    }
    case 'passwd': {
      const user = findUser(rest[0]);
      await users.setPassword(user.id, await newPassword());
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      console.log(`Password changed for "${user.username}". They'll need to sign in again on their devices.`);
      break;
    }
    case 'rename': {
      const user = findUser(rest[0]);
      const name = rest.slice(1).join(' ').trim();
      if (!name || name.length > LIMITS.displayName) fail(`Give a display name of 1–${LIMITS.displayName} characters.`);
      users.update(user.id, { displayName: name });
      console.log(`"${user.username}" is now shown as ${name}.`);
      break;
    }
    case 'disable': {
      const user = findUser(rest[0]);
      users.setDisabled(user.id, true);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      console.log(`Disabled "${user.username}" and signed them out everywhere. Their request history is kept.`);
      break;
    }
    case 'enable': {
      const user = findUser(rest[0]);
      users.setDisabled(user.id, false);
      console.log(`Enabled "${user.username}".`);
      break;
    }
    default:
      console.log(`Usage: npm run users -- <command>

Commands:
  add [--username U --role mom|runner --name "Display name"]
  list
  passwd <username>
  rename <username> <display name>
  disable <username>
  enable <username>`);
      if (command) process.exitCode = 1;
  }
}

await main();
db.close();
