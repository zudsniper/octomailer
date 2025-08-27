#!/usr/bin/env node
// Interactive deployment helper for Octomailer
// - Lets you choose worker name and mode (github/discord)
// - Collects and stores secrets via `wrangler secret put`
// - Runs `wrangler deploy --name <name>`

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
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
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--ci' || a === '--non-interactive') out.ci = true;
    else if (a === '--name' || a === '-n') out.name = args[++i];
    else if (a.startsWith('--name=')) out.name = a.split('=')[1];
    else if (!out.name && !a.startsWith('-')) out.name = a;
    else if (a === '--type' || a === '-t') out.type = args[++i];
    else if (a.startsWith('--type=')) out.type = a.split('=')[1];
    else if (a === '--gh-user') out.ghUser = args[++i];
    else if (a === '--gh-repo') out.ghRepo = args[++i];
    else if (a === '--gh-token') out.ghToken = args[++i];
    else if (a === '--webhook') out.webhook = args[++i];
    else if (a === '--role-id') out.roleId = args[++i];
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

async function wranglerWhoamiJson() {
  // Try a couple of likely flags across Wrangler versions
  const attempts = [
    ['whoami', '--format', 'json'],
    ['whoami', '--json'],
  ];
  for (const args of attempts) {
    try {
      const { out } = await run('wrangler', args);
      const trimmed = out.trim();
      if (!trimmed) continue;
      try {
        return JSON.parse(trimmed);
      } catch (_) {
        // Some versions print extra notes; try to extract the last JSON block
        const match = trimmed.match(/\{[\s\S]*\}$/);
        if (match) return JSON.parse(match[0]);
      }
    } catch (_) {
      // fall through and try next variant
    }
  }
  return null;
}

function readWranglerConfig() {
  // Prefer wrangler.jsonc in project root
  const jsoncPath = path.join(process.cwd(), 'wrangler.jsonc');
  try {
    const raw = fs.readFileSync(jsoncPath, 'utf8');
    // Our file doesn't include comments; parse directly
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function parseAccountsFromText(text) {
  const accounts = [];
  const lines = text.split(/\r?\n/);
  // Legacy/backticked format: `Account Name`: `<32hex>`
  const backtickRe = /`([^`]+)`:\s*`([0-9a-f]{32})`/i;
  // Modern table format from wrangler whoami output
  // Example: │ Some Account Name              │ 79fd0e2318d8a8bf384023e80c02d541 │
  const tableRe = /^\s*[│|]\s*(.*?)\s*[│|]\s*([0-9a-f]{32})\s*[│|]\s*$/i;
  for (const line of lines) {
    let m = line.match(backtickRe);
    if (m) {
      accounts.push({ name: m[1].trim(), id: m[2].toLowerCase() });
      continue;
    }
    m = line.match(tableRe);
    if (m) {
      const name = m[1].trim();
      // Skip header rows or separators accidentally matching
      if (/^account name$/i.test(name)) continue;
      accounts.push({ name, id: m[2].toLowerCase() });
    }
  }
  return accounts;
}

async function selectCloudflareAccount({ ci }) {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;

  // If account_id is set in wrangler.jsonc, honor it and also export env var
  const cfg = readWranglerConfig();
  if (cfg && typeof cfg.account_id === 'string' && /^[0-9a-f]{32}$/i.test(cfg.account_id)) {
    process.env.CLOUDFLARE_ACCOUNT_ID = cfg.account_id;
    console.log(green(`Using Cloudflare account from wrangler.jsonc: ${cfg.account_id}`));
    return cfg.account_id;
  }

  // First try JSON output
  let accounts = [];
  try {
    const json = await wranglerWhoamiJson();
    if (json && Array.isArray(json.accounts)) {
      accounts = json.accounts
        .filter((a) => a && a.id)
        .map((a) => ({ id: String(a.id), name: a.name || '' }));
    }
    // Some versions expose at json.user.accounts
    if (!accounts.length && json && json.user && Array.isArray(json.user.accounts)) {
      accounts = json.user.accounts
        .filter((a) => a && a.id)
        .map((a) => ({ id: String(a.id), name: a.name || '' }));
    }
  } catch (_) {
    // ignore
  }

  // If JSON failed, run a non-JSON whoami to collect textual hints
  if (!accounts.length) {
    try {
      const { out, err } = await run('wrangler', ['whoami']);
      accounts = parseAccountsFromText(out || err || '');
    } catch (e) {
      // If whoami fails entirely, just return and let Wrangler error later
      return undefined;
    }
  }

  if (!accounts.length) return undefined;
  if (accounts.length === 1) {
    const id = accounts[0].id;
    process.env.CLOUDFLARE_ACCOUNT_ID = id;
    console.log(green(`Using Cloudflare account: ${accounts[0].name || id}`));
    return id;
  }

  if (ci) {
    console.error(
      red(
        'More than one Cloudflare account detected. Set CLOUDFLARE_ACCOUNT_ID or add account_id to wrangler.jsonc.'
      )
    );
    console.error('Available accounts:');
    accounts.forEach((a) => console.error(`  ${a.name || '[unnamed]'}: ${a.id}`));
    process.exit(2);
  }

  console.log(yellow('Multiple Cloudflare accounts found:'));
  accounts.forEach((a, i) => console.log(`  [${i + 1}] ${a.name || '[unnamed]'}  (${a.id})`));
  let choice;
  while (true) {
    const ans = await ask('Choose an account by number, or paste an ID: ');
    const n = parseInt(ans, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= accounts.length) {
      choice = accounts[n - 1].id;
      break;
    }
    const idLike = ans.trim();
    if (/^[0-9a-f]{32}$/i.test(idLike)) {
      choice = idLike;
      break;
    }
    console.log(yellow('Invalid selection.'));
  }
  process.env.CLOUDFLARE_ACCOUNT_ID = choice;
  console.log(green(`Using Cloudflare account: ${choice}`));
  return choice;
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

function printHelp() {
  console.log(bold('Usage:') + ' node scripts/deploy.js [options]\n');
  console.log('Options:');
  console.log('  -n, --name <worker>        Worker name (required in CI)');
  console.log('  -t, --type <github|discord>  Deployment mode (default: github)');
  console.log('      --gh-user <user>       GitHub owner (CI)');
  console.log('      --gh-repo <repo>       GitHub repo name (CI)');
  console.log('      --gh-token <token>     GitHub PAT with repo scope (CI)');
  console.log('      --webhook <url>        Discord webhook URL (CI)');
  console.log('      --role-id <id>         Optional Discord role ID (CI)');
  console.log('      --ci, --non-interactive  Fail on missing inputs; no prompts');
  console.log('  -h, --help                 Show this help\n');
  console.log('Notes: In interactive mode, detects multiple Cloudflare accounts via');
  console.log("       'wrangler whoami' and lets you choose one, exporting");
  console.log("       CLOUDFLARE_ACCOUNT_ID for this session. In CI, set");
  console.log("       CLOUDFLARE_ACCOUNT_ID or add 'account_id' to wrangler.jsonc.\n");
  console.log('Env (CI): WORKER_NAME, TYPE, GITHUB_USERNAME, GITHUB_REPO, GITHUB_TOKEN,');
  console.log('          DISCORD_WEBHOOK_URL or WEBHOOK_URL, DISCORD_MENTION_ROLE_ID');
  console.log('\nExamples:');
  console.log('  node scripts/deploy.js -n my-worker -t github --gh-user me --gh-repo proj --gh-token $TOKEN');
  console.log('  node scripts/deploy.js -n my-worker -t discord --webhook $WEBHOOK_URL --role-id 123 --ci');
}

async function main() {
  console.log(bold(cyan('Octomailer Deploy Wizard')));
  console.log('This will set secrets and deploy with Wrangler.');

  const args = parseArgs();
  if (args.help) {
    printHelp();
    return;
  }

  const ci = !!args.ci;
  // Ensure a deterministic Cloudflare account selection to avoid Wrangler errors
  await selectCloudflareAccount({ ci });

  let name = args.name || process.env.WORKER_NAME;
  if (!name && !ci) name = await ask('Worker name (e.g., octomailer-prod): ');
  if (!name) {
    console.error(red('Error: missing worker name. Provide --name or WORKER_NAME.'));
    process.exit(2);
  }

  let type = (args.type || process.env.TYPE || (!ci && (await ask('Mode [github|discord] (default: github): '))) || 'github').toLowerCase();
  if (!['github', 'discord'].includes(type)) type = 'github';

  console.log(yellow(`\nWorker: ${name}`));
  console.log(yellow(`Mode:   ${type}\n`));

  if (type === 'github') {
    console.log('We need your GitHub repo info and a token with repo scope.');
    console.log(`Create a token here: ${cyan(ghPatLink())}`);

    let ghUser = args.ghUser || process.env.GITHUB_USERNAME;
    let ghRepo = args.ghRepo || process.env.GITHUB_REPO;
    let ghToken = args.ghToken || process.env.GITHUB_TOKEN;
    if (!ci && !ghUser) ghUser = await ask('GitHub username/owner: ');
    if (!ci && !ghRepo) ghRepo = await ask('GitHub repository (name only): ');
    if (!ci && !ghToken) ghToken = await ask('GitHub Personal Access Token: ', { mask: true });
    const missing = [];
    if (!ghUser) missing.push('GITHUB_USERNAME');
    if (!ghRepo) missing.push('GITHUB_REPO');
    if (!ghToken) missing.push('GITHUB_TOKEN');
    if (missing.length) {
      console.error(red(`Error: missing required GitHub values: ${missing.join(', ')}`));
      process.exit(2);
    }

    console.log('\nSummary:');
    console.log(`  Name: ${name}`);
    console.log(`  Type: github`);
    console.log(`  Repo: ${ghUser}/${ghRepo}`);
    if (!ci) {
      const confirm = (await ask('Proceed? [y/N]: ')).toLowerCase().startsWith('y');
      if (!confirm) {
        console.log(red('Aborted.'));
        process.exit(1);
      }
    }

    await putSecret(name, 'TYPE', 'github');
    await putSecret(name, 'GITHUB_USERNAME', ghUser);
    await putSecret(name, 'GITHUB_REPO', ghRepo);
    await putSecret(name, 'GITHUB_TOKEN', ghToken);

  } else {
    console.log('For Discord mode, create a webhook in your server channel settings.');
    console.log('Docs: Server Settings → Integrations → Webhooks → New Webhook');

    let webhook = args.webhook || process.env.DISCORD_WEBHOOK_URL || process.env.WEBHOOK_URL;
    let roleId = args.roleId || process.env.DISCORD_MENTION_ROLE_ID || '';
    if (!ci && !webhook) webhook = await ask('Discord Webhook URL: ');
    if (!ci && !roleId) roleId = await ask('Optional: Role ID to mention (enter to skip): ');
    if (!webhook) {
      console.error(red('Error: missing webhook URL (DISCORD_WEBHOOK_URL or WEBHOOK_URL).'));
      process.exit(2);
    }

    console.log('\nSummary:');
    console.log(`  Name: ${name}`);
    console.log(`  Type: discord`);
    console.log(`  Webhook: ${webhook ? '[provided]' : '[missing]'}`);
    console.log(`  Role ID: ${roleId || '[none]'}`);
    if (!ci) {
      const confirm = (await ask('Proceed? [y/N]: ')).toLowerCase().startsWith('y');
      if (!confirm) {
        console.log(red('Aborted.'));
        process.exit(1);
      }
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
