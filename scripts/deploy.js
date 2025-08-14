#!/usr/bin/env node
// Interactive deployment helper for Octomailer
// - Lets you choose worker name and mode (github/discord)
// - Collects and stores secrets via `wrangler secret put`
// - Runs `wrangler deploy --name <name>`

const { spawn } = require('child_process');
const readline = require('readline');

function color(code) {
  return (s) => `\u001b[${code}m${s}\u001b[0m`;
}
const cyan = color('36');
const green = color('32');
const yellow = color('33');
const red = color('31');
const bold = color('1');

function rl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(q, { mask = false, defaultValue = '' } = {}) {
  return new Promise((resolve) => {
    const r = rl();
    if (!mask) {
      r.question(q, (ans) => {
        r.close();
        resolve(ans || defaultValue);
      });
    } else {
      process.stdout.write(q);
      let input = '';
      const onData = (char) => {
        char = char + '';
        switch (char) {
          case '\n':
          case '\r':
          case '\u0004':
            process.stdout.write('\n');
            process.stdin.removeListener('data', onData);
            r.close();
            resolve(input || defaultValue);
            break;
          case '\u0003': // Ctrl+C
            process.stdout.write('\n');
            process.exit(1);
            break;
          default:
            process.stdout.write('*');
            input += char;
            break;
        }
      };
      process.stdin.on('data', onData);
    }
  });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--name' || a === '-n') out.name = args[++i];
    else if (a.startsWith('--name=')) out.name = a.split('=')[1];
    else if (!out.name && !a.startsWith('-')) out.name = a;
    else if (a === '--type' || a === '-t') out.type = args[++i];
    else if (a.startsWith('--type=')) out.type = a.split('=')[1];
  }
  return out;
}

function run(cmd, args, { input, inheritStdio = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: inheritStdio ? 'inherit' : 'pipe' });
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
    let out = '';
    let err = '';
    if (!inheritStdio) {
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (err += d.toString()));
    }
    child.on('close', (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} ${args.join(' ')} failed with code ${code}\n${err}`));
    });
  });
}

async function putSecret(workerName, key, value) {
  process.stdout.write(yellow(`• Setting secret ${key}...\n`));
  // Provide the value via stdin to avoid echoing it in shell history
  await run('wrangler', ['secret', 'put', key, '--name', workerName], { input: `${value}\n` });
  process.stdout.write(green(`  ✓ ${key} set\n`));
}

function ghPatLink() {
  const desc = encodeURIComponent('Octomailer Worker');
  const scopes = encodeURIComponent('repo');
  return `https://github.com/settings/tokens/new?scopes=${scopes}&description=${desc}`;
}

async function main() {
  console.log(bold(cyan('Octomailer Deploy Wizard')));
  console.log('This will set secrets and deploy with Wrangler.');

  const args = parseArgs();
  let name = args.name || (await ask('Worker name (e.g., octomailer-prod): '));
  while (!name) name = await ask('Please provide a worker name: ');

  let type = (args.type || (await ask('Mode [github|discord] (default: github): ')) || 'github').toLowerCase();
  if (!['github', 'discord'].includes(type)) type = 'github';

  console.log(yellow(`\nWorker: ${name}`));
  console.log(yellow(`Mode:   ${type}\n`));

  if (type === 'github') {
    console.log('We need your GitHub repo info and a token with repo scope.');
    console.log(`Create a token here: ${cyan(ghPatLink())}`);

    const ghUser = await ask('GitHub username/owner: ');
    const ghRepo = await ask('GitHub repository (name only): ');
    const ghToken = await ask('GitHub Personal Access Token: ', { mask: true });

    console.log('\nSummary:');
    console.log(`  Name: ${name}`);
    console.log(`  Type: github`);
    console.log(`  Repo: ${ghUser}/${ghRepo}`);
    const confirm = (await ask('Proceed? [y/N]: ')).toLowerCase().startsWith('y');
    if (!confirm) {
      console.log(red('Aborted.'));
      process.exit(1);
    }

    await putSecret(name, 'TYPE', 'github');
    await putSecret(name, 'GITHUB_USERNAME', ghUser);
    await putSecret(name, 'GITHUB_REPO', ghRepo);
    await putSecret(name, 'GITHUB_TOKEN', ghToken);

  } else {
    console.log('For Discord mode, create a webhook in your server channel settings.');
    console.log('Docs: Server Settings → Integrations → Webhooks → New Webhook');

    const webhook = await ask('Discord Webhook URL: ');
    const roleId = await ask('Optional: Role ID to mention (enter to skip): ');

    console.log('\nSummary:');
    console.log(`  Name: ${name}`);
    console.log(`  Type: discord`);
    console.log(`  Webhook: ${webhook ? '[provided]' : '[missing]'}`);
    console.log(`  Role ID: ${roleId || '[none]'}`);
    const confirm = (await ask('Proceed? [y/N]: ')).toLowerCase().startsWith('y');
    if (!confirm) {
      console.log(red('Aborted.'));
      process.exit(1);
    }

    await putSecret(name, 'TYPE', 'discord');
    await putSecret(name, 'DISCORD_WEBHOOK_URL', webhook);
    if (roleId) await putSecret(name, 'DISCORD_MENTION_ROLE_ID', roleId);
  }

  console.log('\nDeploying with Wrangler...');
  await run('wrangler', ['deploy', '--name', name], { inheritStdio: true });
  console.log(green('\n✓ Deployment complete.'));
}

main().catch((err) => {
  console.error(red(`Error: ${err.message}`));
  process.exit(1);
});

