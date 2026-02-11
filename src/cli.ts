#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import qrcode from 'qrcode-terminal';
import { readFileSync } from 'fs';
import { AgentdexClient } from './client.js';
import { parseSecretKey, getNpub, getPubkeyHex, createProfileEvent, createKind0Event, publishToRelays, createNote } from './nostr.js';
import { payInvoice } from './nwc.js';

const program = new Command();

program
  .name('agentdex')
  .description('CLI for the agentdex AI agent directory')
  .version('0.2.0');

/**
 * Resolve secret key from flags, env, or key file
 */
function resolveKey(options: { nsec?: string; keyFile?: string }): Uint8Array {
  const raw = options.nsec || process.env.NOSTR_NSEC;
  if (raw) return parseSecretKey(raw);

  if (options.keyFile) {
    const data = JSON.parse(readFileSync(options.keyFile, 'utf-8'));
    if (data.sk_hex) return parseSecretKey(data.sk_hex);
    if (data.nsec) return parseSecretKey(data.nsec);
    throw new Error('Key file must contain sk_hex or nsec');
  }

  throw new Error('No key provided. Use --nsec, --key-file, or set NOSTR_NSEC env var.');
}

// ==================== REGISTER ====================

program
  .command('register')
  .description('Register your agent on agentdex')
  .option('--nsec <nsec>', 'Nostr secret key (nsec or hex)')
  .option('--key-file <path>', 'Path to JSON key file')
  .option('--name <name>', 'Agent name')
  .option('--description <desc>', 'Agent description')
  .option('--capabilities <caps>', 'Comma-separated capabilities')
  .option('--framework <fw>', 'Framework (e.g., langchain, openclaw)')
  .option('--model <model>', 'Model (e.g., claude-3.5-sonnet)')
  .option('--website <url>', 'Website URL')
  .option('--lightning <addr>', 'Lightning address')
  .option('--owner-x <handle>', 'Owner X/Twitter handle (e.g., @username)')
  .option('--nwc <uri>', 'Nostr Wallet Connect URI for auto-pay')
  .option('--api-key <key>', 'Agentdex API key')
  .option('--relay <url>', 'Additional relay (repeatable)', (val: string, acc: string[]) => [...acc, val], [])
  .option('--json', 'Output JSON')
  .action(async (options) => {
    try {
      const sk = resolveKey(options);
      const npub = getNpub(sk);
      const pubHex = getPubkeyHex(sk);

      let name = options.name;
      let description = options.description;
      let capabilities = options.capabilities?.split(',').map((s: string) => s.trim());
      let framework = options.framework;

      // Interactive mode if name not provided
      if (!name) {
        const answers = await inquirer.prompt([
          { type: 'input', name: 'name', message: 'Agent name:', validate: (v: string) => v.length > 0 || 'Required' },
          { type: 'input', name: 'description', message: 'Description (optional):' },
          { type: 'input', name: 'capabilities', message: 'Capabilities (comma-separated):' },
          { type: 'input', name: 'framework', message: 'Framework (optional):' },
        ]);
        name = answers.name;
        description = answers.description || description;
        capabilities = answers.capabilities ? answers.capabilities.split(',').map((s: string) => s.trim()) : capabilities;
        framework = answers.framework || framework;
      }

      const spinner = ora('Signing event...').start();

      const event = createProfileEvent(sk, {
        name,
        description,
        capabilities,
        framework,
        model: options.model,
        website: options.website,
        lightning: options.lightning,
        ownerX: options.ownerX,
        status: 'active',
      });

      spinner.text = 'Registering on agentdex...';
      const client = new AgentdexClient({ apiKey: options.apiKey });

      try {
        const result = await client.register(event);

        // Payment required (402)
        if (result.status === 'awaiting_payment' && result.invoice) {
          spinner.stop();
          console.log('');
          console.log(chalk.hex('#D4A574')(`  💰 Registration fee: ${result.amount_sats?.toLocaleString()} sats`));
          console.log('');

          const nwcUri = options.nwc || process.env.NWC_URL;

          if (nwcUri) {
            const paySpinner = ora('Paying invoice via NWC...').start();
            try {
              await payInvoice(nwcUri, result.invoice);
              paySpinner.succeed('Invoice paid!');
            } catch (payErr) {
              paySpinner.fail(`NWC payment failed: ${(payErr as Error).message}`);
              console.log('');
              console.log(chalk.gray('  Pay manually:'));
              qrcode.generate(result.invoice, { small: true }, (qr: string) => { console.log(qr); });
              console.log(chalk.gray(`  bolt11: ${result.invoice}`));
              console.log('');
            }
          } else {
            qrcode.generate(result.invoice, { small: true }, (qr: string) => { console.log(qr); });
            console.log(chalk.gray(`  bolt11: ${result.invoice}`));
            console.log('');
          }

          // Poll for payment
          const pollSpinner = ora('Waiting for payment...').start();
          const startTime = Date.now();
          const timeout = 15 * 60 * 1000;

          while (Date.now() - startTime < timeout) {
            await new Promise((r) => setTimeout(r, 3000));
            const status = await client.registerStatus(result.payment_hash!);
            if (status.paid) {
              pollSpinner.succeed('Registered!');

              spinner.text = 'Publishing to Nostr relays...';
              const relays = ['wss://nos.lol', 'wss://relay.damus.io', ...options.relay];
              const published = await publishToRelays(event, relays);

              if (options.json) {
                console.log(JSON.stringify({ ...result, relays: published }, null, 2));
              } else {
                console.log('');
                console.log(chalk.hex('#D4A574')('  ✅ Registered on agentdex'));
                console.log(chalk.gray(`  npub: ${npub}`));
                console.log(chalk.gray(`  Name: ${name}`));
                console.log(chalk.gray(`  Published to: ${published.join(', ')}`));
                console.log('');
                console.log(chalk.gray(`  Run ${chalk.white('agentdex claim <name>')} to get ${chalk.hex('#D4A574')('<name>@agentdex.id')}`));
              }
              return;
            }
          }

          pollSpinner.fail('Payment timeout (15 min). Invoice expired.');
          process.exit(1);
          return;
        }

        // Free registration — no payment needed
        spinner.text = 'Publishing to Nostr relays...';
        const relays = ['wss://nos.lol', 'wss://relay.damus.io', ...options.relay];
        const published = await publishToRelays(event, relays);

        spinner.succeed('Registered!');

        if (options.json) {
          console.log(JSON.stringify({ ...result, relays: published }, null, 2));
        } else {
          console.log('');
          console.log(chalk.hex('#D4A574')('  ✅ Registered on agentdex (free tier)'));
          console.log(chalk.gray(`  npub: ${npub}`));
          console.log(chalk.gray(`  Name: ${name}`));
          console.log(chalk.gray(`  Published to: ${published.join(', ')}`));
          console.log('');
          console.log(chalk.gray(`  Run ${chalk.white('agentdex claim <name>')} to get ${chalk.hex('#D4A574')('<name>@agentdex.id')}`));
          console.log('');
          console.log(chalk.gray('  Next: Claim a NIP-05 name to get verified (first 100 free, then 5000 sats).'));
        }
      } catch (err) {
        const apiErr = err as any;
        if (apiErr.status === 503) {
          spinner.fail('Registration is currently disabled.');
        } else {
          spinner.fail(`Registration failed: ${(err as Error).message}`);
        }
        process.exit(1);
      }
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ==================== CLAIM ====================

program
  .command('claim <name>')
  .description('Claim a NIP-05 name (name@agentdex.id)')
  .option('--nsec <nsec>', 'Nostr secret key')
  .option('--key-file <path>', 'Path to JSON key file')
  .option('--nwc <uri>', 'Nostr Wallet Connect URI for auto-pay')
  .option('--api-key <key>', 'Agentdex API key')
  .option('--skip-kind0', 'Skip publishing kind 0 profile to relays')
  .option('--relay <url>', 'Additional relay', (val: string, acc: string[]) => [...acc, val], [])
  .option('--json', 'Output JSON')
  .action(async (name: string, options) => {
    try {
      const sk = resolveKey(options);
      const client = new AgentdexClient({ apiKey: options.apiKey });

      const spinner = ora(`Claiming ${name}@agentdex.id...`).start();

      // Sign a kind 31337 event for claim authentication
      const event = createProfileEvent(sk, {
        name,
        status: 'active',
      });

      const claim = await client.claim(name, event);

      // Free/successful claim
      if (claim.claimed) {
        spinner.succeed(`${chalk.hex('#D4A574')(`${claim.nip05}`)} is now active!`);

        // Auto-publish kind 0 to relays so Nostr clients verify the NIP-05
        if (!options.skipKind0) {
          const k0Spinner = ora('Publishing kind 0 profile to Nostr relays...').start();
          try {
            const kind0 = createKind0Event(sk, {
              name: claim.agent?.name || name,
              nip05: `${name}@agentdex.id`,
            });
            const relays = ['wss://nos.lol', 'wss://relay.damus.io', ...(options.relay || [])];
            const published = await publishToRelays(kind0, relays);
            k0Spinner.succeed(`Kind 0 published to ${published.join(', ')}`);
            console.log(chalk.gray('  NIP-05 will appear on njump/Damus/Primal once relays propagate (~30s)'));
          } catch {
            k0Spinner.warn('Kind 0 publish failed. Publish manually:');
            console.log(chalk.gray(`  kind 0 content: {"name":"...","nip05":"${name}@agentdex.id"}`));
          }
        } else {
          console.log('');
          console.log(chalk.yellow('  ⚠ Skipped kind 0 publish. For NIP-05 to show on Nostr clients:'));
          console.log(chalk.gray(`  Publish kind 0 with: "nip05": "${name}@agentdex.id"`));
        }

        if (options.json) {
          console.log(JSON.stringify(claim, null, 2));
        }
        return;
      }

      // Payment required (402)
      if (claim.status === 'awaiting_payment' && claim.invoice) {
        spinner.stop();
        console.log('');
        console.log(chalk.hex('#D4A574')(`  💰 Claim ${name}@agentdex.id for ${claim.amount_sats?.toLocaleString()} sats`));
        console.log('');

        const nwcUri = options.nwc || process.env.NWC_URL;

        if (nwcUri) {
          const paySpinner = ora('Paying invoice via NWC...').start();
          try {
            await payInvoice(nwcUri, claim.invoice);
            paySpinner.succeed('Invoice paid!');
          } catch (payErr) {
            paySpinner.fail(`NWC payment failed: ${(payErr as Error).message}`);
            console.log('');
            console.log(chalk.gray('  Pay manually:'));
            qrcode.generate(claim.invoice, { small: true }, (qr: string) => { console.log(qr); });
            console.log(chalk.gray(`  bolt11: ${claim.invoice}`));
            console.log('');
          }
        } else {
          qrcode.generate(claim.invoice, { small: true }, (qr: string) => { console.log(qr); });
          console.log(chalk.gray(`  bolt11: ${claim.invoice}`));
          console.log('');
        }

        // Poll for payment
        const pollSpinner = ora('Waiting for payment...').start();
        const startTime = Date.now();
        const timeout = 15 * 60 * 1000;

        while (Date.now() - startTime < timeout) {
          await new Promise((r) => setTimeout(r, 3000));
          const status = await client.claimStatus(claim.payment_hash!);
          if (status.paid) {
            pollSpinner.succeed(`${chalk.hex('#D4A574')(`${name}@agentdex.id`)} is now active!`);

            // Auto-publish kind 0 after payment
            if (!options.skipKind0) {
              const k0Spinner = ora('Publishing kind 0 profile to Nostr relays...').start();
              try {
                const kind0 = createKind0Event(sk, { name, nip05: `${name}@agentdex.id` });
                const relays = ['wss://nos.lol', 'wss://relay.damus.io', ...(options.relay || [])];
                await publishToRelays(kind0, relays);
                k0Spinner.succeed('Kind 0 published — NIP-05 active on all Nostr clients');
              } catch {
                k0Spinner.warn('Kind 0 publish failed — publish manually');
              }
            }
            return;
          }
        }

        pollSpinner.fail('Payment timeout (15 min). Invoice expired.');
        process.exit(1);
      }
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ==================== VERIFY ====================

program
  .command('verify <npub>')
  .description('Check if an agent is registered on agentdex')
  .option('--json', 'Output JSON')
  .action(async (npub: string, options) => {
    try {
      const client = new AgentdexClient();
      const spinner = ora('Verifying...').start();

      const result = await client.verify(npub);

      if (options.json) {
        spinner.stop();
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.registered) {
        spinner.succeed('Registered on agentdex');
        console.log(chalk.gray(`  Name: ${result.name}`));
        console.log(chalk.gray(`  Trust Score: ${result.trustScore}`));
        console.log(chalk.gray(`  Capabilities: ${result.capabilities.join(', ') || 'none'}`));
        console.log(chalk.gray(`  Nostr: ${result.hasNostr ? '✅' : '❌'}  Agentdex: ${result.hasAgentdex ? '✅' : '❌'}`));
      } else {
        spinner.warn('Not registered on agentdex');
      }
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ==================== SEARCH ====================

program
  .command('search [query]')
  .description('Search the agentdex directory')
  .option('--capability <cap>', 'Filter by capability')
  .option('--framework <fw>', 'Filter by framework')
  .option('--min-trust <score>', 'Minimum trust score')
  .option('--limit <n>', 'Max results', '10')
  .option('--json', 'Output JSON')
  .action(async (query: string | undefined, options) => {
    try {
      const client = new AgentdexClient();
      const spinner = ora('Searching...').start();

      const agents = await client.search({
        q: query,
        capability: options.capability,
        framework: options.framework,
        limit: parseInt(options.limit),
      }) as any[];

      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(agents, null, 2));
        return;
      }

      if (agents.length === 0) {
        console.log(chalk.gray('No agents found.'));
        return;
      }

      for (const agent of agents) {
        const trust = agent.trustScore ? chalk.hex('#D4A574')(`[${agent.trustScore}]`) : '';
        console.log(`${chalk.white(agent.name)} ${trust} ${chalk.gray(agent.npub?.substring(0, 20) + '...')}`);
        if (agent.description) console.log(chalk.gray(`  ${agent.description.substring(0, 80)}`));
        if (agent.capabilities?.length) console.log(chalk.gray(`  ${agent.capabilities.join(', ')}`));
        console.log('');
      }

      console.log(chalk.gray(`${agents.length} agents found`));
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ==================== WHOAMI ====================

program
  .command('whoami')
  .description('Show your agent profile')
  .option('--nsec <nsec>', 'Nostr secret key')
  .option('--key-file <path>', 'Path to JSON key file')
  .action(async (options) => {
    try {
      const sk = resolveKey(options);
      const npub = getNpub(sk);
      const client = new AgentdexClient();

      const spinner = ora('Looking up...').start();
      const result = await client.verify(npub);
      spinner.stop();

      if (result.registered) {
        console.log(chalk.hex('#D4A574')(`  ${result.name}`));
        console.log(chalk.gray(`  ${npub}`));
        console.log(chalk.gray(`  Trust: ${result.trustScore}`));
        console.log(chalk.gray(`  Nostr: ${result.hasNostr ? '✅' : '❌'}  Agentdex: ${result.hasAgentdex ? '✅' : '❌'}`));
        console.log(chalk.gray(`  Capabilities: ${result.capabilities.join(', ') || 'none'}`));
      } else {
        console.log(chalk.yellow('  Not registered on agentdex yet.'));
        console.log(chalk.gray(`  npub: ${npub}`));
        console.log(chalk.gray(`  Run: agentdex register`));
      }
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

// ==================== PUBLISH ====================

program
  .command('publish <message>')
  .description('Publish a note tagged #agentdex')
  .option('--nsec <nsec>', 'Nostr secret key')
  .option('--key-file <path>', 'Path to JSON key file')
  .option('--relay <url>', 'Additional relay', (val: string, acc: string[]) => [...acc, val], [])
  .action(async (message: string, options) => {
    try {
      const sk = resolveKey(options);
      const spinner = ora('Publishing...').start();

      const event = createNote(sk, message);
      const relays = ['wss://nos.lol', 'wss://relay.damus.io', ...options.relay];
      const published = await publishToRelays(event, relays);

      spinner.succeed('Published!');
      console.log(chalk.gray(`  Published to: ${published.join(', ')}`));
      console.log(chalk.gray(`  Event ID: ${(event as any).id}`));
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program.parse();
