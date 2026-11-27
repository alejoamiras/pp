# The app on testnet

This runbook opens the app in your own browser against Sepolia and the public Aztec testnet, on the
own pool's deployment. Everything runs on one host. Your laptop reaches it through one forwarded port.

Nothing here needs a key. The build reads only the deployment file, which holds public addresses and
URLs.

## What you need

- **On the host:** this repository with `bun install` done. Fetch the pool checkout with
  `bun run --cwd packages/pp-env fetch`.
- **The deployment file:** `packages/testnet/deployments/testnet-own.json`, with its `pool` and
  `bridge` sections. Use it only after `verify-deployment` passed on it before `open`.
- **The testnet services:** the testnet lane runs `bot` and `asp --owner <canary owner>` on the host
  (see `packages/testnet/README.md`), and opens the factory with `open`.
- **On your laptop:** Chrome with two extensions.
  - **MetaMask** on Sepolia, with two accounts:
    - the **owner**, who holds the pool note;
    - a **sender**, funded with Sepolia ETH, which pays for the bridge.
    The bridge refuses the owner as the sender: that would link the owner to the bridge.
  - **Nulo** v1.3.0, switched to its built-in **Testnet** network (Settings → Networks → Switch).

## Start the app on the host

1. Build the app. Stop `serve` first if it runs: it holds the headers it loaded at start.

   ```sh
   PP_DEPLOYMENT=packages/testnet/deployments/testnet-own.json \
     bun run --cwd apps/web build --mode testnet --outDir dist-testnet
   ```

2. Start the server on port 28600. Set `PP_CIRCUITS_DIR` to the fetched pool checkout's circuit
   builds (`packages/pp-env/.ppv2`, then the circuits directory `packages/pp-env/src/env/pins.ts`
   names).

   ```sh
   PP_CIRCUITS_DIR=<absolute circuits directory> bun run --cwd apps/web serve -- \
     --outDir dist-testnet --deployment packages/testnet/deployments/testnet-own.json \
     --host 127.0.0.1 --port 28600 --claim
   ```

   It claims port 28600 in `~/.agents/ports.md` and prints the run id it claimed it under. It refuses
   to start when:
   - the build is not the one for this file (rebuild);
   - the port is claimed or bound (pick another number, the same at both ends of the forward);
   - `PP_CIRCUITS_DIR` is not an absolute directory.

3. Check the two services through the app's own server:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: localhost:28600' http://127.0.0.1:28600/bot/v1/snapshots/latest
   curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: localhost:28600' \
     'http://127.0.0.1:28600/asp/association-set/root?chainId=11155111&entrypoint=<pool.entrypoint>'
   ```

   Both must print `200`. A `502` means that service is down on the host.

## Open it on your laptop

1. Forward the port. Leave this running:

   ```sh
   ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:28600:127.0.0.1:28600 <host>
   ```

2. Open `http://localhost:28600` in Chrome. Always use this exact address. Your wallets' permissions
   and the page's saved bridge progress belong to it. Another port or `127.0.0.1` is a new site to both.
3. In MetaMask, connect this site by hand (the account menu → connect). Select the owner account.
4. Connect Nulo from the page, and check that the codes match.

## Get a test balance

A balance needs two things:
- **The owner registered in the pool's keystore.** Registration in this app arrives with web's arc 2e.
- **A pool note deposited for the owner.** Ask the testnet lane to run
  `seed --recipient <owner address>`. The mock ASP then approves it.

## When something fails

| You see | It means | Do this |
|---|---|---|
| The page does not load | The forward is down, or `serve` stopped | Restart the `ssh` line; check `serve` on the host |
| "Connect your Ethereum wallet first." | MetaMask has not connected this site | Connect the site in MetaMask (step 3) |
| "Your Ethereum wallet is on another network. …" | MetaMask is not on Sepolia | Switch MetaMask to Sepolia |
| "Switch your Ethereum wallet to a separate account: …" | The owner is selected to pay for a bridge | Select the sender account in MetaMask |
| "The Aztec node does not answer. …" | The public testnet node is unreachable | Wait, then try again |
| "The Aztec node serves L1 chain …; this app is built for …" | The node is on another network or rollup | Report it: the deployment file is out of date |
| "That wallet is no longer available. Search again." | Nulo is closed or locked | Open Nulo, unlock it, search again |
| "A network request failed. Try again." | A request to the node, Sepolia or the services failed | Run the two `curl` checks on the host; a `502` names the service that is down |
| The prover stops with an error | `serve` could not verify the proving files (it logs `proving files unavailable`) | Check `PP_CIRCUITS_DIR`, and run `fetch` again |

## Stopping

Stop `serve` with Ctrl-C. It releases its port claim. After a hard kill the claim stays. Once you
are sure the process is dead (`kill -0 <pid>` fails), release it by the run id `serve` printed:

```sh
cd apps/web && bun -e 'import { releaseRows } from "@pp/run-isolation/ports"; console.log(await releaseRows(process.argv[1]))' <run id>
```

It prints `true` once the rows owned by that run id are gone, and touches no other row.
