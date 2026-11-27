# The app on testnet

This runbook opens the app in your own browser against Sepolia and the public Aztec testnet, on the
own pool's deployment. Everything runs on one host. Your laptop reaches it through one forwarded port.

Nothing here needs a key. The build reads only the deployment file, which holds public addresses and
URLs.

## What you need

- **On the host:** this repository with `bun install` done. Fetch the pool checkout with
  `bun run --cwd packages/pp-env fetch`. The browser check (step 3) needs Playwright's Chromium:
  `apps/web/node_modules/.bin/playwright install chromium` (add `--with-deps` once on a fresh
  machine; it installs system packages and needs root).
- **The deployment file:** the own pool's testnet deployment file, with its `pool` and `bridge`
  sections. Use it only if `verify-deployment` passed on it before the factory was opened with `open`.
- **The testnet services:** the deployment's operator runs `bot` and `asp --owner <canary owner>` on
  the host.
- **Not in this repository yet:** the deployment file and the commands named here (`verify-deployment`,
  `open`, `bot`, `asp --owner`, `seed`); see `packages/testnet/README.md`. Until they land, step 3's
  checks run on the fixture file `apps/web/src/build/fixtures/testnet-own.json` in place of
  `$DEPLOYMENT` (the smoke with `--no-upstreams`).
- **On your laptop:** Chrome with two extensions.
  - **MetaMask** on Sepolia, with two accounts:
    - the **owner**, who holds the pool note;
    - a **sender**, funded with Sepolia ETH, which pays for the bridge.
    The bridge refuses the owner as the sender: that would link the owner to the bridge.
  - **Nulo** v1.3.0, switched to its built-in **Testnet** network (Settings → Networks → Switch).

## Start the app on the host

Run every command from the repository's root. `bun run --cwd apps/web` runs in `apps/web`, so every
file path it is given is absolute.

1. Point `DEPLOYMENT` at the deployment file by its absolute path, and `PP_CIRCUITS_DIR` at the
   fetched pool checkout's circuit builds:

   ```sh
   export DEPLOYMENT=<absolute path of the deployment file>
   export PP_CIRCUITS_DIR=$(bun -e 'import { checkout } from "./packages/pp-env/src/env/checkout.ts"; console.log(checkout().circuits)')
   ```

2. Build the app. Stop `serve` first if it runs: it holds the headers it loaded at start.

   ```sh
   PP_DEPLOYMENT="$DEPLOYMENT" \
     bun run --cwd apps/web build --mode testnet --outDir dist-testnet
   ```

3. Check the build (20 s). The first command checks the server against fake services, the proving
   files and the build's receipt. The second opens the build in a headless Chromium against the
   real services, on a port of its own.

   ```sh
   bun run --cwd apps/web test:headers -- --target "$DEPLOYMENT"
   bun run --cwd apps/web test:testnet-smoke -- --target "$DEPLOYMENT"
   ```

   Each ends with a `passed` line. In the smoke, a `502` on a `GET /bot/…` or `GET /asp/…` line means
   that service gave no usable answer, and the error ends with `serve`'s log, which names why. A `404`
   on `GET /bot/v1/snapshots/latest` means the bot holds no snapshot for the registry's current
   record, before its first post or after the record changed: wait for its next post.

4. Start the server on port 28600:

   ```sh
   bun run --cwd apps/web serve -- --outDir dist-testnet \
     --deployment "$DEPLOYMENT" --host 127.0.0.1 --port 28600 --claim
   ```

   It claims port 28600 in `~/.agents/ports.md` and prints the run id it claimed it under. It refuses
   to start when:
   - the build is not the one for this file (rebuild);
   - the port is claimed or bound (pick another number, the same at both ends of the forward);
   - `PP_CIRCUITS_DIR` is not an absolute directory.

5. Check the two services through the app's own server:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: localhost:28600' http://127.0.0.1:28600/bot/v1/snapshots/latest
   curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: localhost:28600' \
     'http://127.0.0.1:28600/asp/association-set/root?chainId=11155111&entrypoint=<pool.entrypoint>'
   ```

   `<pool.entrypoint>` is that value in the deployment file. Both must print `200`. A `502` means
   that service gave no usable answer: it is down, or `serve`'s log names what it sent instead.

## Open it on your laptop

1. Forward the port. Leave this running:

   ```sh
   ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:28600:127.0.0.1:28600 <host>
   ```

2. Open `http://localhost:28600` in Chrome. Always use this exact address. Your wallets' permissions
   and the page's saved bridge progress belong to it. Another port or `127.0.0.1` is a new site to both.
3. In MetaMask, select the owner account, then press **Sign in with Ethereum** on the page. MetaMask
   asks to connect this site, then to sign.
4. Connect Nulo from the page, and check that the codes match.

## Get a test balance

A balance needs two things:
- **The owner registered in the pool's keystore.** After sign-in, an unregistered owner sees
  **Register with the pool** on Balances, in place of its pool notes. **Register** sends two
  Sepolia transactions from the owner, paid in its ETH, one MetaMask prompt each: the key that
  authorises its spends, then the key senders encrypt its notes to. The notes show once both have
  mined.
- **A pool note deposited for the owner.** If your owner account is the canary owner, the canary
  deposit (`seed`, without `--recipient`) is that note. For any other owner, once it is registered,
  the deployment's operator runs `seed --recipient <owner address>`; `--recipient` refuses the
  canary owner. The mock ASP then approves the note.

## When something fails

| You see | It means | Do this |
|---|---|---|
| The page does not load | The forward is down, or `serve` stopped | Restart the `ssh` line; check `serve` on the host |
| "Connect your Ethereum wallet first." | MetaMask has shared no account with this site | Press **Sign in with Ethereum** and approve MetaMask's request ("Open it on your laptop", step 3) |
| "Your Ethereum wallet is on another network. …" | MetaMask is not on Sepolia | Switch MetaMask to Sepolia |
| "Switch your Ethereum wallet to a separate account: …" | The owner is selected to pay for a bridge | Select the sender account in MetaMask |
| "Select your signed-in account in your Ethereum wallet: the keystore registers …" | Another account is selected while registering | Select the owner account in MetaMask, then press **Register** |
| "The pool's keystore holds other keys for this account, …" | The owner registered with another app's keys | Sign in with an owner this app registered, or a fresh one |
| "Allow list #… being reset: wait for its next post" | The registry's poster was replaced, which clears the list until the new poster posts | Wait for the next post, then press Refresh; leaving to Ethereum still works |
| "The Aztec node does not answer. …" | The public testnet node is unreachable | Wait, then try again |
| "The Aztec node serves L1 chain …; this app is built for …" | The node is on another network or rollup | Report it: the deployment file is out of date |
| "That wallet is no longer available. Search again." | Nulo is closed or locked | Open Nulo, unlock it, search again |
| "A network request failed. Try again." | A request to the node, Sepolia or the services failed | Run the two `curl` checks ("Start the app on the host", step 5); a `502` names the service, and `serve`'s log says why. The public node and RPC also rate-limit: wait a minute |
| The prover stops with an error | `serve` could not verify the proving files (it logs `proving files unavailable`) | Check `PP_CIRCUITS_DIR`, and run `fetch` again |

## Stopping

Stop `serve` with Ctrl-C. It releases its port claim. After a hard kill the claim stays. Once you
are sure the process is dead (`kill -0 <pid>` fails), release it by the run id `serve` printed:

```sh
cd apps/web && bun -e 'import { releaseRows } from "@pp/run-isolation/ports"; console.log(await releaseRows(process.argv[1]))' <run id>
```

It prints `true` once the rows owned by that run id are gone, and touches no other row.
